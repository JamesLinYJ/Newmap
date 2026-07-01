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
import type { AgentRuntimeConfig, AnalysisRun, DecisionRequest } from '../schemas/types.js'
import type { PostGisRepository } from '../gis/postgis.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext } from '../framework/types.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { OpenAIAgentsRuntime, type SandboxSessionFactory } from '../agent/runtime.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { PostgresPlatformStore, StoreNotFoundError } from '../store/platformStore.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { failure, parseMessage, push, success, type ClientMsg } from './protocol.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from '../tools/resultPersistence.js'
import { assembleThreadContext, compactThreadIfNeeded } from '../agent/contextManager.js'
import {
  createMemoryRuntime,
  deleteMemory,
  dreamMemories,
  extractMemoriesFromThread,
  listMemories,
  readMemory,
  rebuildSessionMemory,
  searchMemories,
  writeMemory,
} from '../memory/service.js'
import { memoryScopeSchema, memoryTypeSchema } from '../memory/schemas.js'
import { buildSystemPrompt } from '../agent/prompts.js'
import { ItemSink } from '../conversation/itemSink.js'
import { getEnv } from '../framework/env.js'
import { AzureSpeechService } from '../speech/azureSpeechService.js'

interface WsDependencies {
  store: PostgresPlatformStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  postgis: PostGisRepository
  runtimeRoot: string
  defaultRuntimeConfig?: AgentRuntimeConfig
  createSandboxSession?: SandboxSessionFactory
}

export function createWsHandler(server: Server, dependencies: WsDependencies) {
  const { store } = dependencies
  const runtime = new OpenAIAgentsRuntime(store, dependencies.toolRegistry, dependencies.modelRegistry, {
    createSandboxSession: dependencies.createSandboxSession,
  })
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
  runtime: OpenAIAgentsRuntime,
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
      return {
        thread: store.getThread(threadId),
        manifest: await store.getThreadManifest(threadId),
        runs,
        latestRun: runs[0] ?? null,
      }
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
    case 'thread:history':
      return store.listThreadHistory(
        requiredString(payload, 'threadId'),
        optionalString(payload.cursor),
        optionalPositiveInteger(payload.limit, 'limit'),
      )
    case 'thread:fork':
      return store.forkThread(
        requiredString(payload, 'threadId'),
        requiredString(payload, 'entryId'),
        optionalString(payload.title),
      )
    case 'thread:context': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const tools = toolRegistry.list().map(tool => `- ${tool.name}: ${tool.description}`).join('\n')
      const systemPrompt = buildSystemPrompt(config, null, tools, '', '')
      return (await assembleThreadContext(store, threadId, config.context, systemPrompt)).report
    }
    case 'thread:compact': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return compactThreadIfNeeded(
        store,
        threadId,
        config.context,
        makeSummarizer(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName)),
        true,
      )
    }
    case 'thread:memory:get':
      return store.getThreadMemory(requiredString(payload, 'threadId'))
    case 'thread:memory:update':
      return store.updateThreadMemory(
        requiredString(payload, 'threadId'),
        requiredString(payload, 'content'),
        optionalNonNegativeInteger(payload.expectedVersion, 'expectedVersion'),
      )
    case 'thread:memory:rebuild': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return rebuildSessionMemory(
        store,
        threadId,
        config.context,
        makeSummarizer(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName)),
        true,
      )
    }
    case 'memory:list': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const runtimeMemory = createMemoryRuntime(store.runtimeRoot, config.context)
      const scope = optionalString(payload.scope)
      const records = await listMemories(runtimeMemory, scope ? memoryScopeSchema.parse(scope) : undefined)
      return { records, total: records.length }
    }
    case 'memory:read': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return readMemory(
        createMemoryRuntime(store.runtimeRoot, config.context),
        memoryScopeSchema.parse(requiredString(payload, 'scope')),
        requiredString(payload, 'relativePath'),
      )
    }
    case 'memory:write': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return writeMemory(createMemoryRuntime(store.runtimeRoot, config.context), {
        scope: memoryScopeSchema.parse(requiredString(payload, 'scope')),
        type: memoryTypeSchema.parse(requiredString(payload, 'type')),
        name: requiredString(payload, 'name'),
        description: requiredString(payload, 'description'),
        content: requiredString(payload, 'content'),
        relativePath: optionalString(payload.relativePath),
      })
    }
    case 'memory:delete': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return deleteMemory(
        createMemoryRuntime(store.runtimeRoot, config.context),
        memoryScopeSchema.parse(requiredString(payload, 'scope')),
        requiredString(payload, 'relativePath'),
      )
    }
    case 'memory:search': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const selector = makeOptionalStructuredSelector(
        modelRegistry,
        config,
        optionalString(payload.provider),
        optionalString(payload.modelName),
      )
      const matches = await searchMemories(
        createMemoryRuntime(store.runtimeRoot, config.context),
        requiredString(payload, 'query'),
        selector,
      )
      return { matches, total: matches.length }
    }
    case 'memory:extract': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const runId = optionalString(payload.runId) ?? store.listRunsForThread(threadId)[0]?.id
      if (!runId) throw new Error('memory:extract 需要 runId 或已有线程运行')
      const records = await extractMemoriesFromThread(
        createMemoryRuntime(store.runtimeRoot, config.context),
        store,
        threadId,
        runId,
        makeStructuredSelector(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName)),
      )
      return { records, total: records.length }
    }
    case 'memory:dream': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return dreamMemories(
        createMemoryRuntime(store.runtimeRoot, config.context),
        makeOptionalStructuredSelector(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName)),
        { force: payload.force === true },
      )
    }
    case 'memory:session:get':
      return store.getThreadMemory(requiredString(payload, 'threadId'))
    case 'memory:session:rebuild': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return rebuildSessionMemory(
        store,
        threadId,
        config.context,
        makeSummarizer(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName)),
        true,
      )
    }
    case 'memory:instructions:list': {
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return {
        enabled: config.context.instructionMemoryEnabled,
        entrypointName: config.context.instructionEntrypointName,
        records: [],
      }
    }
    case 'thread:trash:list':
      return store.listTrash(requiredString(payload, 'sessionId'))
    case 'thread:trash:restore':
      return store.restoreThread(requiredString(payload, 'threadId'))
    case 'thread:trash:purge': {
      const threadId = requiredString(payload, 'threadId')
      await store.purgeThread(threadId)
      return { purged: true, threadId }
    }
    case 'thread:subscribe': {
      const threadId = requiredString(payload, 'threadId')
      subscribeToThread(ws, threadId, store, subscriptions)
      return { thread: store.getThread(threadId), manifest: await store.getThreadManifest(threadId) }
    }
    case 'thread:unsubscribe': {
      const threadId = requiredString(payload, 'threadId')
      const key = `thread:${threadId}`
      subscriptions.get(key)?.()
      subscriptions.delete(key)
      return { unsubscribed: true, threadId }
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
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const selectedProvider = optionalString(payload.provider)
        ?? optionalString(payload.modelProvider)
        ?? modelRegistry.defaultProvider
      if (!selectedProvider) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')
      const run = await store.createRun(sessionId, query, {
        threadId,
        modelProvider: selectedProvider,
        modelName: optionalString(payload.modelName),
        runtimeConfigSnapshot: config,
      })
      subscribeToRun(ws, run.id, store, subscriptions)
      void runtime.run({
        runId: run.id,
        threadId,
        sessionId,
        query,
        provider: selectedProvider,
        modelName: run.modelName,
        runtimeConfig: config,
        executionMode: payload.executionMode === 'plan' ? 'plan' : 'auto',
        reasoning: payload.reasoning !== false,
      }).then(() => void sendSnapshot(ws, run.id, store))
      return run
    }
    case 'run:get':
      return snapshot(requiredString(payload, 'runId'), store)
    case 'run:cancel':
      return runtime.cancel(requiredString(payload, 'runId'))
    case 'run:resume': {
      const runId = requiredString(payload, 'runId')
      const run = store.getRun(runId)
      const checkpoint = await store.conversationStore.getRunCheckpoint(runId)
      if (checkpoint.pendingToolCallIds.length) {
        await store.updateRunStatus(runId, 'requires_action')
        throw new Error(`运行包含状态未知的工具调用，禁止自动重放：${checkpoint.pendingToolCallIds.join(', ')}`)
      }
      if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot`)
      subscribeToRun(ws, runId, store, subscriptions)
      void runtime.run({
        runId,
        threadId: run.threadId,
        sessionId: run.sessionId,
        query: run.userQuery,
        provider: requiredRunProvider(run.modelProvider),
        modelName: run.modelName,
        runtimeConfig: run.runtimeConfigSnapshot,
        resume: true,
      }).then(() => void sendSnapshot(ws, runId, store))
      return store.getRun(runId)
    }
    case 'run:respond-decision':
      return respondDecision(payload, dependencies, runtime, ws, subscriptions)
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
      return executeTool(payload, store, toolRegistry, modelRegistry, dependencies.defaultRuntimeConfig)
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
      return resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
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
        conversationStoreRoot: store.conversationStoreRoot,
        providers: modelRegistry.descriptors(),
        toolProviders: toolRegistry.providerStatuses(),
      }
    }
    case 'speech:authorization':
      return new AzureSpeechService(getEnv()).issueAuthorization()
    case 'file:list': {
      const entries = await files.list(optionalString(payload.threadId))
      return { files: entries, total: entries.length }
    }
    case 'file:delete': {
      const fileId = requiredString(payload, 'fileId')
      const threadId = optionalString(payload.threadId)
      const existing = (await files.list(threadId)).find(file => file.id === fileId)
      const deleted = await files.delete(fileId, threadId)
      if (!deleted) throw new StoreNotFoundError(`文件 '${fileId}' 不存在`)
      if (threadId && existing) await store.recordAttachment(threadId, existing, 'deleted')
      return { deleted: true, id: fileId }
    }
    case 'layer:list':
      return postgis.listLayers(optionalString(payload.sessionId), optionalString(payload.threadId))
    case 'layer:update':
      return postgis.updateLayerMetadata(
        requiredString(payload, 'layerKey'),
        requiredRecord(payload, 'update'),
      )
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
  runtimeConfigDefaults?: AgentRuntimeConfig,
) {
  let runId = optionalString(payload.runId)
  let directRun = false
  if (!runId) {
    const sessionId = requiredString(payload, 'sessionId')
    let threadId = optionalString(payload.threadId)
    if (!threadId) threadId = (await store.createThread(sessionId, `工具：${requiredString(payload, 'toolName')}`)).id
    const created = await store.createRun(sessionId, `执行工具 ${requiredString(payload, 'toolName')}`, {
      threadId,
      modelProvider: modelRegistry.defaultProvider || null,
      runtimeConfigSnapshot: await resolveRuntimeConfig(store, runtimeConfigDefaults),
    })
    runId = created.id
    directRun = true
    await store.updateRunStatus(runId, 'running')
  }
  const run = store.getRun(runId)
  const values = new Map(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
  const context: ToolContext = {
    runId,
    sessionId: run.sessionId,
    threadId: run.threadId,
    runtimeRoot: store.runtimeRoot,
    runtimeConfig: run.runtimeConfigSnapshot ?? await resolveRuntimeConfig(store, runtimeConfigDefaults),
    state: values,
    resolveValueRef: refId => resolveRuntimeValueRef(values, refId),
    resolveMeteorologicalDataset: input => store.resolveMeteorologicalDataset({
      sessionId: run.sessionId,
      threadId: run.threadId,
      datasetId: input.datasetId ?? null,
      filename: input.filename ?? null,
    }),
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
  const callId = makeId('call')
  const itemSink = new ItemSink(item => store.appendItem(item), runId, run.threadId)
  const callItem = itemSink.startItem('function_call', {
    name: toolName,
    callId,
    arguments: JSON.stringify(args),
  })
  try {
    const result = await registry.execute(toolName, args, context)
    await persistToolExecutionResult(store, runId, toolName, args, result)
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: toolName,
      output: JSON.stringify(result.payload),
      metadata: { resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
    })
    const outputItem = itemSink.startItem('function_call_output', {
      callId,
      name: toolName,
      role: 'tool',
      metadata: { resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
    })
    itemSink.completeItem(outputItem.itemId, {
      callId,
      name: toolName,
      output: JSON.stringify(result.payload),
      metadata: { resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [], artifacts: result.artifacts ?? [] },
    })
    if (directRun) await store.completeRun(runId, 'completed')
    return { result, run: store.getRun(runId) }
  } catch (error) {
    const message = formatError(error)
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: toolName,
      body: message,
      isError: true,
    })
    if (directRun) {
      const current = store.getRun(runId)
      await store.updateRunState(runId, { errors: [...current.state.errors, message], failedTool: toolName })
      await store.completeRun(runId, 'failed')
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
  const unsubscribeRun = store.runBus.subscribe(runId, () => void sendSnapshot(ws, runId, store))
  subscriptions.set(runId, () => {
    unsubscribeItem()
    unsubscribeEvent()
    unsubscribeRun()
  })
}

function subscribeToThread(
  ws: WebSocket,
  threadId: string,
  store: PostgresPlatformStore,
  subscriptions: Map<string, () => void>,
): void {
  store.getThread(threadId)
  const key = `thread:${threadId}`
  if (subscriptions.has(key)) return
  const unsubscribeEntry = store.threadEntryBus.subscribe(threadId, entry => send(ws, push('thread.entry', entry)))
  const unsubscribeUpdate = store.threadUpdateBus.subscribe(threadId, update => send(ws, push('thread.updated', update)))
  const unsubscribeCompact = store.threadCompactionBus.subscribe(threadId, record => send(ws, push('thread.compacted', record)))
  const unsubscribeMemory = store.threadMemoryBus.subscribe(threadId, memory => send(ws, push('thread.memory.updated', memory)))
  subscriptions.set(key, () => {
    unsubscribeEntry()
    unsubscribeUpdate()
    unsubscribeCompact()
    unsubscribeMemory()
  })
}

async function snapshot(runId: string, store: PostgresPlatformStore) {
  const [items, events] = await Promise.all([store.listItems(runId), store.listEvents(runId)])
  return { run: store.getRun(runId), items, events }
}

async function respondDecision(
  payload: Record<string, unknown>,
  dependencies: WsDependencies,
  runtime: OpenAIAgentsRuntime,
  ws: WebSocket,
  subscriptions: Map<string, () => void>,
): Promise<AnalysisRun> {
  const { store } = dependencies
  const runId = requiredString(payload, 'runId')
  const decisionId = requiredString(payload, 'decisionId')
  const run = store.getRun(runId)
  const decision = run.state.decisions.find(item => item.decisionId === decisionId)
  if (!decision) throw new Error(`决策 '${decisionId}' 不存在`)
  if (decision.status !== 'pending') return run

  if (decision.kind === 'approval') {
    const approved = selectedApprovalValue(decision, optionalString(payload.optionId))
    const approvalId = typeof decision.payload.approvalId === 'string' ? decision.payload.approvalId : decisionId
    return runtime.resolveApproval(runId, approvalId, approved)
  }

  if (decision.kind === 'clarification') {
    if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)
    const optionId = optionalString(payload.optionId)
    const answer = selectedDecisionText(decision, optionId, optionalString(payload.text))
    await store.updateRunState(runId, {
      decisions: resolveDecision(run.state.decisions, decisionId, 'answered', { optionId, answer }),
      clarification: run.state.clarification && run.state.clarification.clarificationId === decisionId
        ? { ...run.state.clarification, selectedOptionId: optionId ?? 'free_text' }
        : run.state.clarification,
    })
    const config = run.runtimeConfigSnapshot ?? await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
    const provider = requiredRunProvider(run.modelProvider)
    const nextRun = await store.createRun(run.sessionId, answer, {
      threadId: run.threadId,
      modelProvider: provider,
      modelName: run.modelName,
      runtimeConfigSnapshot: config,
    })
    subscribeToRun(ws, nextRun.id, store, subscriptions)
    void runtime.run({
      runId: nextRun.id,
      threadId: run.threadId,
      sessionId: run.sessionId,
      query: answer,
      provider,
      modelName: nextRun.modelName,
      runtimeConfig: config,
      executionMode: run.state.planMode ? 'plan' : 'auto',
      reasoning: true,
    }).then(() => void sendSnapshot(ws, nextRun.id, store))
    return nextRun
  }

  throw new Error(`决策 '${decisionId}' 不能通过 run:respond-decision 提交`)
}

async function sendSnapshot(ws: WebSocket, runId: string, store: PostgresPlatformStore): Promise<void> {
  send(ws, push('run.snapshot', await snapshot(runId, store)))
}

function send(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(message)
}

async function resolveRuntimeConfig(
  store: PostgresPlatformStore,
  fallbackConfig: AgentRuntimeConfig = defaultRuntimeConfig(),
): Promise<AgentRuntimeConfig> {
  const stored = await store.getRuntimeConfig('agent-runtime')
  return stored ? stored as AgentRuntimeConfig : fallbackConfig
}

function makeSummarizer(
  registry: ModelAdapterRegistry,
  config: AgentRuntimeConfig,
  requestedProvider: string | null,
  requestedModel: string | null,
) {
  return async (prompt: string): Promise<string> => {
    const adapter = registry.resolveProvider(requestedProvider ?? config.context.summaryProvider)
    const response = await adapter.chat(prompt, {
      model: requestedModel ?? config.context.summaryModel ?? adapter.subagentModel ?? adapter.defaultModel,
      reasoning: false,
    })
    if (typeof response.content !== 'string' || !response.content.trim()) throw new Error('摘要模型未返回文本')
    return response.content.trim()
  }
}

function makeOptionalStructuredSelector(
  registry: ModelAdapterRegistry,
  config: AgentRuntimeConfig,
  requestedProvider: string | null,
  requestedModel: string | null,
): ((prompt: string) => Promise<Record<string, unknown>>) | undefined {
  if (!requestedProvider && !requestedModel && !config.context.summaryProvider && !registry.defaultProvider) return undefined
  return makeStructuredSelector(registry, config, requestedProvider, requestedModel)
}

function makeStructuredSelector(
  registry: ModelAdapterRegistry,
  config: AgentRuntimeConfig,
  requestedProvider: string | null,
  requestedModel: string | null,
) {
  return async (prompt: string): Promise<Record<string, unknown>> => {
    const provider = requestedProvider ?? config.context.summaryProvider ?? registry.defaultProvider
    if (!provider) throw new Error('未配置记忆选择模型 provider')
    const adapter = registry.resolveProvider(provider)
    const model = requestedModel ?? config.context.summaryModel ?? adapter.subagentModel ?? adapter.defaultModel
    if (!model) throw new Error('未配置记忆选择模型')
    const response = await adapter.chat(prompt, {
      model,
      reasoning: false,
    })
    if (typeof response.content !== 'string' || !response.content.trim()) throw new Error('结构化模型未返回文本')
    return parseStructuredJson(response.content)
  }
}

function parseStructuredJson(value: string): Record<string, unknown> {
  const cleaned = value.trim().replace(/^```json\s*|\s*```$/gu, '')
  const parsed: unknown = JSON.parse(cleaned)
  if (!isRecord(parsed)) throw new Error('结构化模型输出必须是 JSON object')
  return parsed
}

function selectedApprovalValue(decision: DecisionRequest, optionId: string | null): boolean {
  const option = optionId ? decision.options.find(item => item.optionId === optionId) : null
  if (!option) throw new Error('审批决策必须选择批准或拒绝')
  if (typeof option.payload.approved !== 'boolean') throw new Error('审批决策选项缺少 approved payload')
  return option.payload.approved
}

function selectedDecisionText(decision: DecisionRequest, optionId: string | null, text: string | null): string {
  if (text) return text
  const option = optionId ? decision.options.find(item => item.optionId === optionId) : null
  if (option?.label?.trim()) return option.label.trim()
  throw new Error('澄清决策必须选择一个选项或输入补充文本')
}

function resolveDecision(
  decisions: DecisionRequest[],
  decisionId: string,
  status: string,
  payload: Record<string, unknown>,
): DecisionRequest[] {
  const resolvedAt = nowUtc()
  return decisions.map(decision => decision.decisionId === decisionId
    ? { ...decision, status, resolvedAt, payload: { ...decision.payload, ...payload } }
    : decision)
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`)
  return value.trim()
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredRunProvider(value: string | null): string {
  if (!value) throw new Error('运行缺少 modelProvider，不能恢复')
  return value
}

function optionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} 必须为正整数`)
  }
  return value
}

function optionalNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} 必须为非负整数`)
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
