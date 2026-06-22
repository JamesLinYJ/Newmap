// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面
//
//   文件:       handler.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { PostGisRepository } from '../gis/postgis.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext } from '../framework/types.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { GeoAgentRuntime } from '../agent/runtime.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { PostgresPlatformStore, StoreNotFoundError } from '../store/platformStore.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { failure, parseMessage, push, success, type ClientMsg } from './protocol.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from '../tools/resultPersistence.js'

interface WsDependencies {
  store: PostgresPlatformStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  postgis: PostGisRepository
  runtimeRoot: string
}

export function createWsHandler(server: Server, dependencies: WsDependencies) {
  const { store } = dependencies
  const runtime = new GeoAgentRuntime(store, dependencies.toolRegistry, dependencies.modelRegistry)
  const files = new RuntimeFileStore(dependencies.runtimeRoot)
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws) => {
    const subscriptions = new Map<string, () => void>()
    const keepalive = setInterval(() => send(ws, push('keepalive', {})), 30_000)

    ws.on('message', async (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        let msg: ClientMsg
        try {
          msg = parseMessage(line)
        } catch (error) {
          send(ws, failure(null, 'invalid_request', formatError(error)))
          continue
        }
        try {
          const result = await handleMessage(msg, dependencies, runtime, files, ws, subscriptions)
          send(ws, success(msg.id, result))
        } catch (error) {
          const code = error instanceof StoreNotFoundError ? 'not_found' : 'command_failed'
          send(ws, failure(msg.id, code, formatError(error)))
        }
      }
    })

    ws.on('close', () => {
      clearInterval(keepalive)
      subscriptions.forEach(unsubscribe => unsubscribe())
      subscriptions.clear()
    })
  })

  return wss
}

async function handleMessage(
  msg: ClientMsg,
  dependencies: WsDependencies,
  runtime: GeoAgentRuntime,
  files: RuntimeFileStore,
  ws: WebSocket,
  subscriptions: Map<string, () => void>,
): Promise<unknown> {
  const { store, toolRegistry, modelRegistry, postgis } = dependencies
  const payload = msg.payload
  switch (msg.type) {
    case 'workspace:bootstrap': {
      // 首屏只取稳定摘要；工具、配置、图层和完整运行快照由可见功能按需加载。
      const requestedSessionId = optionalString(payload.sessionId)
      const session = requestedSessionId
        ? store.getSession(requestedSessionId)
        : await store.getOrCreateDefaultSession()
      return {
        session,
        threads: store.listThreadsForSession(session.id),
        providers: modelRegistry.descriptors(),
      }
    }
    case 'session:get-default':
      return store.getOrCreateDefaultSession()
    case 'session:get':
      return store.getSession(requiredString(payload, 'sessionId'))
    case 'thread:list':
      return store.listThreadsForSession(requiredString(payload, 'sessionId'))
    case 'thread:get': {
      const threadId = requiredString(payload, 'threadId')
      const runs = store.listRunsForThread(threadId)
      return { thread: store.getThread(threadId), runs, latestRun: runs[0] ?? null }
    }
    case 'thread:create':
      return store.createThread(requiredString(payload, 'sessionId'), optionalString(payload.title))
    case 'thread:update':
      return store.updateThread(requiredString(payload, 'threadId'), { title: requiredString(payload, 'title') })
    case 'thread:delete': {
      const threadId = requiredString(payload, 'threadId')
      await store.deleteThread(threadId)
      return { deleted: true, threadId }
    }
    case 'run:list':
      return store.listRunSummaries({
        sessionId: requiredString(payload, 'sessionId'),
        threadId: optionalString(payload.threadId),
        cursor: optionalString(payload.cursor),
        limit: optionalPositiveInteger(payload.limit, 'limit'),
      })
    case 'run:start': {
      const query = requiredString(payload, 'query')
      let threadId = optionalString(payload.threadId)
      const sessionId = optionalString(payload.sessionId) ?? (threadId ? store.getThread(threadId).sessionId : null)
      if (!sessionId) throw new Error('sessionId 不能为空')
      if (!threadId) threadId = (await store.createThread(sessionId, query.slice(0, 32))).id
      const config = await resolveRuntimeConfig(store)
      const run = store.createRun(sessionId, query, {
        threadId,
        modelProvider: optionalString(payload.provider) ?? optionalString(payload.modelProvider),
        modelName: optionalString(payload.modelName),
        runtimeConfigSnapshot: config,
      })
      subscribeToRun(ws, run.id, store, subscriptions)
      void runtime.run({
        runId: run.id,
        threadId,
        sessionId,
        query,
        provider: run.modelProvider ?? modelRegistry.defaultProvider,
        modelName: run.modelName,
        runtimeConfig: config,
        executionMode: payload.executionMode === 'plan' ? 'plan' : 'auto',
        reasoning: payload.reasoning !== false,
      }).then(() => sendSnapshot(ws, run.id, store))
      return run
    }
    case 'run:get':
      return snapshot(requiredString(payload, 'runId'), store)
    case 'run:cancel':
      return runtime.cancel(requiredString(payload, 'runId'))
    case 'run:resolve-approval':
      return runtime.resolveApproval(
        requiredString(payload, 'runId'),
        requiredString(payload, 'approvalId'),
        requiredBoolean(payload, 'approved'),
      )
    case 'run:subscribe': {
      const runId = requiredString(payload, 'runId')
      subscribeToRun(ws, runId, store, subscriptions)
      return snapshot(runId, store)
    }
    case 'run:unsubscribe': {
      const runId = requiredString(payload, 'runId')
      subscriptions.get(runId)?.()
      subscriptions.delete(runId)
      return { unsubscribed: true, runId }
    }
    case 'tool:list':
      return toolRegistry.descriptors()
    case 'tool:run':
      return executeTool(payload, store, toolRegistry, modelRegistry)
    case 'tool-catalog:list':
      return store.listToolCatalogEntries()
    case 'tool-catalog:upsert':
      return store.upsertToolCatalogEntry({
        toolKind: requiredString(payload, 'toolKind'),
        toolName: requiredString(payload, 'toolName'),
        payload: requiredRecord(payload, 'payload'),
        sortOrder: typeof payload.sortOrder === 'number' ? payload.sortOrder : 0,
      })
    case 'tool-catalog:delete':
      await store.deleteToolCatalogEntry(requiredString(payload, 'toolKind'), requiredString(payload, 'toolName'))
      return { deleted: true }
    case 'runtime-config:get':
      return resolveRuntimeConfig(store)
    case 'runtime-config:update': {
      const config = requiredRecord(payload, 'config')
      await store.upsertRuntimeConfig('agent-runtime', config)
      return config
    }
    case 'provider:list':
      return modelRegistry.descriptors()
    case 'system:get': {
      const postgisStatus = await postgis.status()
      return {
        catalogBackend: 'typescript',
        postgisEnabled: postgisStatus.available,
        postgisError: postgisStatus.error,
        sessionLogRoot: store.sessionLogRoot,
        providers: modelRegistry.descriptors(),
        toolProviders: toolRegistry.providerStatuses(),
      }
    }
    case 'file:list': {
      const entries = await files.list(optionalString(payload.threadId))
      return { files: entries, total: entries.length }
    }
    case 'file:delete': {
      const fileId = requiredString(payload, 'fileId')
      const deleted = await files.delete(fileId, optionalString(payload.threadId))
      if (!deleted) throw new StoreNotFoundError(`文件 '${fileId}' 不存在`)
      return { deleted: true, id: fileId }
    }
    case 'layer:list':
      return postgis.listLayers(optionalString(payload.sessionId), optionalString(payload.threadId))
    case 'layer:update':
      return postgis.updateLayerMetadata(requiredString(payload, 'layerKey'), requiredRecord(payload, 'update'))
    case 'layer:delete': {
      const layerKey = requiredString(payload, 'layerKey')
      const deleted = await postgis.deleteLayer(layerKey)
      if (!deleted) throw new StoreNotFoundError(`图层 '${layerKey}' 不存在`)
      return { deleted: true, layerKey }
    }
  }
}

async function executeTool(
  payload: Record<string, unknown>,
  store: PostgresPlatformStore,
  registry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
) {
  let runId = optionalString(payload.runId)
  let directRun = false
  if (!runId) {
    const sessionId = requiredString(payload, 'sessionId')
    let threadId = optionalString(payload.threadId)
    if (!threadId) threadId = (await store.createThread(sessionId, `工具：${requiredString(payload, 'toolName')}`)).id
    const created = store.createRun(sessionId, `执行工具 ${requiredString(payload, 'toolName')}`, {
      threadId,
      modelProvider: modelRegistry.defaultProvider || null,
      runtimeConfigSnapshot: await resolveRuntimeConfig(store),
    })
    runId = created.id
    directRun = true
    store.updateRunStatus(runId, 'running')
  }
  const run = store.getRun(runId)
  const values = new Map(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
  const context: ToolContext = {
    runId,
    sessionId: run.sessionId,
    threadId: run.threadId,
    state: values,
    resolveValueRef: refId => resolveRuntimeValueRef(values, refId),
    invokeStructuredModel: async prompt => {
      const adapter = modelRegistry.resolveProvider(run.modelProvider)
      const response = await adapter.chat(prompt, { model: run.modelName ?? adapter.defaultModel, reasoning: false })
      const content = response.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回结构化内容')
      const parsed: unknown = JSON.parse(content.replace(/^```json\s*|\s*```$/gu, ''))
      if (!isRecord(parsed)) throw new Error('模型结构化输出必须是 JSON object')
      return parsed
    },
    log: (_level, message) => {
      store.appendEvent(runId, {
        eventId: makeId('event'), runId, threadId: run.threadId, type: 'tool.completed',
        message, timestamp: nowUtc(), payload: {},
      })
    },
  }
  const toolName = requiredString(payload, 'toolName')
  const args = requiredRecord(payload, 'args')
  try {
    const result = await registry.execute(toolName, args, context)
    await persistToolExecutionResult(store, runId, toolName, args, result)
    if (directRun) store.completeRun(runId, 'completed')
    return { result, run: store.getRun(runId) }
  } catch (error) {
    if (directRun) {
      const message = formatError(error)
      const current = store.getRun(runId)
      store.updateRunState(runId, { errors: [...current.state.errors, message], failedTool: toolName })
      store.completeRun(runId, 'failed')
    }
    throw error
  }
}

function subscribeToRun(
  ws: WebSocket,
  runId: string,
  store: PostgresPlatformStore,
  subscriptions: Map<string, () => void>,
): void {
  store.getRun(runId)
  if (subscriptions.has(runId)) return
  const unsubscribeItem = store.itemBus.subscribe(runId, item => send(ws, push('run.item', item)))
  const unsubscribeEvent = store.eventBus.subscribe(runId, event => send(ws, push('run.event', event)))
  const unsubscribeRun = store.runBus.subscribe(runId, () => sendSnapshot(ws, runId, store))
  subscriptions.set(runId, () => {
    unsubscribeItem()
    unsubscribeEvent()
    unsubscribeRun()
  })
}

function snapshot(runId: string, store: PostgresPlatformStore) {
  return { run: store.getRun(runId), items: store.listItems(runId), events: store.listEvents(runId) }
}

function sendSnapshot(ws: WebSocket, runId: string, store: PostgresPlatformStore): void {
  send(ws, push('run.snapshot', snapshot(runId, store)))
}

function send(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(message)
}

async function resolveRuntimeConfig(store: PostgresPlatformStore): Promise<AgentRuntimeConfig> {
  const stored = await store.getRuntimeConfig('agent-runtime')
  return stored ? stored as AgentRuntimeConfig : defaultRuntimeConfig()
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`)
  return value.trim()
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredBoolean(payload: Record<string, unknown>, key: string): boolean {
  if (typeof payload[key] !== 'boolean') throw new Error(`${key} 必须为 boolean`)
  return payload[key]
}

function optionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} 必须为正整数`)
  }
  return value
}

function requiredRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key]
  if (!isRecord(value)) throw new Error(`${key} 必须为 object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
