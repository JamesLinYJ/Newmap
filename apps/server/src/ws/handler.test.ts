// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 订阅回放集成测试
//
//   文件:       handler.test.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 补齐重连、关闭接入、传输错误与 Worker 工具失败的控制面集成回归。
// --------------------------------------------------------------------------

import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { drizzle } from 'drizzle-orm/node-postgres'
import { WebSocket, type RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import * as schema from '../db/schema.js'
import { ToolRegistry } from '../framework/registry.js'
import type { Env } from '../framework/env.js'
import type { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import { ModelAdapterRegistry, type ModelAdapter } from '../model/registry.js'
import type { ConversationItem, RunEvent } from '../schemas/types.js'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { ToolProvider } from '../framework/types.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import {
  createTestPersistenceFacade,
  testPlatformEventHub,
} from '../../test-support/persistenceFacadeHarness.js'
import { OpenAIAgentsRuntime } from '../agent/runtime.js'
import { testSandboxClientFactory } from '../../test-support/agentsSandboxClient.js'
import { RunTaskManager } from '../agent/runTaskManager.js'
import { UsageStatsService } from '../usage/usageStatsService.js'
import { createWsHandler as createWsHandlerBase } from './handler.js'
import type { WsDependencies } from './dependencies.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { ServiceAdmission } from '../app/serviceAdmission.js'
import { wsConnectionsActive } from '../observability/metrics.js'
import { StartRunService } from '../conversation/startRunService.js'
import { ToolResultCommitService } from '../tools/resultPersistence.js'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'

const TEST_ORIGIN = 'http://127.0.0.1:5173'
const TEST_CSRF = 'csrf_test'
const TEST_AUTH: AuthContext = {
  userId: 'user_test',
  subject: 'auth_user_test',
  email: 'tester@geo-agent-platform.local',
  displayName: '测试用户',
  authSessionId: 'session_test',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: TEST_CSRF,
  defaultWorkspaceId: 'workspace_test',
  roles: [{ workspaceId: 'workspace_test', role: 'platform_admin' }],
}

type TestWsDependencies = Omit<WsDependencies, 'admission' | 'env' | 'events' | 'runtime' | 'runTasks' | 'startRunService' | 'resultCommitService' | 'runtimeFiles' | 'fileLifecycle' | 'scheduledTaskService' | 'backgroundTasks' | 'usageStats'> & Partial<Pick<
  WsDependencies,
  'admission' | 'env' | 'events' | 'runtime' | 'runTasks' | 'startRunService' | 'runtimeFiles' | 'fileLifecycle' | 'scheduledTaskService' | 'backgroundTasks' | 'usageStats'
>>

async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function createWsHandler(server: Parameters<typeof createWsHandlerBase>[0], dependencies: TestWsDependencies) {
  const runtime = dependencies.runtime ?? new OpenAIAgentsRuntime(
    dependencies.store,
    dependencies.toolRegistry,
    dependencies.modelRegistry,
    {
      createSandboxClient: dependencies.createSandboxClient,
      authorizationLease: async auth => auth,
    },
  )
  const runTasks = dependencies.runTasks ?? new RunTaskManager(runtime, dependencies.store)
  const usageStats = dependencies.usageStats ?? new UsageStatsService(dependencies.store, dependencies.env ?? testEnv())
  const runtimeFiles = dependencies.runtimeFiles ?? new RuntimeFileStore(dependencies.runtimeRoot)
  const fileLifecycle: FileLifecyclePort = dependencies.fileLifecycle ?? dependencies.store.fileLifecycle
  return createWsHandlerBase(server, {
    ...dependencies,
    env: dependencies.env ?? testEnv(),
    events: dependencies.events ?? testPlatformEventHub(dependencies.store),
    admission: dependencies.admission ?? new ServiceAdmission(),
    runtimeFiles,
    fileLifecycle,
    runtime,
    runTasks,
    startRunService: dependencies.startRunService ?? new StartRunService({
      store: dependencies.store,
      usageStats,
      modelRegistry: dependencies.modelRegistry,
      runTasks,
      fileLifecycle,
    }),
    resultCommitService: dependencies.resultCommitService ?? new ToolResultCommitService(dependencies.store),
    scheduledTaskService: dependencies.scheduledTaskService ?? ({} as WsDependencies['scheduledTaskService']),
    backgroundTasks: dependencies.backgroundTasks ?? ({} as WsDependencies['backgroundTasks']),
    usageStats,
  })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('WebSocket run subscriptions', () => {
  it('returns workspace summaries and paged runs without per-thread requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-bootstrap-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    for (let index = 0; index < 4; index += 1) {
      const thread = await store.createThread(session.id, `线程 ${index + 1}`)
      await store.createRun(session.id, `查询 ${index + 1}`, { threadId: thread.id })
    }

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const bootstrap = payloadData(await request(ws, 'workspace:bootstrap', { sessionId: session.id }, 'bootstrap'))
    expect(isRecord(bootstrap) && isRecord(bootstrap.session) ? bootstrap.session.id : null).toBe(session.id)
    expect(isRecord(bootstrap) && Array.isArray(bootstrap.threads) ? bootstrap.threads : []).toHaveLength(4)
    expect(isRecord(bootstrap) && Array.isArray(bootstrap.tools) ? bootstrap.tools : null).toEqual([])
    const bootstrapThreads = isRecord(bootstrap) && Array.isArray(bootstrap.threads)
      ? bootstrap.threads
      : []
    const firstThread = bootstrapThreads[0]
    if (!isRecord(firstThread) || typeof firstThread.id !== 'string') {
      throw new Error('工作区引导未返回可用线程。')
    }
    const detail = payloadData(await request(ws, 'thread:get', { threadId: firstThread.id }, 'thread_detail'))
    expect(isRecord(detail) ? Object.keys(detail).sort() : []).toEqual(['manifest', 'thread'])
    expect(JSON.stringify(detail)).not.toContain('"state"')

    const first = payloadData(await request(ws, 'run:list', { sessionId: session.id, limit: 3 }, 'runs_1'))
    expect(isRecord(first) && Array.isArray(first.items) ? first.items : []).toHaveLength(3)
    const cursor = isRecord(first) && typeof first.nextCursor === 'string' ? first.nextCursor : null
    const second = payloadData(await request(ws, 'run:list', { sessionId: session.id, limit: 3, cursor }, 'runs_2'))
    expect(isRecord(second) && Array.isArray(second.items) ? second.items : []).toHaveLength(1)
    await close(ws)
  })

  it('requires an explicit authorized thread for file list commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-file-scope-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const ownSession = await store.createSession({
      workspaceId: TEST_AUTH.defaultWorkspaceId,
      userId: TEST_AUTH.userId,
    })
    const ownThread = await store.createThread(ownSession.id, '当前工作区')
    const otherSession = await store.createSession({
      workspaceId: 'workspace_other',
      userId: 'user_other',
    })
    const otherThread = await store.createThread(otherSession.id, '其它工作区')

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity('workspace_other'),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const missingScope = await request(ws, 'file:list', {}, 'file_missing_scope')
    expect(missingScope.ok).toBe(false)

    const denied = await request(ws, 'file:list', { threadId: otherThread.id }, 'file_other_workspace')
    expect(denied.ok).toBe(false)
    expect(isRecord(denied.error) ? denied.error.message : '').toContain('跨工作区')

    const ownFiles = payloadData(await request(ws, 'file:list', { threadId: ownThread.id }, 'file_own_workspace'))
    expect(ownFiles).toEqual({ files: [], total: 0 })
    await close(ws)
  })

  it('rejects upgrades and commands immediately after shutdown admission closes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-shutdown-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const admission = new ServiceAdmission()
    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
      admission,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    const url = `ws://127.0.0.1:${address.port}/ws`
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(url)
    admission.beginShutdown()
    const rejectedCommand = await request(ws, 'run:start', {}, 'run_after_shutdown')
    expect(rejectedCommand).toMatchObject({
      ok: false,
      error: {
        code: 'service_unavailable',
      },
    })
    await expect(rejectedUpgradeStatus(url)).resolves.toBe(503)
    await close(ws)
  })

  it('contains upgrade authentication and connected socket errors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-errors-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const security = testSecurity()
    let failAuthentication = true
    security.auth.authenticateHeaders = async () => {
      if (failAuthentication) {
        failAuthentication = false
        throw new Error('认证仓储暂时不可用')
      }
      return TEST_AUTH
    }
    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    const url = `ws://127.0.0.1:${address.port}/ws`
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    await expect(rejectedUpgradeStatus(url)).resolves.toBe(503)
    const baseline = gaugeValue(await wsConnectionsActive.get())
    const ws = await connect(url)
    expect(gaugeValue(await wsConnectionsActive.get())).toBe(baseline + 1)
    const serverSocket = [...wss.clients][0]
    if (!serverSocket) throw new Error('测试 WebSocket 服务端连接不存在')
    const clientClosed = new Promise<void>(resolve => ws.once('close', () => resolve()))
    serverSocket.emit('error', new Error('测试传输错误'))
    await clientClosed
    await waitFor(() => gaugeValuePromise(wsConnectionsActive.get()), baseline)
    expect(ws.readyState).toBe(WebSocket.CLOSED)

    wss.emit('error', new Error('测试 WebSocketServer 错误'))
    const subsequent = await connect(url)
    await close(subsequent)
  })

  it('replays a full snapshot after reconnect and resubscribe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '订阅测试')
    const run = await store.createRun(session.id, '测试', { threadId: thread.id })

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    const url = `ws://127.0.0.1:${address.port}/ws`
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const first = await connect(url)
    const firstSnapshot = await request(first, 'run:subscribe', { runId: run.id }, 'first')
    expect(snapshotRunId(firstSnapshot)).toBe(run.id)
    await close(first)

    await store.appendItem(conversationItem(run.id, thread.id))
    await store.appendEvent(run.id, runEvent(run.id, thread.id))
    await store.updateRunStatus(run.id, 'running')

    const second = await connect(url)
    const replay = await request(second, 'run:subscribe', { runId: run.id }, 'second')
    expect(snapshotRunId(replay)).toBe(run.id)
    expect(snapshotEntries(replay, 'items')).toHaveLength(1)
    expect(snapshotEntries(replay, 'events')).toHaveLength(1)
    expect(snapshotRunStatus(replay)).toBe('running')
    await close(second)
  })

  it('sends success and failure responses before terminal pushes that overtake snapshot reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-response-barrier-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '响应因果顺序')
    const run = await store.createRun(session.id, '测试响应与推送顺序', { threadId: thread.id })
    const staleItemSnapshot = await store.listItemSnapshot(run.id)
    const originalListItemSnapshot = store.listItemSnapshot.bind(store)
    const originalGetRun = store.getRun.bind(store)
    let releaseStaleSnapshot!: () => void
    const staleSnapshotBlocked = new Promise<void>(resolve => { releaseStaleSnapshot = resolve })
    let markStaleSnapshotStarted!: () => void
    const staleSnapshotStarted = new Promise<void>(resolve => { markStaleSnapshotStarted = resolve })
    let markTerminalSnapshotProjected!: () => void
    const terminalSnapshotProjected = new Promise<void>(resolve => { markTerminalSnapshotProjected = resolve })
    let itemSnapshotCalls = 0
    let terminalItemSnapshotReady = false
    store.listItemSnapshot = async requestedRunId => {
      itemSnapshotCalls += 1
      if (itemSnapshotCalls === 1) {
        markStaleSnapshotStarted()
        await staleSnapshotBlocked
        return staleItemSnapshot
      }
      const snapshot = await originalListItemSnapshot(requestedRunId)
      terminalItemSnapshotReady = true
      return snapshot
    }
    store.getRun = requestedRunId => {
      const current = originalGetRun(requestedRunId)
      if (terminalItemSnapshotReady) {
        terminalItemSnapshotReady = false
        markTerminalSnapshotProjected()
      }
      return current
    }

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const received: Array<Record<string, unknown>> = []
    ws.on('message', data => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) continue
        received.push(parsed)
      }
    })
    const waitForReceivedCount = (count: number) => new Promise<void>(resolve => {
      if (received.length >= count) {
        resolve()
        return
      }
      const handle = () => {
        if (received.length < count) return
        ws.off('message', handle)
        resolve()
      }
      ws.on('message', handle)
    })
    ws.send(JSON.stringify({
      type: 'run:subscribe',
      id: 'response_barrier',
      payload: { runId: run.id },
      meta: { csrfToken: TEST_CSRF },
    }) + '\n')

    await staleSnapshotStarted
    await store.updateRunStatus(run.id, 'completed')
    expect(itemSnapshotCalls).toBe(1)
    expect(received).toEqual([])

    const responseAndPushReceived = waitForReceivedCount(2)
    releaseStaleSnapshot()
    await terminalSnapshotProjected
    await responseAndPushReceived
    expect(received.map(message => ({ type: message.type, id: message.id }))).toEqual([
      { type: 'response', id: 'response_barrier' },
      { type: 'run.snapshot', id: null },
    ])

    store.listItemSnapshot = originalListItemSnapshot
    store.getRun = originalGetRun
    received.length = 0
    let releaseFailedSnapshot!: () => void
    const failedSnapshotBlocked = new Promise<void>(resolve => { releaseFailedSnapshot = resolve })
    let markFailedSnapshotStarted!: () => void
    const failedSnapshotStarted = new Promise<void>(resolve => { markFailedSnapshotStarted = resolve })
    let markRecoverySnapshotProjected!: () => void
    const recoverySnapshotProjected = new Promise<void>(resolve => { markRecoverySnapshotProjected = resolve })
    let failedItemSnapshotCalls = 0
    let recoveryItemSnapshotReady = false
    store.listItemSnapshot = async requestedRunId => {
      failedItemSnapshotCalls += 1
      if (failedItemSnapshotCalls === 1) {
        markFailedSnapshotStarted()
        await failedSnapshotBlocked
        throw new Error('快照仓储读取失败')
      }
      const snapshot = await originalListItemSnapshot(requestedRunId)
      recoveryItemSnapshotReady = true
      return snapshot
    }
    store.getRun = requestedRunId => {
      const current = originalGetRun(requestedRunId)
      if (recoveryItemSnapshotReady) {
        recoveryItemSnapshotReady = false
        markRecoverySnapshotProjected()
      }
      return current
    }
    ws.send(JSON.stringify({
      type: 'run:get',
      id: 'failure_barrier',
      payload: { runId: run.id },
      meta: { csrfToken: TEST_CSRF },
    }) + '\n')

    await failedSnapshotStarted
    testPlatformEventHub(store).runs.publish(run.id, originalGetRun(run.id))
    expect(failedItemSnapshotCalls).toBe(1)
    expect(received).toEqual([])

    const failureAndPushReceived = waitForReceivedCount(2)
    releaseFailedSnapshot()
    await recoverySnapshotProjected
    await failureAndPushReceived
    expect(received.map(message => ({
      type: message.type,
      id: message.id,
      ok: isRecord(message.payload) ? message.payload.ok : undefined,
    }))).toEqual([
      { type: 'response', id: 'failure_barrier', ok: false },
      { type: 'run.snapshot', id: null, ok: undefined },
    ])
    await close(ws)
  })

  it('keeps an older reserved snapshot push ahead of a newer completed get response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-reserved-fifo-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '预留槽 FIFO')
    const run = await store.createRun(session.id, '旧推送不得被新响应超车', { threadId: thread.id })
    await store.updateRunStatus(run.id, 'completed')
    const originalListItemSnapshot = store.listItemSnapshot.bind(store)
    const originalGetRun = store.getRun.bind(store)

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    await request(ws, 'run:subscribe', { runId: run.id }, 'establish_subscription')
    const baseSnapshot = await originalListItemSnapshot(run.id)
    const oldSnapshot = {
      ...baseSnapshot,
      itemStream: { ...baseSnapshot.itemStream, streamId: 'stream_old_reserved' },
    }
    const newSnapshot = {
      ...baseSnapshot,
      itemStream: { ...baseSnapshot.itemStream, streamId: 'stream_new_terminal' },
    }
    let releaseOldSnapshot!: () => void
    const oldSnapshotBlocked = new Promise<void>(resolve => { releaseOldSnapshot = resolve })
    let markOldSnapshotStarted!: () => void
    const oldSnapshotStarted = new Promise<void>(resolve => { markOldSnapshotStarted = resolve })
    let markNewSnapshotProjected!: () => void
    const newSnapshotProjected = new Promise<void>(resolve => { markNewSnapshotProjected = resolve })
    let snapshotCalls = 0
    let newSnapshotReady = false
    store.listItemSnapshot = async () => {
      snapshotCalls += 1
      if (snapshotCalls === 1) {
        markOldSnapshotStarted()
        await oldSnapshotBlocked
        return oldSnapshot
      }
      newSnapshotReady = true
      return newSnapshot
    }
    store.getRun = requestedRunId => {
      const current = originalGetRun(requestedRunId)
      if (newSnapshotReady) {
        newSnapshotReady = false
        markNewSnapshotProjected()
      }
      return current
    }

    const received: Array<Record<string, unknown>> = []
    ws.on('message', data => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const parsed: unknown = JSON.parse(line)
        if (isRecord(parsed)) received.push(parsed)
      }
    })
    const waitForReceivedCount = (count: number) => new Promise<void>(resolve => {
      const handle = () => {
        if (received.length < count) return
        ws.off('message', handle)
        resolve()
      }
      ws.on('message', handle)
    })

    testPlatformEventHub(store).runs.publish(run.id, originalGetRun(run.id))
    await oldSnapshotStarted
    const ledgerEvent = runEvent(run.id, thread.id)
    await store.appendEvent(run.id, ledgerEvent)
    ws.send(JSON.stringify({
      type: 'run:get',
      id: 'newer_get',
      payload: { runId: run.id },
      meta: { csrfToken: TEST_CSRF },
    }) + '\n')
    await Promise.resolve()
    expect(snapshotCalls).toBe(1)
    expect(received).toEqual([])

    const pushAndResponseReceived = waitForReceivedCount(3)
    releaseOldSnapshot()
    await newSnapshotProjected
    await pushAndResponseReceived
    expect(received.map(message => {
      const payload = isRecord(message.payload) ? message.payload : {}
      const data = isRecord(payload.data) ? payload.data : {}
      const itemStream = isRecord(data.itemStream) ? data.itemStream : {}
      const eventIds = Array.isArray(data.events)
        ? data.events.flatMap(event => isRecord(event) && typeof event.eventId === 'string' ? [event.eventId] : [])
        : []
      return { type: message.type, id: message.id, streamId: itemStream.streamId, eventIds }
    })).toEqual([
      { type: 'run.snapshot', id: null, streamId: 'stream_old_reserved', eventIds: [] },
      { type: 'run.event', id: null, streamId: undefined, eventIds: [] },
      { type: 'response', id: 'newer_get', streamId: 'stream_new_terminal', eventIds: [ledgerEvent.eventId] },
    ])

    let projectedEvents: RunEvent[] = []
    for (const message of received) {
      const payload = isRecord(message.payload) ? message.payload : {}
      const data = isRecord(payload.data) ? payload.data : {}
      if (message.type === 'run.event') {
        const event = data as unknown as RunEvent
        if (!projectedEvents.some(current => current.eventId === event.eventId)) projectedEvents.push(event)
      } else if (Array.isArray(data.events)) {
        projectedEvents = data.events.filter(isRecord) as unknown as RunEvent[]
      }
    }
    expect(projectedEvents.map(event => event.eventId)).toContain(ledgerEvent.eventId)

    store.listItemSnapshot = originalListItemSnapshot
    store.getRun = originalGetRun
    received.length = 0
    let releaseFirstGet!: () => void
    const firstGetBlocked = new Promise<void>(resolve => { releaseFirstGet = resolve })
    let markFirstGetStarted!: () => void
    const firstGetStarted = new Promise<void>(resolve => { markFirstGetStarted = resolve })
    let markSecondGetProjected!: () => void
    const secondGetProjected = new Promise<void>(resolve => { markSecondGetProjected = resolve })
    let getSnapshotCalls = 0
    let secondGetSnapshotReady = false
    store.listItemSnapshot = async () => {
      getSnapshotCalls += 1
      if (getSnapshotCalls === 1) {
        markFirstGetStarted()
        await firstGetBlocked
        return oldSnapshot
      }
      secondGetSnapshotReady = true
      return newSnapshot
    }
    store.getRun = requestedRunId => {
      const current = originalGetRun(requestedRunId)
      if (secondGetSnapshotReady) {
        secondGetSnapshotReady = false
        markSecondGetProjected()
      }
      return current
    }
    ws.send(JSON.stringify({
      type: 'run:get', id: 'first_concurrent_get', payload: { runId: run.id },
      meta: { csrfToken: TEST_CSRF },
    }) + '\n')
    await firstGetStarted
    ws.send(JSON.stringify({
      type: 'run:get', id: 'second_concurrent_get', payload: { runId: run.id },
      meta: { csrfToken: TEST_CSRF },
    }) + '\n')
    await Promise.resolve()
    expect(getSnapshotCalls).toBe(1)
    expect(received).toEqual([])

    const concurrentResponsesReceived = waitForReceivedCount(2)
    releaseFirstGet()
    await secondGetProjected
    await concurrentResponsesReceived
    expect(received.map(message => message.id)).toEqual([
      'first_concurrent_get',
      'second_concurrent_get',
    ])
    await close(ws)
  })

  it('responds to clarification decisions through the unified decision command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-decision-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '决策测试')
    const config = defaultRuntimeConfig()
    config.supervisor.approvalInterruptTools = []
    config.subAgents = []
    const run = await store.createRun(session.id, '目标平台是什么？', {
      threadId: thread.id,
      modelProvider: 'fake',
      runtimeConfigSnapshot: config,
    })
    await store.updateRunStatus(run.id, 'clarification_needed')
    await store.updateRunState(run.id, {
      clarification: {
        clarificationId: 'clarification_platform',
        kind: 'platform',
        reason: '缺少目标平台',
        question: '目标平台是什么？',
        options: [{
          optionId: 'browser',
          label: '浏览器 WebGL',
          description: '在浏览器中运行',
          kind: 'platform',
          reason: null,
          payload: {},
        }],
        selectedOptionId: null,
        allowFreeText: true,
      },
      decisions: [{
        decisionId: 'clarification_platform',
        kind: 'clarification',
        title: '需要补充信息',
        question: '目标平台是什么？',
        description: '缺少目标平台',
        options: [{
          optionId: 'browser',
          label: '浏览器 WebGL',
          description: '在浏览器中运行',
          kind: 'platform',
          reason: null,
          payload: {},
        }],
        allowFreeText: true,
        status: 'pending',
        payload: { clarificationId: 'clarification_platform' },
        createdAt: '2026-06-30T00:00:00.000Z',
        resolvedAt: null,
      }],
    })

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: registryWith(fakeAdapter(textModel('已收到补充。'))),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      createSandboxClient: testSandboxClientFactory,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const backgroundSnapshot = waitForBackgroundSnapshot(ws, run.id)
    const response = payloadData(await request(ws, 'run:respond-decision', {
      runId: run.id,
      decisionId: 'clarification_platform',
      optionId: 'browser',
    }, 'decision'))
    const nextRunId = isRecord(response) && typeof response.id === 'string' ? response.id : ''
    expect(nextRunId).toMatch(/^run_/u)
    expect(nextRunId).not.toBe(run.id)
    expect(isRecord(response) ? response.userQuery : null).toBe('浏览器 WebGL')

    const original = store.getRun(run.id)
    expect(original.state.clarification?.selectedOptionId).toBe('browser')
    expect(original.state.decisions[0]).toMatchObject({
      decisionId: 'clarification_platform',
      status: 'answered',
      resolvedAt: expect.any(String),
      payload: expect.objectContaining({ optionId: 'browser', answer: '浏览器 WebGL' }),
    })
    await waitForRunSettled(store, nextRunId)
    await backgroundSnapshot
    await store.flushConversationStore()
    await close(ws)
  })

  it('responds to approval decisions through the unified decision command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-approval-decision-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '审批决策测试')
    const config = defaultRuntimeConfig()
    config.supervisor.approvalInterruptTools = ['sensitive_tool']
    config.subAgents = []
    const run = await store.createRun(session.id, '执行敏感工具', {
      threadId: thread.id,
      modelProvider: 'fake',
      runtimeConfigSnapshot: config,
    })
    let executions = 0
    const tools = new ToolRegistry()
    tools.register(approvalToolProvider(() => { executions += 1 }))
    const models = registryWith(fakeAdapter(scriptedModel(request => hasToolResult(request)
      ? { text: '工具已执行。' }
      : { toolCalls: [{ id: 'call_sensitive', name: 'sensitive_tool', arguments: '{"value":1}' }] })))
    const waiting = await new OpenAIAgentsRuntime(store, tools, models, {
      createSandboxClient: testSandboxClientFactory,
    }).run({
      runId: run.id,
      threadId: thread.id,
      sessionId: run.sessionId,
      query: run.userQuery,
      provider: 'fake',
      runtimeConfig: config,
    })
    expect(waiting.status).toBe('waiting_approval')
    const decision = waiting.state.decisions.find(item => item.kind === 'approval' && item.status === 'pending')
    expect(decision?.decisionId).toBe(waiting.state.approvals[0].approvalId)
    if (!decision) throw new Error('测试未生成 pending approval decision')
    await store.flushConversationStore()

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: tools,
      modelRegistry: models,
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      createSandboxClient: testSandboxClientFactory,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const response = payloadData(await request(ws, 'run:respond-decision', {
      runId: run.id,
      decisionId: decision.decisionId,
      optionId: 'approve',
    }, 'approval_decision'))

    expect(isRecord(response) ? response.status : null).toBe('queued')
    await waitForRunSettled(store, run.id)
    expect(executions).toBe(1)
    const latest = store.getRun(run.id)
    expect(latest.state.approvals[0].payload.consumed).toBe(true)
    expect(latest.state.decisions).toContainEqual(expect.objectContaining({
      decisionId: decision.decisionId,
      kind: 'approval',
      status: 'approved',
      payload: expect.objectContaining({ approved: true, consumed: true }),
    }))
    await close(ws)
  })

  it('publishes direct tool:run calls as replayable tool output items with artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-tool-items-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '工具 mini app 回放')
    const registry = new ToolRegistry()
    registry.register(previewToolProvider())

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: registry,
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const executed = payloadData(await request(ws, 'tool:run', {
      sessionId: session.id,
      threadId: thread.id,
      toolName: 'render_rainfall_risk_map',
      args: { ok: true },
    }, 'tool_run'))
    const runId = isRecord(executed) && isRecord(executed.run) && typeof executed.run.id === 'string' ? executed.run.id : ''
    expect(runId).toMatch(/^run_/u)

    const replay = await request(ws, 'run:subscribe', { runId }, 'snapshot')
    const items = snapshotEntries(replay, 'items')
    const output = items.find(item => isRecord(item) && item.itemType === 'function_call_output')
    expect(output).toMatchObject({
      name: 'render_rainfall_risk_map',
      status: 'completed',
      metadata: {
        artifacts: [expect.objectContaining({
          artifactType: 'raster_png',
          name: '风险图预览',
          display: expect.objectContaining({ surfaces: ['mini_app', 'download'] }),
        })],
      },
    })
    await close(ws)
  })

  it('persists a Worker tool failure as a failed run and replays it after reconnect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-worker-failure-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, 'Worker 失败传播')
    const registry = new ToolRegistry()
    registry.register(failingWorkerToolProvider())

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: registry,
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    const url = `ws://127.0.0.1:${address.port}/ws`
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const first = await connect(url)
    const failed = await request(first, 'tool:run', {
      sessionId: session.id,
      threadId: thread.id,
      toolName: 'worker_failure_probe',
      args: {},
    }, 'worker_failure')
    expect(failed).toMatchObject({
      ok: false,
      error: {
        message: 'Python Worker 连接已中断',
      },
    })
    const failedRun = store.listRunsForThread(thread.id).at(-1)
    expect(failedRun).toMatchObject({
      status: 'failed',
      state: {
        failedTool: 'worker_failure_probe',
        errors: ['Python Worker 连接已中断'],
      },
    })
    await close(first)

    const second = await connect(url)
    const replay = await request(second, 'run:subscribe', { runId: failedRun?.id }, 'worker_failure_replay')
    expect(snapshotRunStatus(replay)).toBe('failed')
    await close(second)
  })

  it('serves thread history, context, memory, fork and trash commands with correlated envelopes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-thread-kernel-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '连续上下文契约')
    await store.appendTranscript({ threadId: thread.id, kind: 'message', payload: { role: 'user', content: '项目代号是西湖。' } })
    const answer = await store.appendTranscript({ threadId: thread.id, kind: 'message', payload: { role: 'assistant', content: '已记住。' } })

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const history = payloadData(await request(ws, 'thread:history', { threadId: thread.id }, 'history'))
    expect(isRecord(history) && Array.isArray(history.entries) ? history.entries : []).toHaveLength(2)
    const context = payloadData(await request(ws, 'thread:context', { threadId: thread.id }, 'context'))
    expect(isRecord(context) ? context.activeLeafEntryId : null).toBe(answer.entryId)

    const memory = payloadData(await request(ws, 'thread:memory:update', {
      threadId: thread.id,
      content: '## 用户固定记忆\n- 使用中文',
      expectedVersion: 0,
    }, 'memory'))
    expect(isRecord(memory) ? memory.version : null).toBe(1)

    const forked = payloadData(await request(ws, 'thread:fork', {
      threadId: thread.id,
      entryId: answer.entryId,
      title: '西湖分支',
    }, 'fork'))
    expect(isRecord(forked) ? forked.title : null).toBe('西湖分支')

    await request(ws, 'thread:delete', { threadId: thread.id }, 'delete')
    const trash = payloadData(await request(ws, 'thread:trash:list', { sessionId: session.id }, 'trash'))
    expect(Array.isArray(trash) ? trash : []).toHaveLength(1)
    const restored = payloadData(await request(ws, 'thread:trash:restore', { threadId: thread.id }, 'restore'))
    expect(isRecord(restored) ? restored.status : null).toBe('active')

    const failed = await request(ws, 'thread:history', {}, 'correlated_error')
    expect(failed.ok).toBe(false)
    await close(ws)
  })

  it('serves long-term memory control commands over WebSocket', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-memory-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()
    const config = defaultRuntimeConfig()
    config.context.privateMemoryDir = path.join(root, 'private-memory')
    config.context.teamMemoryDir = path.join(root, 'team-memory')
    config.context.memoryBaseDir = root
    await store.runtimeConfiguration.upsertRuntimeConfig('agent-runtime', config)
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '记忆控制面')
    await store.appendTranscript({ threadId: thread.id, runId: 'run_previous', kind: 'message', payload: { role: 'user', content: '历史目标' } })
    await store.appendTranscript({ threadId: thread.id, runId: 'run_previous', kind: 'message', payload: { role: 'assistant', content: '历史结论' } })

    const server = createServer((_request, response) => response.end())
    const modelRegistry = registryWith({
      ...fakeAdapter({} as Model),
      chat: async () => ({ content: '# 会话标题\n记忆控制面\n\n# 当前状态\n历史结论' }),
    })
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry,
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      defaultRuntimeConfig: config,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const written = payloadData(await request(ws, 'memory:write', {
      scope: 'private',
      type: 'feedback',
      name: 'Review style',
      description: 'Prefer root-cause fixes',
      content: '不要用 fallback 掩盖根因。',
      relativePath: 'feedback/review-style.md',
    }, 'memory_write'))
    expect(isRecord(written) ? written.relativePath : null).toBe('feedback/review-style.md')

    const list = payloadData(await request(ws, 'memory:list', {}, 'memory_list'))
    expect(isRecord(list) && Array.isArray(list.records) ? list.records : []).toHaveLength(1)

    const read = payloadData(await request(ws, 'memory:read', {
      scope: 'private',
      relativePath: 'feedback/review-style.md',
    }, 'memory_read'))
    expect(isRecord(read) ? read.content : '').toContain('根因')

    const search = payloadData(await request(ws, 'memory:search', { query: 'root-cause fallback' }, 'memory_search'))
    expect(isRecord(search) && Array.isArray(search.matches) ? search.matches : []).toHaveLength(1)

    const sessionMemory = payloadData(await request(ws, 'memory:session:rebuild', {
      threadId: thread.id,
      provider: 'fake',
      modelName: 'fake-model',
    }, 'session_rebuild'))
    expect(isRecord(sessionMemory) ? sessionMemory.content : '').toContain('历史结论')

    const dream = payloadData(await request(ws, 'memory:dream', { force: true }, 'memory_dream'))
    expect(isRecord(dream) ? dream.message : '').toContain('未配置模型整理器')

    const deleted = payloadData(await request(ws, 'memory:delete', {
      scope: 'private',
      relativePath: 'feedback/review-style.md',
    }, 'memory_delete'))
    expect(isRecord(deleted) ? deleted.deleted : false).toBe(true)
    await close(ws)
  })

  it('rejects speech:authorization when CSRF token is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-csrf-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const response = await rawRequest(ws, 'speech:authorization', {}, 'csrf_speech')
    expect(response.ok).toBe(false)
    expect(isRecord(response.payload) && isRecord(response.payload.error) ? response.payload.error.message : '').toContain('CSRF')
    await close(ws)
  })

  it('rejects read-type WS commands when auth context is inactive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-inactive-'))
    const store = createTestPersistenceFacade(root, noOpDb())
    await store.initialize()

    const inactiveSecurity = {
      ...testSecurity(),
      auth: {
        ...testSecurity().auth,
        isAuthContextActive: async () => false,
      },
    }

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      managedLayers: {} as unknown as ManagedLayerService,
      runtimeRoot: root,
      security: inactiveSecurity,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.flushConversationStore()
      await removeTempRoot(root)
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const response = await request(ws, 'session:get-default', {}, 'inactive_read')
    expect(response.ok).toBe(false)
    expect(isRecord(response) && isRecord(response.error) ? response.error.message : '').toContain('失效')
    await close(ws)
  })
})

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: TEST_ORIGIN } })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function close(ws: WebSocket): Promise<void> {
  return new Promise(resolve => {
    ws.once('close', () => resolve())
    ws.close()
  })
}

function request(ws: WebSocket, type: string, payload: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 响应超时')), 3000)
    ws.on('message', data => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed) || parsed.id !== id || !isRecord(parsed.payload)) continue
        clearTimeout(timer)
        resolve(parsed.payload)
      }
    })
    ws.send(JSON.stringify({ type, id, payload, meta: { csrfToken: TEST_CSRF } }) + '\n')
  })
}

function rawRequest(ws: WebSocket, type: string, payload: Record<string, unknown>, id: string): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 响应超时')), 3000)
    ws.on('message', data => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed) || parsed.id !== id) continue
        clearTimeout(timer)
        resolve({ ok: isRecord(parsed.payload) ? Boolean(parsed.payload.ok) : false, payload: isRecord(parsed.payload) ? parsed.payload : {} })
      }
    })
    ws.send(JSON.stringify({ type, id, payload }) + '\n')
  })
}

function snapshotRunId(payload: Record<string, unknown>): string | null {
  if (payload.ok !== true || !isRecord(payload.data) || !isRecord(payload.data.run)) return null
  return typeof payload.data.run.id === 'string' ? payload.data.run.id : null
}

function payloadData(payload: Record<string, unknown>): unknown {
  return payload.ok === true ? payload.data : null
}

function snapshotRunStatus(payload: Record<string, unknown>): string | null {
  if (payload.ok !== true || !isRecord(payload.data) || !isRecord(payload.data.run)) return null
  return typeof payload.data.run.status === 'string' ? payload.data.run.status : null
}

function snapshotEntries(payload: Record<string, unknown>, key: 'items' | 'events'): unknown[] {
  if (payload.ok !== true || !isRecord(payload.data) || !Array.isArray(payload.data[key])) return []
  return payload.data[key]
}

function conversationItem(runId: string, threadId: string): ConversationItem {
  return {
    itemId: 'item_replayed',
    itemType: 'message',
    runId,
    threadId,
    turnId: null,
    callId: null,
    role: 'assistant',
    body: '可回放的消息',
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: 'completed',
    metadata: {},
    timestamp: new Date().toISOString(),
  }
}

function runEvent(runId: string, threadId: string): RunEvent {
  return {
    eventId: 'event_replayed',
    runId,
    threadId,
    type: 'step.completed',
    message: '可回放的事件',
    timestamp: new Date().toISOString(),
    payload: {},
  }
}

async function waitForRunSettled(store: PlatformPersistenceFacade, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = store.getRun(runId).status
    if (status !== 'queued' && status !== 'running') return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`运行 '${runId}' 未在测试时间内结束`)
}

function waitForBackgroundSnapshot(ws: WebSocket, ignoredRunId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handle)
      reject(new Error('WebSocket 后台快照超时'))
    }, 3000)
    const handle = (data: RawData) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed) || parsed.type !== 'run.snapshot' || !isRecord(parsed.payload) || !isRecord(parsed.payload.data)) continue
        const run = isRecord(parsed.payload.data.run) ? parsed.payload.data.run : null
        if (!run || run.id === ignoredRunId || typeof run.status !== 'string') continue
        if (run.status === 'queued' || run.status === 'running') continue
        clearTimeout(timer)
        ws.off('message', handle)
        resolve()
      }
    }
    ws.on('message', handle)
  })
}

function textModel(text: string): Model {
  return scriptedModel(() => ({ text }))
}

interface ScriptedResponse {
  text?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
}

function scriptedModel(script: (request: ModelRequest) => ScriptedResponse): Model {
  return {
    async getResponse(request): Promise<ModelResponse> {
      const responseId = makeResponseId()
      return { usage: new Usage(), output: outputItems(structuredResponse(script(request), request), responseId), responseId }
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      const response = structuredResponse(script(request), request)
      const responseId = makeResponseId()
      yield { type: 'response_started' }
      if (response.text) yield { type: 'output_text_delta', delta: response.text }
      yield {
        type: 'response_done',
        response: {
          id: responseId,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: outputItems(response, responseId),
        },
      }
    },
  }
}

function hasToolResult(request: ModelRequest): boolean {
  return Array.isArray(request.input) && request.input.some(item => item.type === 'function_call_result')
}

let responseSequence = 0
function makeResponseId(): string {
  responseSequence += 1
  return `response_${responseSequence}`
}

function outputItems(response: ScriptedResponse, responseId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  if (response.text) {
    output.push({
      id: responseId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: response.text }],
    })
  }
  for (const call of response.toolCalls ?? []) {
    output.push({
      id: responseId,
      type: 'function_call',
      status: 'completed',
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
    })
  }
  return output
}

function structuredResponse(response: ScriptedResponse, request: ModelRequest): ScriptedResponse {
  const normalized = withStrictWorkflowStepIdentity(response, request)
  if (!normalized.text || normalized.toolCalls?.length || request.outputType === 'text') return normalized
  const properties = request.outputType.schema.properties
  if ('markdown' in properties) {
    return {
      ...normalized,
      text: JSON.stringify({ markdown: normalized.text, summary: normalized.text, artifactIds: [], warnings: [] }),
    }
  }
  if ('evidence' in properties) {
    return {
      ...normalized,
      text: JSON.stringify({ status: 'completed', summary: normalized.text, evidence: [], artifactIds: [], warnings: [], error: null }),
    }
  }
  return normalized
}

function rejectedUpgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: TEST_ORIGIN } })
    ws.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode)
      response.resume()
    })
    ws.once('open', () => {
      ws.close()
      reject(new Error('预期 WebSocket upgrade 被拒绝，但连接成功。'))
    })
    ws.once('error', error => {
      if ((error as Error).message.includes('Unexpected server response')) return
      reject(error)
    })
  })
}

function gaugeValue(metric: Awaited<ReturnType<typeof wsConnectionsActive.get>>): number {
  return metric.values[0]?.value ?? 0
}

async function gaugeValuePromise(
  metric: Promise<Awaited<ReturnType<typeof wsConnectionsActive.get>>>,
): Promise<number> {
  return gaugeValue(await metric)
}

async function waitFor(read: () => Promise<number>, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await read() === expected) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待指标恢复到 ${expected} 超时。`)
}

function withStrictWorkflowStepIdentity(response: ScriptedResponse, request: ModelRequest): ScriptedResponse {
  if (!response.toolCalls?.length) return response
  return {
    ...response,
    toolCalls: response.toolCalls.map(call => {
      const definition = request.tools.find(tool => tool.name === call.name)
      const properties = definition && isRecord(definition.parameters)
        && isRecord(definition.parameters.properties)
        ? definition.parameters.properties
        : {}
      if (!('workflowStepId' in properties)) return call
      const parsed: unknown = JSON.parse(call.arguments)
      if (!isRecord(parsed) || 'workflowStepId' in parsed) return call
      return { ...call, arguments: JSON.stringify({ ...parsed, workflowStepId: null }) }
    }),
  }
}

function fakeAdapter(model: Model): ModelAdapter {
  return {
    provider: 'fake',
    displayName: 'Fake',
    defaultModel: 'fake-model',
    contextWindowTokens: 128_000,
    agentToolSchemaMode: 'strict',
    agentRuntimeCapabilities: {
      structuredOutput: 'json_schema',
      functionTools: true,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      remoteConversation: false,
      serverCompaction: false,
    },
    isConfigured: () => true,
    capabilities: () => ['chat', 'stream'],
    createAgentModel: () => model,
    chat: async () => ({ content: '{}' }),
  }
}

function registryWith(adapter: ModelAdapter): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry(testEnv())
  registry.register(adapter)
  return registry
}

function approvalToolProvider(onExecute: () => void): ToolProvider {
  const definition = {
    name: 'sensitive_tool',
    label: '敏感工具',
    description: '测试审批工具',
    prompt: '用于测试审批 decision 恢复流程。',
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    },
  }
  return {
    manifest: {
      id: 'test-approval-provider',
      name: '测试审批工具',
      version: '1.0.0',
      author: 'tests',
      description: '测试 approval decision 恢复',
      language: 'typescript',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => {
        onExecute()
        return {
          message: '敏感工具已执行',
          payload: { ok: true },
          warnings: [],
          resultId: 'result_sensitive',
          source: 'test',
        }
      },
    }],
  }
}

function previewToolProvider(): ToolProvider {
  const definition = {
    name: 'render_rainfall_risk_map',
    label: '生成短时强降水风险区划图',
    description: '测试 mini app 预览 artifact 回放。',
    prompt: '用于测试 direct tool 调用生成可回放 artifact。',
    group: '气象',
    tags: ['meteorology'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
    },
  }
  return {
    manifest: {
      id: 'test-preview-provider',
      name: '测试预览工具',
      version: '1.0.0',
      author: 'tests',
      description: '测试 direct tool item 回放',
      language: 'typescript',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async (_args, ctx) => {
        const relativePath = path.posix.join('artifacts', ctx.runId, 'artifact_preview_png.png')
        const target = path.join(ctx.runtimeRoot, relativePath)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, 'preview', 'utf8')
        return {
          message: '风险图已生成',
          payload: { variable: 'QPF', mapMode: 'regional' },
          warnings: [],
          resultId: 'result_preview',
          source: 'test',
          artifacts: [{
            artifactId: 'artifact_preview_png',
            artifactType: 'raster_png',
            name: '风险图预览',
            uri: '/api/v1/results/artifact_preview_png/file',
            relativePath,
            display: { surfaces: ['mini_app', 'download'], primarySurface: 'mini_app', map: null },
            metadata: { previewRole: 'rainfall_risk_map', relativePath },
          }],
        }
      },
    }],
  }
}

function failingWorkerToolProvider(): ToolProvider {
  const definition = {
    name: 'worker_failure_probe',
    label: 'Worker 失败探针',
    description: '验证 Python Worker 失败通过工具运行状态传播。',
    prompt: '仅用于控制面集成测试。',
    group: '测试',
    tags: ['worker'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }
  return {
    manifest: {
      id: 'test-worker-failure-provider',
      name: '测试 Worker 失败传播',
      version: '1.0.0',
      author: 'tests',
      description: '测试 Worker 失败运行终态',
      language: 'typescript',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => {
        throw new Error('Python Worker 连接已中断')
      },
    }],
  }
}

function noOpDb(): Database {
  const runtimeConfig = new Map<string, Record<string, unknown>>()
  const client = {
    query: async (query: { text: string } | string, values: unknown[] = []) => {
      const text = typeof query === 'string' ? query : query.text
      if (text.startsWith('insert into "platform_runtime_config"')) {
        const key = String(values[0] ?? '')
        runtimeConfig.set(key, parseJsonRecord(values.at(-1)))
        return { rows: [] }
      }
      if (text.includes('from "platform_runtime_config"')) {
        const key = String(values[0] ?? '')
        const payload = runtimeConfig.get(key)
        return { rows: payload ? [[payload]] : [] }
      }
      return { rows: [] }
    },
  }
  const db = drizzle(client as never, { schema }) as unknown as Database
  return Object.assign(db, { pool: {}, close: async () => {} }) as Database
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  }
  return isRecord(value) ? value : {}
}

function testSecurity(deniedWorkspaceId?: string): SecurityServices {
  return {
    auth: {
      authenticateRequest: async () => TEST_AUTH,
      authenticateHeaders: async () => TEST_AUTH,
      isTrustedOrigin: (origin?: string | null) => origin === TEST_ORIGIN,
      isAuthContextActive: async () => true,
      requireCsrf: () => {},
      toAuthMe: auth => ({
        user: {
          userId: auth.userId,
          subject: auth.subject,
          email: auth.email,
          displayName: auth.displayName,
          status: 'active',
          lastLoginAt: null,
          createdAt: '',
          updatedAt: '',
        },
        defaultWorkspace: null,
        memberships: auth.roles.map(role => ({
          membershipId: `${role.workspaceId}:${role.role}`,
          workspaceId: role.workspaceId,
          userId: auth.userId,
          role: role.role,
          createdAt: '',
        })),
        platformRoles: auth.roles.map(role => role.role),
        csrfToken: auth.csrfToken,
        permissions: [],
      }),
    },
    authorization: {
      enforce: async () => {},
      can: async () => true,
      assertResourceWorkspace: async (
        _auth: AuthContext,
        _object: string,
        _action: string,
        resource: { workspaceId?: string | null },
      ) => {
        if (resource.workspaceId === deniedWorkspaceId) throw new Error('跨工作区资源访问被拒绝。')
      },
      audit: async () => {},
      reload: async () => {},
    },
    db: noOpDb(),
  } as unknown as SecurityServices
}

function testEnv(): Env {
  return {
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    DATABASE_URL: 'postgres://unused',
    RUNTIME_ROOT: 'runtime',
    ENABLED_TOOL_PROVIDERS: '',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
