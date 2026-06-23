// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行与持久化协调器
//
//   文件:       toolExecutionCoordinator.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext, ToolResult } from '../framework/types.js'
import type { ModelAdapter } from '../model/registry.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from '../tools/resultPersistence.js'
import { makeId } from '../utils/ids.js'
import { ItemSink } from '../conversation/itemSink.js'
import { RunEventSink } from './turnRunner.js'

interface CoordinatorOptions {
  store: PostgresPlatformStore
  registry: ToolRegistry
  adapter: ModelAdapter | null
  runId: string
  sessionId: string
  threadId: string
  turnId: string
  modelName?: string | null
  inlineToolResultMaxChars: number
  eventSink: RunEventSink
  itemSink: ItemSink
  valueState: Map<string, unknown>
}

// ToolExecutionCoordinator
//
// 自动 Agent 工具与确定性领域链共享这一执行路径；prepared 之后的每个状态
// 都先落盘再推进，未知副作用状态不会被包装成成功结果。
export class ToolExecutionCoordinator {
  private readonly preparedCalls = new Set<string>()
  private readonly callItems = new Map<string, string>()

  constructor(private readonly options: CoordinatorOptions) {}

  async prepare(toolName: string, args: Record<string, unknown>, callId: string): Promise<void> {
    if (this.preparedCalls.has(callId)) return
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    const existing = (await this.options.store.activeTranscript(this.options.threadId))
      .some(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (existing) {
      this.preparedCalls.add(callId)
      return
    }
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_call',
      payload: { callId, name: toolName, arguments: args, ledgerStatus: 'prepared' },
    })
    await this.options.store.conversationStore.saveRun(this.options.store.getRun(this.options.runId), {
      pendingToolCallIds: [callId],
      recoveryStatus: 'requires_action',
    })
    const item = this.options.itemSink.startItem('function_call', {
      name: toolName,
      callId,
      arguments: JSON.stringify(args),
    })
    this.preparedCalls.add(callId)
    this.callItems.set(callId, item.itemId)
  }

  async executeForModel(toolName: string, args: Record<string, unknown>, callId: string): Promise<string> {
    const result = await this.execute(toolName, args, callId)
    if (toolName === 'answer_nowcast_question' && typeof result.payload.answer === 'string') {
      return result.payload.answer
    }
    return JSON.stringify({
      message: result.message,
      payload: result.payload,
      valueRefs: (result.valueRefs ?? []).map(ref => ({ refId: ref.refId, kind: ref.kind, label: ref.label })),
    })
  }

  async executeDirect(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const callId = makeId('call')
    await this.prepare(toolName, args, callId)
    return this.execute(toolName, args, callId)
  }

  private async execute(toolName: string, args: Record<string, unknown>, callId: string): Promise<ToolResult> {
    await this.prepare(toolName, args, callId)
    const itemId = this.callItems.get(callId)
    try {
      await this.appendLedger(callId, toolName, 'started')
      this.options.eventSink.emit('tool.started', toolName, { tool: toolName, callId })
      const result = await this.options.registry.execute(toolName, args, this.createToolContext())
      await persistToolExecutionResult(this.options.store, this.options.runId, toolName, args, result)
      for (const ref of result.valueRefs ?? []) this.options.valueState.set(ref.refId, ref)
      this.options.eventSink.emit('tool.completed', result.message, { tool: toolName, callId, result: result.payload })
      if (itemId) {
        this.options.itemSink.completeItem(itemId, {
          callId,
          name: toolName,
          output: JSON.stringify(result.payload),
          metadata: { resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
        })
      }
      const outputItemId = this.options.itemSink.startItem('function_call_output', {
        callId,
        name: toolName,
        role: 'tool',
        metadata: { resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
      }).itemId
      this.options.itemSink.completeItem(outputItemId, {
        callId,
        name: toolName,
        output: JSON.stringify(result.payload),
        metadata: { resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [], artifacts: result.artifacts ?? [] },
      })
      await this.appendToolResult(callId, toolName, result)
      await this.options.store.conversationStore.saveRun(this.options.store.getRun(this.options.runId), {
        pendingToolCallIds: [],
        recoveryStatus: 'clean',
      })
      return result
    } catch (error) {
      const message = errorMessage(error)
      await this.appendLedger(callId, toolName, 'failed', message)
      if (itemId) this.options.itemSink.completeItem(itemId, { callId, name: toolName, isError: true, body: message })
      // started 后失败是已知终态，可以清理 pending；进程直接崩溃时不会执行到这里。
      await this.options.store.conversationStore.saveRun(this.options.store.getRun(this.options.runId), {
        pendingToolCallIds: [],
        recoveryStatus: 'clean',
      })
      throw error
    }
  }

  private createToolContext(): ToolContext {
    return {
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      threadId: this.options.threadId,
      state: this.options.valueState,
      resolveValueRef: refId => resolveRuntimeValueRef(this.options.valueState, refId),
      invokeStructuredModel: prompt => {
        if (!this.options.adapter) throw new Error('当前确定性工具链未配置结构化模型调用')
        return invokeStructuredModel(this.options.adapter, prompt, this.options.modelName)
      },
      log: (level, message) => this.options.eventSink.emit('tool.completed', message, { level }),
    }
  }

  private async appendToolResult(callId: string, toolName: string, result: ToolResult): Promise<void> {
    const content = JSON.stringify({
      message: result.message,
      payload: result.payload,
      valueRefs: (result.valueRefs ?? []).map(ref => ({ refId: ref.refId, kind: ref.kind, label: ref.label })),
    })
    const contentRef = content.length > this.options.inlineToolResultMaxChars
      ? await this.options.store.conversationStore.putObject(content, 'application/json')
      : null
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId,
        name: toolName,
        summary: result.message,
        content: contentRef ? null : content,
        contentRef,
        ledgerStatus: 'completed',
        resultId: result.resultId,
      },
    })
  }

  private async appendLedger(
    callId: string,
    toolName: string,
    ledgerStatus: 'started' | 'failed',
    error?: string,
  ): Promise<void> {
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'checkpoint',
      payload: { callId, name: toolName, ledgerStatus, error: error ?? null },
    })
  }
}

async function invokeStructuredModel(
  adapter: ModelAdapter,
  prompt: string,
  modelName?: string | null,
): Promise<Record<string, unknown>> {
  const response = await adapter.chat(prompt, { model: modelName ?? adapter.defaultModel, reasoning: false })
  const content = response.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回结构化内容')
  const cleaned = content.replace(/^```json\s*|\s*```$/gu, '')
  const parsed: unknown = JSON.parse(cleaned)
  if (!isRecord(parsed)) throw new Error('模型结构化输出必须是 JSON object')
  return parsed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
