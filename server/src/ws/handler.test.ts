// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 订阅回放集成测试
//
//   文件:       handler.test.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
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
import { WebSocket, type RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { ToolRegistry } from '../framework/registry.js'
import type { Env } from '../framework/env.js'
import type { PostGisRepository } from '../gis/postgis.js'
import { ModelAdapterRegistry, type ModelAdapter } from '../model/registry.js'
import type { ConversationItem, RunEvent } from '../schemas/types.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import type { ToolProvider } from '../framework/types.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { OpenAIAgentsRuntime, type SandboxSessionFactory } from '../agent/runtime.js'
import { createWsHandler } from './handler.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'

const TEST_ORIGIN = 'http://127.0.0.1:5173'
const TEST_CSRF = 'csrf_test'
const TEST_AUTH: AuthContext = {
  userId: 'user_test',
  subject: 'auth_user_test',
  email: 'tester@geoforge.local',
  displayName: '测试用户',
  authSessionId: 'session_test',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: TEST_CSRF,
  defaultWorkspaceId: 'workspace_test',
  roles: [{ workspaceId: 'workspace_test', role: 'platform_admin' }],
}

const testSandboxSessionFactory: SandboxSessionFactory = async manifest => ({
  state: { manifest, workspaceReady: true },
  createEditor: () => ({
    createFile: async () => { throw new Error('测试 sandbox 不允许写入文件') },
    updateFile: async () => { throw new Error('测试 sandbox 不允许修改文件') },
    deleteFile: async () => { throw new Error('测试 sandbox 不允许删除文件') },
  }),
  execCommand: async () => { throw new Error('测试 sandbox 不允许执行 shell 命令') },
  supportsPty: () => false,
  close: async () => {},
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

describe('WebSocket run subscriptions', () => {
  it('returns workspace summaries and paged runs without per-thread requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-bootstrap-'))
    const store = new PostgresPlatformStore(noOpDb(), root)
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
      postgis: {} as unknown as PostGisRepository,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const bootstrap = payloadData(await request(ws, 'workspace:bootstrap', { sessionId: session.id }, 'bootstrap'))
    expect(isRecord(bootstrap) && isRecord(bootstrap.session) ? bootstrap.session.id : null).toBe(session.id)
    expect(isRecord(bootstrap) && Array.isArray(bootstrap.threads) ? bootstrap.threads : []).toHaveLength(4)

    const first = payloadData(await request(ws, 'run:list', { sessionId: session.id, limit: 3 }, 'runs_1'))
    expect(isRecord(first) && Array.isArray(first.items) ? first.items : []).toHaveLength(3)
    const cursor = isRecord(first) && typeof first.nextCursor === 'string' ? first.nextCursor : null
    const second = payloadData(await request(ws, 'run:list', { sessionId: session.id, limit: 3, cursor }, 'runs_2'))
    expect(isRecord(second) && Array.isArray(second.items) ? second.items : []).toHaveLength(1)
    await close(ws)
  })

  it('replays a full snapshot after reconnect and resubscribe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-'))
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '订阅测试')
    const run = await store.createRun(session.id, '测试', { threadId: thread.id })

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelAdapterRegistry(testEnv()),
      postgis: {} as unknown as PostGisRepository,
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
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
    })

    const first = await connect(url)
    const firstSnapshot = await request(first, 'run:subscribe', { runId: run.id }, 'first')
    expect(snapshotRunId(firstSnapshot)).toBe(run.id)
    await close(first)

    store.appendItem(conversationItem(run.id, thread.id))
    store.appendEvent(run.id, runEvent(run.id, thread.id))
    await store.updateRunStatus(run.id, 'running')

    const second = await connect(url)
    const replay = await request(second, 'run:subscribe', { runId: run.id }, 'second')
    expect(snapshotRunId(replay)).toBe(run.id)
    expect(snapshotEntries(replay, 'items')).toHaveLength(1)
    expect(snapshotEntries(replay, 'events')).toHaveLength(1)
    expect(snapshotRunStatus(replay)).toBe('running')
    await close(second)
  })

  it('responds to clarification decisions through the unified decision command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-decision-'))
    const store = new PostgresPlatformStore(noOpDb(), root)
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
      postgis: {} as unknown as PostGisRepository,
      runtimeRoot: root,
      createSandboxSession: testSandboxSessionFactory,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
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
    await store.conversationStore.flush()
    await close(ws)
  })

  it('responds to approval decisions through the unified decision command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-approval-decision-'))
    const store = new PostgresPlatformStore(noOpDb(), root)
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
      createSandboxSession: testSandboxSessionFactory,
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
    await store.conversationStore.flush()

    const server = createServer((_request, response) => response.end())
    const wss = createWsHandler(server, {
      store,
      toolRegistry: tools,
      modelRegistry: models,
      postgis: {} as unknown as PostGisRepository,
      runtimeRoot: root,
      createSandboxSession: testSandboxSessionFactory,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
    })

    const ws = await connect(`ws://127.0.0.1:${address.port}/ws`)
    const response = payloadData(await request(ws, 'run:respond-decision', {
      runId: run.id,
      decisionId: decision.decisionId,
      optionId: 'approve',
    }, 'approval_decision'))

    expect(isRecord(response) ? response.status : null).toBe('completed')
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
    const store = new PostgresPlatformStore(noOpDb(), root)
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
      postgis: {} as unknown as PostGisRepository,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
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
          metadata: expect.objectContaining({ displaySurfaces: ['mini_app', 'download'] }),
        })],
      },
    })
    await close(ws)
  })

  it('serves thread history, context, memory, fork and trash commands with correlated envelopes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-ws-thread-kernel-'))
    const store = new PostgresPlatformStore(noOpDb(), root)
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
      postgis: {} as unknown as PostGisRepository,
      runtimeRoot: root,
      security: testSecurity(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 地址')
    cleanups.push(async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
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
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const config = defaultRuntimeConfig()
    config.context.privateMemoryDir = path.join(root, 'private-memory')
    config.context.teamMemoryDir = path.join(root, 'team-memory')
    config.context.memoryBaseDir = root
    await store.upsertRuntimeConfig('agent-runtime', config)
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
      postgis: {} as unknown as PostGisRepository,
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
      await store.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
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
    ws.send(JSON.stringify({ type, id, payload: { csrfToken: TEST_CSRF, ...payload } }) + '\n')
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

async function waitForRunSettled(store: PostgresPlatformStore, runId: string): Promise<void> {
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
      return { usage: new Usage(), output: outputItems(script(request), responseId), responseId }
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      const response = script(request)
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

function fakeAdapter(model: Model): ModelAdapter {
  return {
    provider: 'fake',
    displayName: 'Fake',
    defaultModel: 'fake-model',
    contextWindowTokens: 128_000,
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
      handler: async () => ({
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
          relativePath: 'artifacts/run_preview/artifact_preview_png.png',
          metadata: { previewRole: 'rainfall_risk_map', displaySurfaces: ['mini_app', 'download'] },
        }],
      }),
    }],
  }
}

function noOpDb(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}

function testSecurity(): SecurityServices {
  return {
    auth: {
      authenticateRequest: async () => TEST_AUTH,
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
      assertResourceWorkspace: async () => {},
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
