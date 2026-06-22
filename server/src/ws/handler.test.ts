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
      store.createRun(session.id, `查询 ${index + 1}`, { threadId: thread.id })
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
      await store.sessionLog.flush()
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
    const run = store.createRun(session.id, '测试', { threadId: thread.id })

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
      await store.sessionLog.flush()
      await rm(root, { recursive: true, force: true })
    })

    const first = await connect(url)
    const firstSnapshot = await request(first, 'run:subscribe', { runId: run.id }, 'first')
    expect(snapshotRunId(firstSnapshot)).toBe(run.id)
    await close(first)

    store.appendItem(conversationItem(run.id, thread.id))
    store.appendEvent(run.id, runEvent(run.id, thread.id))
    store.updateRunStatus(run.id, 'running')

    const second = await connect(url)
    const replay = await request(second, 'run:subscribe', { runId: run.id }, 'second')
    expect(snapshotRunId(replay)).toBe(run.id)
    expect(snapshotEntries(replay, 'items')).toHaveLength(1)
    expect(snapshotEntries(replay, 'events')).toHaveLength(1)
    expect(snapshotRunStatus(replay)).toBe('running')
    await close(second)
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
