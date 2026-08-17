// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 澄清续跑测试
//
// --------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'

const subscriptions = vi.hoisted(() => ({
  subscribeToRun: vi.fn(),
  sendRunSnapshot: vi.fn(),
}))

vi.mock('./subscriptions.js', () => subscriptions)

import type { RunTaskManager } from '../agent/runTaskManager.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { authorizeRunAttachments } from '../conversation/runAttachmentAuthorization.js'
import type { AnalysisRun, ContextReference, DecisionRequest } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import type { WsDependencies } from './dependencies.js'
import { respondDecision } from './decisionCommand.js'

const roots = new Set<string>()

afterEach(async () => {
  subscriptions.subscribeToRun.mockReset()
  subscriptions.sendRunSnapshot.mockReset()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('clarification continuation', () => {
  it('creates one continuation and returns it for an identical lost-response retry', async () => {
    const fixture = await createFixture()
    const launch = idempotentRunTasks()

    const first = await answer(fixture, launch.runTasks, '杭州主城区')
    const retry = await answer(fixture, launch.runTasks, '杭州主城区')

    expect(retry.id).toBe(first.id)
    expect(fixture.store.listRunsForThread(fixture.threadId)).toHaveLength(2)
    expect(launch.launchCount()).toBe(1)
    const decision = decisionFrom(fixture.store.getRun(fixture.sourceRunId))
    expect(decision.status).toBe('answered')
    expect(decision.payload).toMatchObject({
      answer: '杭州主城区',
      continuationRunId: first.id,
      continuationState: 'created',
    })
    expect(subscriptions.subscribeToRun).toHaveBeenCalledWith(
      expect.anything(),
      first.id,
      fixture.store,
      expect.anything(),
      expect.any(Map),
    )
  })

  it('rejects a conflicting retry without creating another continuation', async () => {
    const fixture = await createFixture()
    const launch = idempotentRunTasks()

    const first = await answer(fixture, launch.runTasks, '杭州主城区')
    await expect(answer(fixture, launch.runTasks, '余杭区'))
      .rejects.toThrow('已使用不同答案处理')

    const runIds = new Set(
      fixture.store.listRunsForThread(fixture.threadId).map(run => run.id),
    )
    expect(runIds).toEqual(new Set([fixture.sourceRunId, first.id]))
    expect(launch.launchCount()).toBe(1)
  })

  it('remains retryable when continuation creation fails after the decision is reserved', async () => {
    const fixture = await createFixture()
    const launch = idempotentRunTasks()
    const originalCreateRun = fixture.store.createRun.bind(fixture.store)
    const createRun = vi.spyOn(fixture.store, 'createRun')
    createRun.mockRejectedValueOnce(new Error('database temporarily unavailable'))
    createRun.mockImplementation((...args: Parameters<typeof originalCreateRun>) => originalCreateRun(...args))

    await expect(answer(fixture, launch.runTasks, '杭州主城区'))
      .rejects.toThrow('database temporarily unavailable')
    expect(decisionFrom(fixture.store.getRun(fixture.sourceRunId))).toMatchObject({
      status: 'preparing',
      payload: expect.objectContaining({ answer: '杭州主城区' }),
    })
    expect(fixture.store.listRunsForThread(fixture.threadId)).toHaveLength(1)

    const continuation = await answer(fixture, launch.runTasks, '杭州主城区')

    expect(fixture.store.listRunsForThread(fixture.threadId)).toHaveLength(2)
    expect(decisionFrom(fixture.store.getRun(fixture.sourceRunId))).toMatchObject({
      status: 'answered',
      payload: expect.objectContaining({ continuationRunId: continuation.id }),
    })
  })

  it('reauthorizes and preserves a map screenshot across a short clarification answer', async () => {
    const fixture = await createFixture({ withMapAttachment: true })
    const launch = idempotentRunTasks()

    const continuation = await answer(fixture, launch.runTasks, '是')
    const attachment = continuation.state.contextReferences.find(reference => (
      reference.kind === 'map_screenshot'
    ))

    expect(attachment).toMatchObject({
      sourceRunId: fixture.sourceRunId,
      metadata: expect.objectContaining({
        continuedFromRunId: fixture.sourceRunId,
        fileId: fixture.attachmentFileId,
        mapContext: expect.objectContaining({ crs: 'OGC:CRS84' }),
      }),
    })
    expect(continuation.state.contextReferences.filter(reference => (
      reference.referenceId === `attachment:${fixture.attachmentFileId}`
    ))).toHaveLength(1)
  })

  it('does not create a continuation when the original attachment was deleted', async () => {
    const fixture = await createFixture({ withMapAttachment: true })
    const launch = idempotentRunTasks()
    if (!fixture.attachmentFileId) throw new Error('测试缺少附件')
    await fixture.store.fileLifecycle.delete(fixture.attachmentFileId, fixture.threadId)

    await expect(answer(fixture, launch.runTasks, '是'))
      .rejects.toThrow('不属于当前线程或不是 ready 状态')
    expect(fixture.store.listRunsForThread(fixture.threadId)).toHaveLength(1)
    expect(launch.launchCount()).toBe(0)
  })
})

async function answer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runTasks: RunTaskManager,
  text: string,
): Promise<AnalysisRun> {
  return respondDecision(
    {
      runId: fixture.sourceRunId,
      decisionId: 'decision_clarify',
      text,
    },
    fixture.dependencies,
    runTasks,
    {} as WebSocket,
    new Map(),
    TEST_AUTH,
  )
}

async function createFixture(options: { withMapAttachment?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-clarification-continuation-'))
  roots.add(root)
  const store = createTestPersistenceFacade(root)
  await store.initialize()
  const session = await store.createSession({ workspaceId: 'workspace_1', userId: 'user_1' })
  const thread = await store.createThread(session.id, '澄清续跑')
  let contextReferences: ContextReference[] = []
  let attachmentFileId: string | null = null
  if (options.withMapAttachment) {
    const staged = await stageFile(root, 'map.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const file = await store.fileLifecycle.upload({
      file: staged,
      workspaceId: thread.workspaceId,
      sessionId: thread.sessionId,
      threadId: thread.id,
      createdByUserId: thread.createdByUserId,
    })
    attachmentFileId = file.id
    contextReferences = await authorizeRunAttachments(store.fileLifecycle, thread.id, [{
      fileId: file.id,
      name: file.name,
      mediaType: 'image/png',
      kind: 'map_screenshot',
      mapContext: validMapContext(),
    }])
  }
  const source = await store.createRun(session.id, '分析地图截图中的风险区', {
    threadId: thread.id,
    modelProvider: 'fake',
    modelName: 'fake-model',
    runtimeConfigSnapshot: defaultRuntimeConfig(),
    contextReferences,
  })
  await store.updateRunState(source.id, {
    decisions: [clarificationDecision()],
    clarification: {
      clarificationId: 'decision_clarify',
      kind: 'clarification',
      reason: '需要区域范围',
      question: '请确认分析区域',
      options: [],
      selectedOptionId: null,
      allowFreeText: true,
    },
  })
  await store.updateRunStatus(source.id, 'clarification_needed')

  const dependencies = {
    store,
    usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
    defaultRuntimeConfig: defaultRuntimeConfig(),
    events: {},
  } as unknown as WsDependencies
  return {
    root,
    store,
    dependencies,
    sourceRunId: source.id,
    threadId: thread.id,
    attachmentFileId,
  }
}

function idempotentRunTasks() {
  const active = new Set<string>()
  let launches = 0
  const startDetachedIfIdle = vi.fn((options: { runId: string }) => {
    if (active.has(options.runId)) return false
    active.add(options.runId)
    launches += 1
    return true
  })
  return {
    runTasks: {
      startDetachedIfIdle,
      respondToApproval: vi.fn(),
    } as unknown as RunTaskManager,
    launchCount: () => launches,
  }
}

function clarificationDecision(): DecisionRequest {
  return {
    decisionId: 'decision_clarify',
    kind: 'clarification',
    title: '需要澄清',
    question: '请确认分析区域',
    description: '',
    options: [],
    allowFreeText: true,
    status: 'pending',
    payload: {},
    createdAt: '2026-08-17T00:00:00.000Z',
    resolvedAt: null,
  }
}

function decisionFrom(run: AnalysisRun): DecisionRequest {
  const decision = run.state.decisions.find(candidate => candidate.decisionId === 'decision_clarify')
  if (!decision) throw new Error('澄清决策不存在')
  return decision
}

async function stageFile(root: string, name: string, content: Buffer) {
  const tempPath = path.join(root, 'staging', `${randomUUID()}.upload`)
  await mkdir(path.dirname(tempPath), { recursive: true })
  await writeFile(tempPath, content)
  return {
    name,
    tempPath,
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mediaType: 'image/png',
  }
}

function validMapContext() {
  return {
    capturedAt: '2026-08-17T00:00:00.000Z',
    viewport: {
      bounds: [119, 29, 121, 31] as [number, number, number, number],
      center: [120, 30] as [number, number],
      zoom: 8,
      bearing: 0,
      pitch: 20,
    },
    crs: 'OGC:CRS84' as const,
    renderProjection: 'EPSG:3857' as const,
    renderState: { status: 'idle' as const, tilesLoaded: true as const },
    renderedLayers: [],
    timeRange: null,
  }
}

const TEST_AUTH: AuthContext = {
  userId: 'user_1',
  subject: 'auth-user-1',
  email: 'user1@example.test',
  displayName: '测试用户',
  authSessionId: 'auth_session_1',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: 'csrf-test',
  defaultWorkspaceId: 'workspace_1',
  roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
}
