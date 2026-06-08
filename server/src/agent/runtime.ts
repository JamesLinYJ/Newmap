// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 运行时（tool-calling + stream）
//
//   文件:       runtime.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext } from '../framework/types.js'
import type { ModelAdapterRegistry, ChatStreamDelta } from '../model/registry.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { AgentRuntimeConfig, AnalysisRun } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import { ItemSink } from '../conversation/itemSink.js'

const MAX_TOOL_TURNS = 10

interface ChatMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface RunOptions {
  runId: string; threadId?: string | null; sessionId: string
  query: string; provider: string; modelName?: string | null
  runtimeConfig: AgentRuntimeConfig; executionMode?: 'plan' | 'auto'
  reasoning?: boolean
}

export class GeoAgentRuntime {
  private abortControllers = new Map<string, AbortController>()

  constructor(
    private store: PostgresPlatformStore,
    private toolRegistry: ToolRegistry,
    private modelRegistry: ModelAdapterRegistry,
  ) {}

  async run(opts: RunOptions): Promise<AnalysisRun> {
    const run = this.store.getRun(opts.runId)
    run.status = 'running'; run.updatedAt = nowUtc()

    const eventSink = new RunEventSink(
      (e) => this.store.appendEvent(opts.runId, e), opts.runId, opts.threadId ?? null)
    const itemSink = new ItemSink(
      (i) => this.store.appendItem(i), opts.runId, opts.threadId ?? null)
    const finalizer = new TurnFinalizer(eventSink, itemSink,
      (s) => this.store.completeRun(opts.runId, s))
    const abort = new AbortController()
    this.abortControllers.set(opts.runId, abort)

    itemSink.appendUserMessage(opts.query)
    eventSink.emit('intent.parsed', '开始分析...', {})

    try {
      const adapter = this.modelRegistry.resolveProvider(opts.provider)
      if (!adapter.chatStream) throw new Error('当前 provider 不支持 stream')

      const messages: ChatMessage[] = [{ role: 'user', content: opts.query }]
      const tools = buildToolDefs(this.toolRegistry)

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const stream = adapter.chatStream(messages, {
          model: opts.modelName ?? adapter.defaultModel ?? undefined,
          tools, reasoning: opts.reasoning,
        })

        let content = ''
        let finishReason: string | undefined
        const toolCalls: NonNullable<ChatStreamDelta['toolCalls']> = []
        let assistantItemId: string | null = null

        for await (const delta of stream) {
          if (abort.signal.aborted) break

          if (delta.content) {
            content += delta.content
            if (!assistantItemId) {
              assistantItemId = itemSink.startItem('message', { role: 'assistant' }).itemId
            }
            itemSink.deltaItem(assistantItemId, delta.content)
          }

          if (delta.toolCalls) {
            for (const tc of delta.toolCalls) {
              const existing = toolCalls.find(t => t.index === tc.index)
              if (existing) {
                existing.name += tc.name
                existing.arguments += tc.arguments
              } else {
                toolCalls.push({ ...tc })
              }
            }
          }

          if (delta.finishReason) finishReason = delta.finishReason
          if (finishReason === 'tool_calls' || finishReason === 'stop') break
        }


        if (content && finishReason !== 'tool_calls') {
          if (assistantItemId) itemSink.completeItem(assistantItemId, { body: content })
          eventSink.emit('run.completed', content, {})
          finalizer.complete()
          return this.store.getRun(opts.runId)
        }

        if (toolCalls.length > 0) {
          const ctx: ToolContext = {
            runId: opts.runId, sessionId: opts.sessionId, threadId: opts.threadId ?? null,
            state: new Map(),
            log: (l, m) => eventSink.emit('tool.completed', m, { level: l }),
          }

          // Record assistant message with tool calls
          const assistantMsg: ChatMessage = {
            role: 'assistant', content: content || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id || makeId('call'), type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
          messages.push(assistantMsg)

          // Execute each tool
          for (const tc of toolCalls) {
            eventSink.emit('tool.started', `${tc.name}`, { tool: tc.name })
            let args: Record<string, unknown> = {}
            try { args = JSON.parse(tc.arguments || '{}') as Record<string, unknown> } catch { /* */ }
            const result = await this.toolRegistry.execute(tc.name, args, ctx)
            eventSink.emit('tool.completed', result.message, { tool: tc.name, result: result.payload })
            messages.push({ role: 'tool', content: JSON.stringify(result.payload), tool_call_id: tc.id })
          }

          // Close assistant item if partial text was shown
          if (assistantItemId) {
            itemSink.completeItem(assistantItemId, { body: content || '(调用工具...)' })
          }
          continue // loop back with tool results
        }

        // No tool calls and no text — shouldn't happen
        break
      }

      finalizer.complete()
      return this.store.getRun(opts.runId)

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[runtime] run failed:', err.message)
      if (abort.signal.aborted) finalizer.cancel()
      else finalizer.fail(err.message)
      return this.store.getRun(opts.runId)
    } finally {
      this.abortControllers.delete(opts.runId)
    }
  }

  cancel(runId: string): AnalysisRun {
    const c = this.abortControllers.get(runId)
    if (!c) throw new Error(`运行 '${runId}' 不可取消`)
    c.abort()
    return this.store.completeRun(runId, 'cancelled')
  }

  async resolveApproval(runId: string, approvalId: string, approved: boolean): Promise<AnalysisRun> {
    const run = this.store.getRun(runId)
    const approval = run.state.approvals?.find(a => a.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    approval.status = approved ? 'approved' : 'rejected'
    approval.resolvedAt = nowUtc()
    this.store.updateRunState(runId, { approvals: run.state.approvals })
    if (approved) {
      return this.run({
        runId, threadId: run.threadId, sessionId: run.sessionId,
        query: run.userQuery, provider: run.modelProvider ?? 'openai_compatible',
        modelName: run.modelName, runtimeConfig: {} as AgentRuntimeConfig,
      })
    }
    run.status = 'cancelled'; run.updatedAt = nowUtc()
    return run
  }
}

function buildToolDefs(registry: ToolRegistry) {
  return registry.list().map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema || { type: 'object', properties: {} },
    },
  }))
}
