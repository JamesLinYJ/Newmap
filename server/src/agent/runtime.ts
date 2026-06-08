// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 运行时
//
//   文件:       runtime.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../tools.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { AgentRuntimeConfig, AnalysisRun } from '../schemas/types.js'
import { OpenAIProvider, Runner } from '@openai/agents'
import { getEnv } from '../env.js'
import { nowUtc } from '../utils/ids.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import { ItemSink } from '../conversation/itemSink.js'
import { buildSupervisorAgent, drainSdkStream } from './sdkBridge.js'
import { buildContextPacket } from './contextManager.js'
import { buildConversationDigest, type ConversationDigest } from '../conversation/items.js'

export interface RunOptions {
  runId: string
  threadId?: string | null
  sessionId: string
  query: string
  provider: string
  modelName?: string | null
  runtimeConfig: AgentRuntimeConfig
  clarificationOptionId?: string | null
  executionMode?: 'plan' | 'auto'
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
    run.status = 'running'
    run.updatedAt = nowUtc()

    const eventSink = new RunEventSink((event) => this.store.appendEvent(opts.runId, event), opts.runId, opts.threadId ?? null)
    const itemSink = new ItemSink((item) => this.store.appendItem(item), opts.runId, opts.threadId ?? null)
    const state = run.state
    const abortController = new AbortController()
    this.abortControllers.set(opts.runId, abortController)

    itemSink.appendUserMessage(opts.query)
    eventSink.emit('intent.parsed', '开始分析...', {})

    const finalizer = new TurnFinalizer(eventSink, itemSink, (status) => {
      this.store.completeRun(opts.runId, status)
    })

    try {
      // Build context
      const tools = this.toolRegistry.list()
      const toolDescriptions = tools.map(t => `- **${t.label}** (${t.name}): ${t.description}`).join('\n')
      const recentDigests = opts.threadId
        ? this.store.listRunsForThread(opts.threadId)
          .filter((recentRun) => recentRun.id !== opts.runId)
          .map((recentRun) => buildConversationDigest(recentRun.createdAt, recentRun.userQuery, this.store.listItems(recentRun.id)))
          .filter((digest): digest is ConversationDigest => digest !== null)
        : []
      const contextPacket = buildContextPacket(state, opts.runtimeConfig.context, recentDigests, toolDescriptions)
      const contextPrompt = [
        contextPacket.historySummary ? `### 历史摘要\n${contextPacket.historySummary}` : '',
        contextPacket.toolDescriptions ? `### 可用工具\n${contextPacket.toolDescriptions}` : '',
      ].filter(Boolean).join('\n\n')

      const adapter = this.modelRegistry.resolveProvider(opts.provider)
      const capabilities = adapter.agentsSdkCapabilities(opts.modelName)
      if (!capabilities.liveSupervisor) {
        throw new Error(`模型 provider '${opts.provider}' 不支持 Agents SDK live supervisor 主路径`)
      }

      const supervisor = await buildSupervisorAgent({
        registry: this.toolRegistry,
        runtimeConfig: opts.runtimeConfig,
        state,
        eventSink,
        itemSink,
        contextPrompt,
        memoryPrompt: contextPacket.memoryContext,
        toolsToApprove: opts.runtimeConfig.supervisor.approvalInterruptTools,
        toolRuntime: {
          runId: opts.runId,
          threadId: opts.threadId ?? null,
          sessionId: opts.sessionId,
        },
        modelName: opts.modelName ?? adapter.defaultModel,
      })

      const env = getEnv()
      const modelProvider = new OpenAIProvider({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL || undefined,
      })
      const runner = new Runner({
        modelProvider,
        model: opts.modelName ?? adapter.defaultModel ?? undefined,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
      })
      const result = await runner.run(supervisor, opts.query, {
        stream: true,
        maxTurns: opts.runtimeConfig.maxTurns,
        signal: abortController.signal,
        context: {
          runId: opts.runId,
          threadId: opts.threadId ?? null,
          sessionId: opts.sessionId,
        },
      })
      await drainSdkStream(result, itemSink)
      finalizer.complete()

      return this.store.getRun(opts.runId)

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (abortController.signal.aborted) {
        finalizer.cancel()
      } else {
        finalizer.fail(err.message)
      }
      return this.store.getRun(opts.runId)
    } finally {
      this.abortControllers.delete(opts.runId)
    }
  }

  cancel(runId: string): AnalysisRun {
    const controller = this.abortControllers.get(runId)
    if (!controller) {
      const run = this.store.getRun(runId)
      if (run.status !== 'running' && run.status !== 'queued') return run
      throw new Error(`运行 '${runId}' 没有可取消的执行上下文`)
    }
    controller.abort()
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
      const runtimeConfig = run.runtimeConfigSnapshot
      if (!runtimeConfig) throw new Error(`运行 '${runId}' 缺少审批恢复所需的 runtimeConfig`)
      return this.run({
        runId, threadId: run.threadId, sessionId: run.sessionId,
        query: run.userQuery, provider: run.modelProvider ?? 'openai_compatible',
        modelName: run.modelName, runtimeConfig,
      })
    }

    run.status = 'cancelled'
    run.updatedAt = nowUtc()
    return run
  }
}
