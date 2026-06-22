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
import type { ToolContext, ToolResult, ValueRef } from '../framework/types.js'
import type { ModelAdapterRegistry, ChatStreamDelta } from '../model/registry.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { AgentRuntimeConfig, AnalysisRun } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import { ItemSink } from '../conversation/itemSink.js'
import { resolveArguments } from '../model/providers/openaiCompatible.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from '../tools/resultPersistence.js'
import { buildSystemPrompt } from './prompts.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import {
  assembleThreadContext,
  compactThreadIfNeeded,
  rebuildThreadMemory,
  type ConversationChatMessage,
} from './contextManager.js'

const MAX_TOOL_TURNS = 10
const METEOROLOGICAL_FILE_SUFFIXES = ['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5', '.bz2']

type ChatMessage = ConversationChatMessage

export interface RunOptions {
  runId: string; threadId?: string | null; sessionId: string
  query: string; provider: string; modelName?: string | null
  runtimeConfig: AgentRuntimeConfig; executionMode?: 'plan' | 'auto'
  reasoning?: boolean; resume?: boolean
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
    await this.store.updateRunStatus(opts.runId, 'running')

    const eventSink = new RunEventSink(
      (e) => this.store.appendEvent(opts.runId, e), opts.runId, opts.threadId ?? null)
    const itemSink = new ItemSink(
      (i) => this.store.appendItem(i), opts.runId, opts.threadId ?? null)
    const finalizer = new TurnFinalizer(eventSink, itemSink,
      (s) => this.store.completeRun(opts.runId, s))
    const abort = new AbortController()
    this.abortControllers.set(opts.runId, abort)
    const valueState = new Map<string, unknown>(run.state.toolValueRefs.map(ref => [ref.refId, ref]))

    const turnId = makeId('turn')
    if (!opts.resume) {
      if (!opts.threadId) throw new Error('连续对话运行必须属于 thread')
      const userEntry = await this.store.appendTranscript({
        threadId: opts.threadId,
        runId: opts.runId,
        turnId,
        kind: 'message',
        payload: { role: 'user', content: opts.query },
      })
      itemSink.appendUserMessage(opts.query, { transcriptEntryId: userEntry.entryId })
      eventSink.emit('intent.parsed', '开始分析...', {})
    }

    try {
      // 杭州短临标准问答是确定性交付边界。线程中已有气象产品时，
      // 运行时直接执行 valueRef 工具链，避免模型绕过工具后返回泛化追问。
      if (!opts.resume && await this.shouldRunDeterministicNowcast(opts.query, opts.threadId ?? null)) {
        await this.runDeterministicNowcast(opts, eventSink, itemSink, valueState, turnId)
        await finalizer.complete()
        return this.store.getRun(opts.runId)
      }

      const adapter = this.modelRegistry.resolveProvider(opts.provider)
      if (!adapter.chatStream) throw new Error('当前 provider 不支持 stream')
      const contextConfig = {
        ...opts.runtimeConfig.context,
        contextWindowTokens: adapter.contextWindowTokens ?? opts.runtimeConfig.context.contextWindowTokens,
      }

      const tools = buildToolDefs(this.toolRegistry)
      const toolDescriptions = this.toolRegistry.list()
        .map(tool => `- ${tool.name}: ${tool.description}`)
        .join('\n')
      if (!opts.threadId) throw new Error('连续对话运行必须属于 thread')
      const summarize = async (prompt: string) => {
        const summaryAdapter = this.modelRegistry.resolveProvider(opts.runtimeConfig.context.summaryProvider ?? opts.provider)
        const response = await summaryAdapter.chat(prompt, {
          model: opts.runtimeConfig.context.summaryModel
            ?? summaryAdapter.subagentModel
            ?? opts.modelName
            ?? summaryAdapter.defaultModel,
          reasoning: false,
        })
        if (typeof response.content !== 'string') throw new Error('摘要模型未返回文本')
        return response.content
      }
      await compactThreadIfNeeded(this.store, opts.threadId, contextConfig, summarize)
      await rebuildThreadMemory(this.store, opts.threadId, contextConfig, summarize, false, opts.runId)
      const systemPrompt = buildSystemPrompt(opts.runtimeConfig, run.state, toolDescriptions, '', '')
      const assembled = await assembleThreadContext(this.store, opts.threadId, contextConfig, systemPrompt)
      const messages: ChatMessage[] = assembled.messages
      await this.store.updateRunState(opts.runId, {
        runtimeStats: {
          ...run.state.runtimeStats,
          contextEstimatedTokens: assembled.report.estimatedTokens,
          contextUsagePermille: Math.round(assembled.report.usageRatio * 1000),
        },
      })

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        let content = ''
        let reasoningContent = ''
        let finishReason: string | undefined
        const toolCalls: Array<{ id: string; index: number; name: string; arguments: string; argumentFragments: string[] }> = []
        let assistantItemId: string | null = null
        let reasoningItemId: string | null = null
        let streamAttempt = 0
        let latestUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null

        // 上游在首个有效片段前断流时允许重试一次；一旦 UI 已收到内容就必须硬失败，
        // 否则重放模型流会制造重复回答或重复工具调用。
        while (true) {
          let emittedSemanticDelta = false
          try {
            const stream = adapter.chatStream(messages, {
              model: opts.modelName ?? adapter.defaultModel ?? undefined,
              tools, reasoning: opts.reasoning,
            })

            for await (const delta of stream) {
              if (abort.signal.aborted) break
              emittedSemanticDelta ||= Boolean(delta.reasoningContent || delta.content || delta.toolCalls?.length || delta.finishReason)

              if (delta.reasoningContent) {
                reasoningContent += delta.reasoningContent
                if (!reasoningItemId) {
                  reasoningItemId = itemSink.startItem('reasoning', { role: 'assistant' }).itemId
                }
                itemSink.deltaItem(reasoningItemId, delta.reasoningContent)
              }

              if (delta.content) {
                content += delta.content
              }

              if (delta.toolCalls) {
                toolCalls.length = 0
                toolCalls.push(...delta.toolCalls.map(tc => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                  index: tc.index ?? 0,
                  argumentFragments: [tc.arguments],
                })))
              }

              if (delta.finishReason) finishReason = delta.finishReason
              if (delta.usage) latestUsage = delta.usage
              if (finishReason === 'tool_calls' || finishReason === 'stop') break
            }
            break
          } catch (error) {
            if (streamAttempt === 0 && !emittedSemanticDelta && isTransientModelConnectionError(error)) {
              streamAttempt += 1
              console.warn('[runtime] transient model stream failure, retrying once:', rawErrorMessage(error))
              continue
            }
            throw new Error(formatRuntimeError(error))
          }
        }

        if (abort.signal.aborted) throw new Error('运行已中断')

        if (latestUsage) {
          const current = this.store.getRun(opts.runId)
          await this.store.updateRunState(opts.runId, {
            runtimeStats: {
              ...current.state.runtimeStats,
              modelInputTokens: latestUsage.inputTokens,
              modelOutputTokens: latestUsage.outputTokens,
              modelTotalTokens: latestUsage.totalTokens,
            },
          })
        }

        // Complete reasoning item if any
        if (reasoningItemId && reasoningContent) {
          itemSink.completeItem(reasoningItemId, { body: reasoningContent })
        }

        if (content && finishReason !== 'tool_calls') {
          assistantItemId = itemSink.startItem('message', { role: 'assistant' }).itemId
          const assistantEntry = await this.store.appendTranscript({
            threadId: opts.threadId,
            runId: opts.runId,
            turnId,
            kind: 'message',
            payload: { role: 'assistant', content },
          })
          itemSink.completeItem(assistantItemId, {
            body: content,
            metadata: { transcriptEntryId: assistantEntry.entryId },
          })
          await finalizer.complete()
          return this.store.getRun(opts.runId)
        }

        if (toolCalls.length > 0) {
          // 普通 assistant content 与 provider reasoning_content 是两条边界：
          // 前者是模型显式输出给用户的过程说明，后者才允许进入“思考过程”折叠区。
          if (content) {
            itemSink.appendAssistantMessage(content, { messageKind: 'commentary' })
          }

          const ctx: ToolContext = {
            runId: opts.runId, sessionId: opts.sessionId, threadId: opts.threadId ?? null,
            state: valueState,
            resolveValueRef: refId => resolveRuntimeValueRef(valueState, refId),
            invokeStructuredModel: prompt => invokeStructuredModel(adapter, prompt, opts.modelName),
            log: (l, m) => eventSink.emit('tool.completed', m, { level: l }),
          }

          // Record assistant message with tool calls
          const assistantMsg: ChatMessage = {
            role: 'assistant', content: content || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id || makeId('call'), type: 'function' as const,
              function: { name: tc.name, arguments: resolveArguments(tc.argumentFragments) },
            })),
          }
          messages.push(assistantMsg)

          // Execute each tool
          let toolCallPosition = 0
          for (const tc of toolCalls) {
            const argsRaw = resolveArguments(tc.argumentFragments) || '{}'
            let parsedArgs: unknown
            try {
              parsedArgs = JSON.parse(argsRaw)
            } catch (e) {
              console.error('[runtime] tool args parse error:', e instanceof Error ? e.message : e, '| args:', argsRaw.slice(0, 200))
              throw e
            }
            if (!isRecord(parsedArgs)) throw new Error(`工具 "${tc.name}" 参数必须为 JSON object`)
            const args = parsedArgs
            const tool = this.toolRegistry.get(tc.name)

            await this.store.appendTranscript({
              threadId: opts.threadId,
              runId: opts.runId,
              turnId,
              kind: 'tool_call',
              payload: {
                callId: tc.id,
                name: tc.name,
                arguments: args,
                assistantContent: toolCallPosition === 0 ? content || null : null,
                ledgerStatus: 'prepared',
              },
            })
            await this.store.conversationStore.saveRun(this.store.getRun(opts.runId), {
              pendingToolCallIds: [tc.id],
              recoveryStatus: 'requires_action',
            })
            toolCallPosition += 1

            // Record function_call item for frontend visibility
            const callItemId = itemSink.startItem('function_call', {
              name: tc.name,
              callId: tc.id,
              arguments: argsRaw,
            }).itemId

            const approval = approvalBoundary(run, tc.name, args, opts.runtimeConfig, tool?.isDestructive === true)
            if (approval === 'required') {
              itemSink.completeItem(callItemId, { isError: true, body: '需要审批' })
              const request = {
                approvalId: makeId('approval'),
                action: tc.name,
                title: `批准执行：${tool?.label ?? tc.name}`,
                description: tool?.description ?? `工具 ${tc.name} 需要审批`,
                status: 'pending',
                artifactId: null,
                payload: {
                  toolName: tc.name,
                  args,
                  callId: tc.id,
                  turnId,
                  consumed: false,
                },
                createdAt: nowUtc(),
                resolvedAt: null,
              }
              await this.store.updateRunState(opts.runId, { approvals: [...run.state.approvals, request] })
              eventSink.emit('approval.required', request.title, { approvalId: request.approvalId, tool: tc.name })
              itemSink.appendResult('waiting_approval', { approvalId: request.approvalId, tool: tc.name })
              await this.store.completeRun(opts.runId, 'waiting_approval')
              return this.store.getRun(opts.runId)
            }
            if (approval) {
              approval.payload.consumed = true
              await this.store.updateRunState(opts.runId, { approvals: run.state.approvals })
            }
            let result: ToolResult
            try {
              await this.appendToolLedgerCheckpoint(opts.threadId, opts.runId, turnId, tc.id, tc.name, 'started')
              eventSink.emit('tool.started', `${tc.name}`, { tool: tc.name })
              result = await this.toolRegistry.execute(tc.name, args, ctx)
            } catch (error) {
              const message = rawErrorMessage(error)
              await this.appendToolLedgerCheckpoint(opts.threadId, opts.runId, turnId, tc.id, tc.name, 'failed', message)
              await this.store.conversationStore.saveRun(this.store.getRun(opts.runId), {
                pendingToolCallIds: [],
                recoveryStatus: 'clean',
              })
              itemSink.completeItem(callItemId, { callId: tc.id, name: tc.name, isError: true, body: message })
              throw error
            }
            await persistToolExecutionResult(this.store, opts.runId, tc.name, args, result)
            for (const ref of result.valueRefs ?? []) valueState.set(ref.refId, ref)
            eventSink.emit('tool.completed', result.message, { tool: tc.name, result: result.payload })

            // Complete function_call item
            itemSink.completeItem(callItemId, {
              callId: tc.id,
              name: tc.name,
              output: JSON.stringify(result.payload),
              metadata: { resultId: result.resultId, source: result.source },
            })
            // Create function_call_output item for tool result
            const outputItemId = itemSink.startItem('function_call_output', {
              callId: tc.id,
              name: tc.name,
              role: 'tool',
              metadata: { resultId: result.resultId, source: result.source },
            }).itemId
            itemSink.completeItem(outputItemId, {
              callId: tc.id,
              name: tc.name,
              output: JSON.stringify(result.payload),
              metadata: { resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [] },
            })

            messages.push({
              role: 'tool',
              content: JSON.stringify({
                message: result.message,
                payload: result.payload,
                valueRefs: (result.valueRefs ?? []).map(ref => ({ refId: ref.refId, kind: ref.kind, label: ref.label })),
              }),
              tool_call_id: tc.id,
            })

            await this.appendToolResultTranscript(
              opts.threadId,
              opts.runId,
              turnId,
              tc.id,
              tc.name,
              result,
              opts.runtimeConfig.context.inlineToolResultMaxChars,
            )
            await this.store.conversationStore.saveRun(this.store.getRun(opts.runId), {
              pendingToolCallIds: [],
              recoveryStatus: 'clean',
            })

            // 短临回答由确定性领域服务生成，是用户可见交付边界；模型不得再次改写事实措辞。
            if (tc.name === 'answer_nowcast_question' && typeof result.payload.answer === 'string') {
              const answer = result.payload.answer
              const answerEntry = await this.store.appendTranscript({
                threadId: opts.threadId,
                runId: opts.runId,
                turnId,
                kind: 'message',
                payload: { role: 'assistant', content: answer },
              })
              itemSink.appendAssistantMessage(answer, { transcriptEntryId: answerEntry.entryId })
              await finalizer.complete()
              return this.store.getRun(opts.runId)
            }
          }

          // Close assistant item if partial text was shown
          if (assistantItemId) {
            itemSink.completeItem(assistantItemId, { body: content || '(调用工具...)' })
          }
          continue // loop back with tool results
        }

        throw new Error('模型未返回文本或工具调用')
      }

      throw new Error(`工具调用超过最大轮次 ${MAX_TOOL_TURNS}`)

    } catch (error) {
      const message = formatRuntimeError(error)
      console.error('[runtime] run failed:', message)
      if (abort.signal.aborted) await finalizer.cancel()
      else {
        const current = this.store.getRun(opts.runId)
        await this.store.updateRunState(opts.runId, { errors: [...current.state.errors, message] })
        await finalizer.fail(message)
      }
      return this.store.getRun(opts.runId)
    } finally {
      this.abortControllers.delete(opts.runId)
    }
  }

  private async shouldRunDeterministicNowcast(query: string, threadId: string | null): Promise<boolean> {
    if (!threadId || !isNowcastQuestion(query)) return false
    const files = await new RuntimeFileStore(this.store.runtimeRoot).list(threadId)
    return files.some(file => METEOROLOGICAL_FILE_SUFFIXES.some(suffix => file.name.toLowerCase().endsWith(suffix)))
  }

  // runDeterministicNowcast
  //
  // 标准短临链只传递运行时生成的 valueRef；任何缺失引用或工具错误都会硬失败。
  private async runDeterministicNowcast(
    opts: RunOptions,
    eventSink: RunEventSink,
    itemSink: ItemSink,
    valueState: Map<string, unknown>,
    turnId: string,
  ): Promise<void> {
    const ctx: ToolContext = {
      runId: opts.runId,
      sessionId: opts.sessionId,
      threadId: opts.threadId ?? null,
      state: valueState,
      resolveValueRef: refId => resolveRuntimeValueRef(valueState, refId),
      invokeStructuredModel: async () => {
        throw new Error('确定性短临工具链不得调用模型生成事实')
      },
      log: (level, message) => eventSink.emit('tool.completed', message, { level }),
    }

    const listed = await this.executeTracedTool('list_meteorological_files', {}, ctx, eventSink, itemSink, valueState, turnId)
    const collectionRef = requiredResultRef(listed, ['meteorological_file_collection'])
    const files = isRecord(collectionRef.value) && Array.isArray(collectionRef.value.files) ? collectionRef.value.files : []
    if (files.length < 2) throw new Error(`杭州短临分析至少需要两个气象文件，当前线程找到 ${files.length} 个`)

    const sequence = await this.executeTracedTool(
      'create_nowcast_sequence',
      { file_collection_ref: collectionRef.refId },
      ctx,
      eventSink,
      itemSink,
      valueState,
      turnId,
    )
    const sequenceRef = requiredResultRef(sequence, ['nowcast_sequence'])

    const prepared = await this.executeTracedTool(
      'prepare_hangzhou_nowcast_scope',
      { question: opts.query },
      ctx,
      eventSink,
      itemSink,
      valueState,
      turnId,
    )
    const scopeRef = requiredResultRef(prepared, ['nowcast_area', 'nowcast_coordinate', 'bbox'])

    const analyzed = await this.executeTracedTool(
      'analyze_nowcast_precipitation',
      { sequence_ref: sequenceRef.refId, scope_ref: scopeRef.refId },
      ctx,
      eventSink,
      itemSink,
      valueState,
      turnId,
    )
    const analysisRef = requiredResultRef(analyzed, ['nowcast_analysis'])

    const answered = await this.executeTracedTool(
      'answer_nowcast_question',
      { nowcast_analysis_ref: analysisRef.refId, question: opts.query },
      ctx,
      eventSink,
      itemSink,
      valueState,
      turnId,
    )
    if (typeof answered.payload.answer !== 'string' || !answered.payload.answer.trim()) {
      throw new Error('短临回答工具未返回可交付文本')
    }
    const answer = answered.payload.answer.trim()
    if (!opts.threadId) throw new Error('短临运行缺少 threadId')
    const answerEntry = await this.store.appendTranscript({
      threadId: opts.threadId,
      runId: opts.runId,
      turnId,
      kind: 'message',
      payload: { role: 'assistant', content: answer },
    })
    itemSink.appendAssistantMessage(answer, { transcriptEntryId: answerEntry.entryId })
  }

  // executeTracedTool
  //
  // 确定性工具链与模型工具调用共享相同的 UI 时间线和持久化语义。
  private async executeTracedTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    eventSink: RunEventSink,
    itemSink: ItemSink,
    valueState: Map<string, unknown>,
    turnId: string,
  ): Promise<ToolResult> {
    const callId = makeId('call')
    const callItemId = itemSink.startItem('function_call', {
      name: toolName,
      callId,
      arguments: JSON.stringify(args),
    }).itemId

    try {
      if (!ctx.threadId) throw new Error('工具链缺少 threadId')
      await this.store.appendTranscript({
        threadId: ctx.threadId,
        runId: ctx.runId,
        turnId,
        kind: 'tool_call',
        payload: { callId, name: toolName, arguments: args, ledgerStatus: 'prepared' },
      })
      await this.store.conversationStore.saveRun(this.store.getRun(ctx.runId), {
        pendingToolCallIds: [callId],
        recoveryStatus: 'requires_action',
      })
      await this.appendToolLedgerCheckpoint(ctx.threadId, ctx.runId, turnId, callId, toolName, 'started')
      eventSink.emit('tool.started', toolName, { tool: toolName })
      const result = await this.toolRegistry.execute(toolName, args, ctx)
      await persistToolExecutionResult(this.store, ctx.runId, toolName, args, result)
      for (const ref of result.valueRefs ?? []) valueState.set(ref.refId, ref)
      eventSink.emit('tool.completed', result.message, { tool: toolName, result: result.payload })
      itemSink.completeItem(callItemId, {
        callId,
        name: toolName,
        output: JSON.stringify(result.payload),
        metadata: { resultId: result.resultId, source: result.source },
      })
      const outputItemId = itemSink.startItem('function_call_output', {
        callId,
        name: toolName,
        role: 'tool',
        metadata: { resultId: result.resultId, source: result.source },
      }).itemId
      itemSink.completeItem(outputItemId, {
        callId,
        name: toolName,
        output: JSON.stringify(result.payload),
        metadata: { resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [] },
      })
      await this.appendToolResultTranscript(
        ctx.threadId,
        ctx.runId,
        turnId,
        callId,
        toolName,
        result,
        this.store.getRun(ctx.runId).runtimeConfigSnapshot?.context.inlineToolResultMaxChars ?? 12000,
      )
      await this.store.conversationStore.saveRun(this.store.getRun(ctx.runId), {
        pendingToolCallIds: [],
        recoveryStatus: 'clean',
      })
      return result
    } catch (error) {
      if (ctx.threadId) {
        await this.appendToolLedgerCheckpoint(ctx.threadId, ctx.runId, turnId, callId, toolName, 'failed', rawErrorMessage(error))
        await this.store.conversationStore.saveRun(this.store.getRun(ctx.runId), {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
      }
      itemSink.completeItem(callItemId, {
        callId,
        name: toolName,
        isError: true,
        body: rawErrorMessage(error),
      })
      throw error
    }
  }

  private async appendToolResultTranscript(
    threadId: string,
    runId: string,
    turnId: string,
    callId: string,
    toolName: string,
    result: ToolResult,
    inlineMaxChars: number,
  ): Promise<void> {
    const content = JSON.stringify({
      message: result.message,
      payload: result.payload,
      valueRefs: (result.valueRefs ?? []).map(ref => ({ refId: ref.refId, kind: ref.kind, label: ref.label })),
    })
    const contentRef = content.length > inlineMaxChars
      ? await this.store.conversationStore.putObject(content, 'application/json')
      : null
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
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

  // appendToolLedgerCheckpoint
  //
  // 工具副作用状态只通过追加记录前进；started 且无终态的调用在重启后必须人工处理。
  private async appendToolLedgerCheckpoint(
    threadId: string,
    runId: string,
    turnId: string,
    callId: string,
    toolName: string,
    ledgerStatus: 'started' | 'failed',
    error?: string,
  ): Promise<void> {
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'checkpoint',
      payload: { callId, name: toolName, ledgerStatus, error: error ?? null },
    })
  }

  async cancel(runId: string): Promise<AnalysisRun> {
    const c = this.abortControllers.get(runId)
    if (!c) throw new Error(`运行 '${runId}' 不可取消`)
    c.abort()
    return this.store.updateRunStatus(runId, 'cancelled')
  }

  async resolveApproval(runId: string, approvalId: string, approved: boolean): Promise<AnalysisRun> {
    const run = this.store.getRun(runId)
    const approval = run.state.approvals?.find(a => a.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    if (approval.payload.consumed === true) return run
    approval.status = approved ? 'approved' : 'rejected'
    approval.resolvedAt = nowUtc()
    await this.store.updateRunState(runId, { approvals: run.state.approvals })
    if (approved) {
      if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot，无法恢复审批`)
      if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId，无法恢复审批`)
      const toolName = stringPayload(approval.payload, 'toolName')
      const callId = stringPayload(approval.payload, 'callId')
      const turnId = stringPayload(approval.payload, 'turnId')
      const args = recordPayload(approval.payload, 'args')
      const adapter = this.modelRegistry.resolveProvider(run.modelProvider ?? 'openai_compatible')
      const eventSink = new RunEventSink((event) => this.store.appendEvent(runId, event), runId, run.threadId)
      const itemSink = new ItemSink((item) => this.store.appendItem(item), runId, run.threadId)
      const valueState = new Map<string, unknown>(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
      const ctx: ToolContext = {
        runId,
        sessionId: run.sessionId,
        threadId: run.threadId,
        state: valueState,
        resolveValueRef: refId => resolveRuntimeValueRef(valueState, refId),
        invokeStructuredModel: prompt => invokeStructuredModel(adapter, prompt, run.modelName),
        log: (level, message) => eventSink.emit('tool.completed', message, { level }),
      }
      const callItemId = itemSink.startItem('function_call', {
        name: toolName,
        callId,
        arguments: JSON.stringify(args),
        metadata: { approvalId, resumedFromApproval: true },
      }).itemId

      try {
        await this.store.updateRunStatus(runId, 'running')
        await this.appendToolLedgerCheckpoint(run.threadId, runId, turnId, callId, toolName, 'started')
        eventSink.emit('tool.started', toolName, { tool: toolName, approvalId })
        const result = await this.toolRegistry.execute(toolName, args, ctx)
        await persistToolExecutionResult(this.store, runId, toolName, args, result)
        for (const ref of result.valueRefs ?? []) valueState.set(ref.refId, ref)
        eventSink.emit('tool.completed', result.message, { tool: toolName, result: result.payload, approvalId })
        itemSink.completeItem(callItemId, {
          callId,
          name: toolName,
          output: JSON.stringify(result.payload),
          metadata: { resultId: result.resultId, source: result.source, approvalId },
        })
        const outputItemId = itemSink.startItem('function_call_output', {
          callId,
          name: toolName,
          role: 'tool',
          metadata: { resultId: result.resultId, source: result.source, approvalId },
        }).itemId
        itemSink.completeItem(outputItemId, {
          callId,
          name: toolName,
          output: JSON.stringify(result.payload),
          metadata: { resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [], approvalId },
        })
        await this.appendToolResultTranscript(
          run.threadId,
          runId,
          turnId,
          callId,
          toolName,
          result,
          run.runtimeConfigSnapshot.context.inlineToolResultMaxChars,
        )
        approval.payload.consumed = true
        await this.store.updateRunState(runId, { approvals: run.state.approvals })
        await this.store.conversationStore.saveRun(this.store.getRun(runId), {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
      } catch (error) {
        const message = rawErrorMessage(error)
        await this.appendToolLedgerCheckpoint(run.threadId, runId, turnId, callId, toolName, 'failed', message)
        await this.store.conversationStore.saveRun(this.store.getRun(runId), {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
        itemSink.completeItem(callItemId, { callId, name: toolName, isError: true, body: message })
        await this.store.updateRunState(runId, { errors: [...this.store.getRun(runId).state.errors, message] })
        return this.store.completeRun(runId, 'failed')
      }
      return this.run({
        runId, threadId: run.threadId, sessionId: run.sessionId,
        query: run.userQuery, provider: run.modelProvider ?? 'openai_compatible',
        modelName: run.modelName, runtimeConfig: run.runtimeConfigSnapshot,
        resume: true,
      })
    }
    const eventSink = new RunEventSink((event) => this.store.appendEvent(runId, event), runId, run.threadId)
    const itemSink = new ItemSink((item) => this.store.appendItem(item), runId, run.threadId)
    eventSink.emit('run.failed', '审批已拒绝，运行取消', { approvalId, rejected: true })
    itemSink.appendResult('cancelled', { approvalId, rejected: true })
    return this.store.completeRun(runId, 'cancelled')
  }
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value) throw new Error(`审批 payload 缺少 ${key}`)
  return value
}

function recordPayload(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key]
  if (!isRecord(value)) throw new Error(`审批 payload 缺少 ${key}`)
  return value
}

function isNowcastQuestion(query: string): boolean {
  const normalized = query.replace(/\s+/gu, '')
  return /(天气怎么样|天气如何|会不会下雨|会下雨吗|下雨吗|短临|未来.{0,8}(降水|降雨|天气)|接下来.{0,8}(天气|降水|降雨|下雨))/u.test(normalized)
}

function requiredResultRef(result: ToolResult, kinds: string[]): ValueRef {
  const ref = result.valueRefs?.find(candidate => kinds.includes(candidate.kind))
  if (!ref) throw new Error(`工具结果缺少 ${kinds.join(' / ')} valueRef`)
  return ref
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientModelConnectionError(error: unknown): boolean {
  const message = rawErrorMessage(error).toLowerCase()
  return [
    'terminated',
    'fetch failed',
    'econnreset',
    'etimedout',
    'socket hang up',
    'premature close',
    'connection reset',
    'connection error',
  ].some(marker => message.includes(marker))
}

function formatRuntimeError(error: unknown): string {
  const message = rawErrorMessage(error)
  if (message.startsWith('模型连接被中断')) return message
  if (isTransientModelConnectionError(error)) {
    return `模型连接被中断（${message}）。系统已自动重试但仍未成功，请重新提交；若持续发生，请检查模型服务与网络连接。`
  }
  return message
}

function approvalBoundary(
  run: AnalysisRun,
  toolName: string,
  args: Record<string, unknown>,
  config: AgentRuntimeConfig,
  isDestructive: boolean,
): 'required' | AnalysisRun['state']['approvals'][number] | null {
  if (!isDestructive && !config.supervisor.approvalInterruptTools.includes(toolName)) return null
  const signature = stableStringify(args)
  const approved = run.state.approvals.find(approval =>
    approval.action === toolName
    && approval.status === 'approved'
    && approval.payload.consumed !== true
    && stableStringify(approval.payload.args) === signature,
  )
  return approved ?? 'required'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

async function invokeStructuredModel(
  adapter: ReturnType<ModelAdapterRegistry['resolveProvider']>,
  prompt: string,
  modelName?: string | null,
): Promise<Record<string, unknown>> {
  const response = await adapter.chat(prompt, { model: modelName ?? adapter.defaultModel, reasoning: false })
  const content = response.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回结构化内容')
  const cleaned = content.replace(/^```json\s*|\s*```$/gu, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    console.error('[runtime] structured output parse error:', e instanceof Error ? e.message : e, '| content:', content.slice(0, 300))
    throw e
  }
  if (!isRecord(parsed)) throw new Error('模型结构化输出必须是 JSON object')
  return parsed
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
