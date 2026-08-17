// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久化工具执行器
//
//   文件:       persistentToolExecutor.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 直接工具调用、Automation 工具节点共享的持久执行路径。
// 权限与审批由调用方在进入本模块前完成；本模块只负责工具契约、运行历史和结果事实。

import { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext, ToolResult } from '../framework/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionService } from '../model/modelResultCache.js'
import { runSdkStructuredOutput } from '../model/sdkStructuredOutput.js'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import { scopeRuntimeConfigToPrincipal } from '../security/runtimePrincipalScope.js'
import type { AuthContext } from '../security/types.js'
import type { PersistentToolStore } from '../store/runtimePorts.js'
import type { RuntimeConfigStore } from '../store/postgres/runtimeConfigStore.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { resolveRuntimeValueRef, type ToolResultCommitService } from './resultPersistence.js'
import { resolveRuntimeConfig } from '../ws/runtimeConfig.js'

export interface PersistedToolExecutionInput {
  runId: string
  toolName: string
  args: Record<string, unknown>
  auth: AuthContext
  signal?: AbortSignal
}
export async function executePersistedTool(
  input: PersistedToolExecutionInput,
  deps: {
    store: PersistentToolStore
    runtimeConfiguration: Pick<RuntimeConfigStore, 'getRuntimeConfig'>
    registry: ToolRegistry
    modelRegistry: ModelAdapterRegistry
    modelCompletions?: ModelCompletionService
    resultCommitService: Pick<ToolResultCommitService, 'commit'>
    defaultRuntimeConfig?: AgentRuntimeConfig | undefined
  },
): Promise<ToolResult> {
  const run = deps.store.getRun(input.runId)
  const objectiveRevision = run.state.objectiveRevision
  const values = new Map(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
  const pendingLogWrites: Promise<void>[] = []
  const runtimeConfig = scopeRuntimeConfigToPrincipal(
    deps.store.runtimeRoot,
    run.runtimeConfigSnapshot ?? await resolveRuntimeConfig(deps.runtimeConfiguration, deps.defaultRuntimeConfig),
    input.auth,
  )
  const context: ToolContext = {
    runId: run.id,
    sessionId: run.sessionId,
    threadId: run.threadId,
    signal: input.signal ?? new AbortController().signal,
    runtimeRoot: deps.store.runtimeRoot,
    runtimeConfig,
    auth: input.auth,
    state: values,
    resolveValueRef: refId => resolveRuntimeValueRef(values, refId),
    listMeteorologicalDatasets: datasetInput => deps.store.meteorology.listMeteorologicalDatasets({
      sessionId: run.sessionId,
      threadId: datasetInput?.scope === 'thread' ? run.threadId : null,
      workspaceId: run.workspaceId,
      filename: datasetInput?.filename ?? null,
      ...(datasetInput?.limit === undefined ? {} : { limit: datasetInput.limit }),
    }),
    resolveMeteorologicalDataset: datasetInput => deps.store.meteorology.resolveMeteorologicalDataset({
      sessionId: run.sessionId,
      threadId: datasetInput.selector === 'current_thread_latest' ? run.threadId : null,
      workspaceId: run.workspaceId,
      datasetId: datasetInput.selector === 'explicit_dataset_id' ? datasetInput.datasetId : 'latest_upload',
      filename: datasetInput.selector === 'current_thread_latest' ? datasetInput.filename ?? null : null,
    }),
    resolveMeteorologicalDatasets: datasetIds => deps.store.meteorology.listMeteorologicalDatasets({
      datasetIds,
      workspaceId: run.workspaceId,
      sessionId: run.workspaceId ? null : run.sessionId,
      limit: Math.max(1, datasetIds.length),
    }),
    invokeStructuredModel: async (prompt, schema, options) => {
      const adapter = deps.modelRegistry.resolveProvider(run.modelProvider)
      if (deps.modelCompletions && run.workspaceId) {
        const response = await deps.modelCompletions.completeStructured({
          workspaceId: run.workspaceId,
          runId: run.id,
          provider: adapter.provider,
          model: run.modelName ?? adapter.defaultModel,
          purpose: 'tool_structured_analysis',
          prompt,
          ...(options?.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
          signal: context.signal,
        }, schema)
        await recordModelCompletionUsage(deps.store, run.id, response)
        return response.content
      }
      const modelName = run.modelName ?? adapter.defaultModel
      if (!modelName) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)
      return (await runSdkStructuredOutput(adapter, modelName, prompt, schema, context.signal)).content
    },
    log: (level, message) => {
      pendingLogWrites.push(deps.store.appendEvent(run.id, {
        eventId: makeId('event'),
        runId: run.id,
        threadId: run.threadId,
        type: 'tool.completed',
        message,
        timestamp: nowUtc(),
        payload: { level, toolName: input.toolName, objectiveRevision },
      }))
    },
  }

  const callId = makeId('call')
  const tool = deps.registry.get(input.toolName)
  if (!tool) throw new Error(`工具 '${input.toolName}' 未注册`)
  const itemSink = new ItemSink(item => deps.store.appendItem(item), run.id, run.threadId)
  const callItem = itemSink.startItem('function_call', {
    name: input.toolName,
    callId,
    arguments: JSON.stringify(input.args),
    metadata: { toolLabel: tool.label, objectiveRevision },
  })
  try {
    const result = await deps.registry.execute(input.toolName, input.args, context)
    await deps.resultCommitService.commit({
      runId: run.id,
      toolName: input.toolName,
      toolLabel: tool.label,
      args: input.args,
      result,
      objectiveRevision,
    })
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: input.toolName,
      output: JSON.stringify(result.payload),
      metadata: { toolLabel: tool.label, resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [], objectiveRevision },
    })
    const outputItem = itemSink.startItem('function_call_output', {
      callId,
      name: input.toolName,
      role: 'tool',
      metadata: { toolLabel: tool.label, resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [], objectiveRevision },
    })
    itemSink.completeItem(outputItem.itemId, {
      callId,
      name: input.toolName,
      output: JSON.stringify(result.payload),
      metadata: {
        toolLabel: tool.label,
        resultId: result.resultId,
        source: result.source,
        valueRefs: result.valueRefs ?? [],
        artifacts: result.artifacts ?? [],
        objectiveRevision,
      },
    })
    await Promise.all(pendingLogWrites)
    await itemSink.flush()
    return result
  } catch (error) {
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: input.toolName,
      body: error instanceof Error ? error.message : '工具执行失败。',
      isError: true,
      metadata: { toolLabel: tool.label, objectiveRevision },
    })
    await Promise.allSettled(pendingLogWrites)
    await itemSink.flush()
    throw error
  }
}
