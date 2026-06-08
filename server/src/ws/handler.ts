// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket Handler
//
//   文件:       handler.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { PostgresPlatformStore, type StoreNotFoundError } from '../store/platformStore.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../framework/registry.js'
import { GeoAgentRuntime } from '../agent/runtime.js'
import { parseMessage, formatMsg } from './protocol.js'

export function createWsHandler(
  server: Server,
  store: PostgresPlatformStore,
  toolRegistry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
) {
  const runtime = new GeoAgentRuntime(store, toolRegistry, modelRegistry)
  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = parseMessage(line)
        if (!msg) { ws.send(formatMsg('error', { detail: '无效消息格式' }, null)); continue }
        handleMessage(ws, msg, store, runtime, toolRegistry, modelRegistry)
      }
    })

    ws.on('close', () => { /* cleanup */ })

    // Keepalive
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(formatMsg('keepalive', {}))
    }, 30000)

    ws.on('close', () => clearInterval(keepalive))
  })

  return wss
}

async function handleMessage(
  ws: WebSocket,
  msg: { type: string; id: string; payload: Record<string, unknown> },
  store: PostgresPlatformStore,
  runtime: GeoAgentRuntime,
  toolRegistry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
) {
  const { type, id, payload } = msg

  try {
    switch (type) {
      // --- Threads ---
      case 'thread:create': {
        const sessionId = payload.sessionId as string
        const title = payload.title as string | null
        const thread = await store.createThread(sessionId, title)
        ws.send(formatMsg('thread', { thread }, id))
        break
      }
      case 'thread:get': {
        const threadId = payload.threadId as string
        const thread = store.getThread(threadId)
        const runs = store.listRunsForThread(threadId)
        ws.send(formatMsg('thread', { thread, runs, latestRun: runs[0] ?? null }, id))
        break
      }
      case 'thread:list': {
        const sessionId = payload.sessionId as string
        const threads = store.listThreadsForSession(sessionId)
        ws.send(formatMsg('thread', { threads }, id))
        break
      }
      case 'thread:update': {
        const thread = await store.updateThread(payload.threadId as string, { title: payload.title as string })
        ws.send(formatMsg('thread', { thread }, id))
        break
      }
      case 'thread:delete': {
        await store.deleteThread(payload.threadId as string)
        ws.send(formatMsg('thread', { deleted: true, threadId: payload.threadId }, id))
        break
      }

      // --- Runs ---
      case 'run:start': {
        const sessionId = payload.sessionId as string
        const query = payload.query as string
        const run = store.createRun(sessionId, query, {
          threadId: (payload.threadId as string) ?? null,
          modelProvider: (payload.provider as string) ?? 'openai_compatible',
          modelName: (payload.modelName as string) ?? null,
        })

        // Stream items back via WS
        const unsub = store.itemBus.subscribe(run.id, (item) => {
          if (ws.readyState !== WebSocket.OPEN) return
          if (item.status === 'running') {
            ws.send(formatMsg('item:started', { item }))
          } else {
            ws.send(formatMsg('item:completed', { item }))
          }
        })

        // Run agent
        ws.send(formatMsg('run', { run }, id))
        runtime.run({
          runId: run.id, threadId: run.threadId, sessionId,
          query, provider: (payload.provider as string) ?? 'openai_compatible',
          modelName: (payload.modelName as string) ?? null,
          runtimeConfig: {} as any,
          reasoning: payload.reasoning as boolean ?? true,
        }).then((finalRun) => {
          ws.send(formatMsg('result', { status: finalRun.status, runId: finalRun.id }))
          unsub()
        }).catch(err => {
          ws.send(formatMsg('error', { detail: (err as Error).message, runId: run.id }))
          unsub()
        })
        break
      }
      case 'run:cancel': {
        const run = runtime.cancel(payload.runId as string)
        ws.send(formatMsg('run', { run }, id))
        break
      }
      case 'run:approve': {
        const run = await runtime.resolveApproval(
          payload.runId as string, payload.approvalId as string, payload.approved as boolean,
        )
        ws.send(formatMsg('run', { run }, id))
        break
      }

      // --- Tools, Layers, Config ---
      case 'tool:list': {
        ws.send(formatMsg('tool:list', { tools: toolRegistry.descriptors() }, id))
        break
      }
      case 'config:get': {
        ws.send(formatMsg('config', { config: {} }, id))
        break
      }
      case 'config:set': {
        ws.send(formatMsg('config', { config: payload }, id))
        break
      }

      default:
        ws.send(formatMsg('error', { detail: `未知消息类型: ${type}` }, id))
    }
  } catch (err) {
    if ((err as StoreNotFoundError).name === 'StoreNotFoundError') {
      ws.send(formatMsg('error', { detail: (err as Error).message }, id))
    } else {
      throw err
    }
  }
}
