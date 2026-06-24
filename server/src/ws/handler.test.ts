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
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { ToolRegistry } from '../framework/registry.js'
import type { Env } from '../framework/env.js'
import type { PostGisRepository } from '../gis/postgis.js'
import { ModelAdapterRegistry } from '../model/registry.js'
import type { ConversationItem, RunEvent } from '../schemas/types.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import type { ToolProvider } from '../framework/types.js'
import { createWsHandler } from './handler.js'

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
})

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
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

function previewToolProvider(): ToolProvider {
  const definition = {
    name: 'render_rainfall_risk_map',
    label: '生成降雨风险区划图',
    description: '测试 mini app 预览 artifact 回放。',
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
