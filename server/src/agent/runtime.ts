// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK 运行时
//
//   文件:       runtime.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  Agent,
  RunContext,
  Runner,
  RunState,
  type AgentInputItem,
  type Model,
  type ModelSettings,
  type RunStreamEvent,
  type RunToolApprovalItem,
} from '@openai/agents'
import type { ToolRegistry } from '../framework/registry.js'
import type { ModelAdapter, ModelAdapterRegistry } from '../model/registry.js'
import type { AgentRuntimeConfig, AnalysisRun } from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { buildSystemPrompt } from './prompts.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import {
  assembleThreadContext,
  compactThreadIfNeeded,
  rebuildThreadMemory,
  type ConversationChatMessage,
} from './contextManager.js'
import { FileAgentsSession } from './fileAgentsSession.js'
import { createAgentsTools, type AgentsExecutionContext } from './agentsToolBridge.js'
import { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import { runDeterministicNowcast, shouldRunDeterministicNowcast } from './deterministicNowcastRunner.js'
import { agentsSdkVersion, runtimeConfigDigest, SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'

const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]+$/u

export interface RunOptions {
  runId: string
  threadId?: string | null
  sessionId: string
  query: string
  provider: string
  modelName?: string | null
  runtimeConfig: AgentRuntimeConfig
  executionMode?: 'plan' | 'auto'
  reasoning?: boolean
  resume?: boolean
}

interface RuntimeAssembly {
  agent: Agent<AgentsExecutionContext>
  runner: Runner
  session: FileAgentsSession
  context: AgentsExecutionContext
  coordinator: ToolExecutionCoordinator
  adapter: ModelAdapter
  configDigest: string
  sdkVersion: string
  threadId: string
  turnId: string
  subAgentNames: ReadonlySet<string>
}

interface StreamProjectionState {
  assistantItemId: string | null
  reasoningItemId: string | null
  reasoningText: string
  assistantText: string
  completedAssistantItems: Array<{ itemId: string; text: string }>
}

// OpenAIAgentsRuntime
//
// Runner 是单次 run 内编排的唯一状态机；本类只投影 SDK 事件并维护 Newmap
// 文件事实源、审批边界和确定性领域入口。
export class OpenAIAgentsRuntime {
  private readonly abortControllers = new Map<string, AbortController>()

  constructor(
    private readonly store: PostgresPlatformStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly modelRegistry: ModelAdapterRegistry,
  ) {}

  async run(options: RunOptions): Promise<AnalysisRun> {
    const threadId = requireThreadId(options.threadId)
    const run = this.store.getRun(options.runId)
    const eventSink = new RunEventSink(event => this.store.appendEvent(options.runId, event), options.runId, threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), options.runId, threadId)
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(options.runId, status))
    const abort = new AbortController()
    this.abortControllers.set(options.runId, abort)
    await this.store.updateRunStatus(options.runId, 'running')

    const turnId = options.resume
      ? await this.requireExistingTurnId(threadId, options.runId)
      : makeId('turn')
    if (!options.resume) {
      const userEntry = await this.store.appendTranscript({
        threadId,
        runId: options.runId,
        turnId,
        kind: 'message',
        payload: { role: 'user', content: options.query },
      })
      itemSink.appendUserMessage(options.query, { transcriptEntryId: userEntry.entryId })
      eventSink.emit('intent.parsed', '开始分析...', {})
    }

    try {
      if (!options.resume && await shouldRunDeterministicNowcast(this.store, options.query, threadId)) {
        const valueState = new Map<string, unknown>(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
        const coordinator = new ToolExecutionCoordinator({
          store: this.store,
          registry: this.toolRegistry,
          adapter: null,
          runId: options.runId,
          sessionId: options.sessionId,
          threadId,
          turnId,
          modelName: null,
          inlineToolResultMaxChars: options.runtimeConfig.context.inlineToolResultMaxChars,
          eventSink,
          itemSink,
          valueState,
        })
        await runDeterministicNowcast({
          store: this.store,
          coordinator,
          eventSink,
          itemSink,
          runId: options.runId,
          threadId,
          turnId,
          query: options.query,
        })
        await finalizer.complete()
        return this.store.getRun(options.runId)
      }

      const assembly = await this.assembleRuntime(options, threadId, turnId, eventSink, itemSink)
      const resumeState = options.resume
        ? await this.restoreSdkState(assembly, options)
        : null
      const completed = await this.executeSdkRun(
        options,
        assembly,
        resumeState,
        abort.signal,
        eventSink,
        itemSink,
      )
      if (completed === 'waiting_approval') return this.store.getRun(options.runId)
      await finalizer.complete()
      return this.store.getRun(options.runId)
    } catch (error) {
      const message = errorMessage(error)
      console.error('[agents-runtime] run failed:', message)
      if (abort.signal.aborted) {
        await finalizer.cancel()
      } else {
        const current = this.store.getRun(options.runId)
        await this.store.updateRunState(options.runId, { errors: [...current.state.errors, message] })
        await finalizer.fail(message)
      }
      return this.store.getRun(options.runId)
    } finally {
      this.abortControllers.delete(options.runId)
    }
  }

  async cancel(runId: string): Promise<AnalysisRun> {
    const controller = this.abortControllers.get(runId)
    if (!controller) throw new Error(`运行 '${runId}' 不可取消`)
    controller.abort()
    return this.store.updateRunStatus(runId, 'cancelled')
  }

  async resolveApproval(runId: string, approvalId: string, approved: boolean): Promise<AnalysisRun> {
    const run = this.store.getRun(runId)
    if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)
    if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot`)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    if (approval.payload.consumed === true) return run

    approval.status = approved ? 'approved' : 'rejected'
    approval.resolvedAt = nowUtc()
    await this.store.updateRunState(runId, { approvals: run.state.approvals })
    const eventSink = new RunEventSink(event => this.store.appendEvent(runId, event), runId, run.threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), runId, run.threadId)
    const turnId = requireString(approval.payload.turnId, '审批 payload.turnId')
    const options: RunOptions = {
      runId,
      threadId: run.threadId,
      sessionId: run.sessionId,
      query: run.userQuery,
      provider: requireString(run.modelProvider, '运行 modelProvider'),
      modelName: run.modelName,
      runtimeConfig: run.runtimeConfigSnapshot,
      reasoning: true,
      resume: true,
    }
    const assembly = await this.assembleRuntime(options, run.threadId, turnId, eventSink, itemSink, false)
    const state = await this.restoreSdkState(assembly, options)
    const callId = requireString(approval.payload.callId, '审批 payload.callId')
    const interruption = state.getInterruptions().find(item => functionCallId(item) === callId)
    if (!interruption) throw new Error(`SDK 状态中不存在待审批调用 '${callId}'`)
    if (approved) state.approve(interruption)
    else state.reject(interruption, { message: '用户拒绝执行该工具。' })

    await this.store.updateRunStatus(runId, 'running')
    const abort = new AbortController()
    this.abortControllers.set(runId, abort)
    try {
      const result = await this.executeSdkRun(options, assembly, state, abort.signal, eventSink, itemSink)
      approval.payload.consumed = true
      await this.store.updateRunState(runId, { approvals: run.state.approvals })
      if (result === 'waiting_approval') return this.store.getRun(runId)
      const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
      await finalizer.complete()
      return this.store.getRun(runId)
    } catch (error) {
      const message = errorMessage(error)
      const current = this.store.getRun(runId)
      await this.store.updateRunState(runId, { errors: [...current.state.errors, message] })
      const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
      await finalizer.fail(message)
      return this.store.getRun(runId)
    } finally {
      this.abortControllers.delete(runId)
    }
  }

  private async assembleRuntime(
    options: RunOptions,
    threadId: string,
    turnId: string,
    eventSink: RunEventSink,
    itemSink: ItemSink,
    maintainContext = true,
  ): Promise<RuntimeAssembly> {
    const adapter = this.modelRegistry.resolveProvider(options.provider)
    if (!adapter.createAgentModel) throw new Error(`模型 provider '${adapter.provider}' 不支持 Agents SDK Supervisor`)
    const selectedModel = options.modelName ?? adapter.defaultModel
    if (!selectedModel) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)
    const model = adapter.createAgentModel(selectedModel)
    const contextConfig = {
      ...options.runtimeConfig.context,
      contextWindowTokens: adapter.contextWindowTokens ?? options.runtimeConfig.context.contextWindowTokens,
    }
    const summarize = async (prompt: string) => {
      const summaryAdapter = this.modelRegistry.resolveProvider(options.runtimeConfig.context.summaryProvider ?? options.provider)
      const summaryModel = options.runtimeConfig.context.summaryModel
        ?? summaryAdapter.subagentModel
        ?? selectedModel
      if (!summaryModel) throw new Error('未配置摘要模型')
      const response = await summaryAdapter.chat(prompt, { model: summaryModel, reasoning: false })
      if (typeof response.content !== 'string' || !response.content.trim()) throw new Error('摘要模型未返回文本')
      return response.content
    }
    if (maintainContext) {
      await compactThreadIfNeeded(this.store, threadId, contextConfig, summarize)
      await rebuildThreadMemory(this.store, threadId, contextConfig, summarize, false, options.runId)
    }
    const run = this.store.getRun(options.runId)
    const systemPrompt = buildSystemPrompt(options.runtimeConfig, run.state, '', '', '')
    const assembled = await assembleThreadContext(this.store, threadId, contextConfig, systemPrompt)
    await this.store.updateRunState(options.runId, {
      runtimeStats: {
        ...run.state.runtimeStats,
        contextEstimatedTokens: assembled.report.estimatedTokens,
        contextUsagePermille: Math.round(assembled.report.usageRatio * 1000),
      },
    })

    const valueState = new Map<string, unknown>(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
    const coordinator = new ToolExecutionCoordinator({
      store: this.store,
      registry: this.toolRegistry,
      adapter,
      runId: options.runId,
      sessionId: options.sessionId,
      threadId,
      turnId,
      modelName: selectedModel,
      inlineToolResultMaxChars: options.runtimeConfig.context.inlineToolResultMaxChars,
      eventSink,
      itemSink,
      valueState,
    })
    const context: AgentsExecutionContext = {
      runId: options.runId,
      prepareToolCall: (toolName, args, callId) => coordinator.prepare(toolName, args, callId),
      executeTool: (toolName, args, callId) => coordinator.executeForModel(toolName, args, callId),
    }
    const approvalTools = new Set(options.runtimeConfig.supervisor.approvalInterruptTools)
    const supervisorTools = createAgentsTools(this.toolRegistry, approvalTools)
    const previousSubAgents = new Map(this.store.getRun(options.runId).state.subAgents.map(agent => [agent.agentId, agent]))
    await this.store.updateRunState(options.runId, {
      subAgents: options.runtimeConfig.subAgents.map(config => previousSubAgents.get(config.agentId) ?? ({
        agentId: config.agentId,
        name: config.name,
        role: config.role,
        status: 'pending',
        summary: config.summary,
        stepIds: [],
        tools: config.tools,
        currentStepId: null,
        latestMessage: null,
      })),
    })
    const subAgentTools = options.runtimeConfig.subAgents.map(config => {
      if (!AGENT_TOOL_NAME.test(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 不能作为工具名`)
      if (this.toolRegistry.get(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 与现有工具重名`)
      const subModelName = config.model ?? selectedModel
      const subModel = subModelName === selectedModel ? model : adapter.createAgentModel!(subModelName)
      const subAgent = new Agent<AgentsExecutionContext>({
        name: config.agentId,
        instructions: config.systemPrompt ?? config.summary,
        handoffDescription: config.summary,
        model: subModel,
        modelSettings: modelSettings(options.reasoning),
        tools: createAgentsTools(this.toolRegistry, approvalTools, new Set(config.tools)),
      })
      return subAgent.asTool({
        toolName: config.agentId,
        toolDescription: config.summary,
        customOutputExtractor: async output => {
          for (const item of output.newItems) {
            await this.store.conversationStore.appendAgentTranscript(options.runId, config.agentId, {
              type: 'completed_item',
              item: item.toJSON(),
            })
          }
          const current = this.store.getRun(options.runId)
          await this.store.updateRunState(options.runId, {
            subAgents: current.state.subAgents.map(agentState => agentState.agentId === config.agentId
              ? { ...agentState, status: 'completed', latestMessage: '子 Agent 已返回结果' }
              : agentState),
          })
          eventSink.emit('step.completed', `${config.name} 已完成`, { agentId: config.agentId })
          if (typeof output.finalOutput !== 'string' || !output.finalOutput.trim()) {
            throw new Error(`子 Agent '${config.agentId}' 未返回文本结果`)
          }
          return output.finalOutput
        },
        onStream: async ({ event }) => {
          await this.store.conversationStore.appendAgentTranscript(options.runId, config.agentId, serializeAgentEvent(event))
          const current = this.store.getRun(options.runId)
          const completed = event.type === 'run_item_stream_event' && event.name === 'message_output_created'
          await this.store.updateRunState(options.runId, {
            subAgents: current.state.subAgents.map(agentState => agentState.agentId === config.agentId
              ? {
                ...agentState,
                status: completed ? 'completed' : 'running',
                latestMessage: completed ? '子 Agent 已返回结果' : '子 Agent 正在执行',
              }
              : agentState),
          })
          eventSink.emit(completed ? 'step.completed' : 'step.started',
            completed ? `${config.name} 已完成` : `${config.name} 正在执行`,
            { agentId: config.agentId })
        },
      })
    })
    const agent = new Agent<AgentsExecutionContext>({
      name: options.runtimeConfig.supervisor.name,
      instructions: systemPrompt,
      model,
      modelSettings: modelSettings(options.reasoning),
      tools: [...supervisorTools, ...subAgentTools],
      toolUseBehavior: { stopAtToolNames: ['answer_nowcast_question'] },
    })
    const runner = new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      toolNotFoundBehavior: 'raise_error',
      toolExecution: { maxFunctionToolConcurrency: 1, preApprovalInputGuardrails: true },
    })

    const projectSessionItem = async (item: AgentInputItem): Promise<void> => {
      if (isAssistantMessage(item)) {
        const content = assistantText(item)
        if (!content) return
        await this.store.appendTranscript({
          threadId,
          runId: options.runId,
          turnId,
          kind: 'message',
          payload: { role: 'assistant', content },
        })
        return
      }
      if (item.type === 'reasoning' || ('role' in item && item.role === 'user')) return
      if (item.type === 'function_call') {
        const exists = (await this.store.activeTranscript(threadId))
          .some(entry => entry.kind === 'tool_call' && entry.payload.callId === item.callId)
        if (!exists) throw new Error(`SDK Session 收到未准备的工具调用 '${item.callId}'`)
        return
      }
      if (item.type === 'function_call_result') {
        const exists = (await this.store.activeTranscript(threadId))
          .some(entry => entry.kind === 'tool_result' && entry.payload.callId === item.callId)
        if (exists) return
        const content = toolResultText(item.output)
        const isSubAgent = options.runtimeConfig.subAgents.some(config => config.agentId === item.name)
        await this.store.appendTranscript({
          threadId,
          runId: options.runId,
          turnId,
          kind: 'tool_result',
          payload: {
            callId: item.callId,
            name: item.name,
            summary: content,
            content,
            contentRef: null,
            ledgerStatus: isSubAgent ? 'completed' : 'rejected',
            resultId: null,
          },
        })
        await this.store.conversationStore.saveRun(this.store.getRun(options.runId), {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
      }
    }
    const history = conversationMessagesToAgentItems(assembled.messages, options.query, systemPrompt)
    const session = new FileAgentsSession(
      `${options.sessionId}:${threadId}`,
      history,
      async items => {
        for (const item of items) await projectSessionItem(item)
      },
    )
    return {
      agent,
      runner,
      session,
      context,
      coordinator,
      adapter,
      configDigest: runtimeConfigDigest(options.runtimeConfig),
      sdkVersion: await agentsSdkVersion(),
      threadId,
      turnId,
      subAgentNames: new Set(options.runtimeConfig.subAgents.map(config => config.agentId)),
    }
  }

  private async executeSdkRun(
    options: RunOptions,
    assembly: RuntimeAssembly,
    resumeState: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>> | null,
    signal: AbortSignal,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<'completed' | 'waiting_approval'> {
    const stream = await assembly.runner.run(
      assembly.agent,
      resumeState ?? options.query,
      {
        stream: true,
        context: new RunContext(assembly.context),
        session: assembly.session,
        maxTurns: options.runtimeConfig.maxTurns,
        signal,
      },
    )
    await this.persistSdkState(options.runId, stream.state, assembly)
    const projection: StreamProjectionState = {
      assistantItemId: null,
      reasoningItemId: null,
      reasoningText: '',
      assistantText: '',
      completedAssistantItems: [],
    }
    for await (const event of stream) {
      await this.projectStreamEvent(event, projection, assembly, eventSink, itemSink)
      if (event.type === 'run_item_stream_event' && ['tool_output', 'tool_approval_requested'].includes(event.name)) {
        await this.persistSdkState(options.runId, stream.state, assembly)
      }
    }
    await stream.completed
    if (stream.error) throw stream.error
    await this.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
    if (projection.reasoningItemId) {
      itemSink.completeItem(projection.reasoningItemId, { body: projection.reasoningText })
    }
    await this.updateUsage(options.runId, stream.rawResponses)
    const interruptions = stream.interruptions
    if (interruptions.length) {
      await this.persistSdkState(options.runId, stream.state, assembly)
      await this.persistApprovals(options, interruptions, eventSink, itemSink)
      return 'waiting_approval'
    }
    const finalOutput = typeof stream.finalOutput === 'string' ? stream.finalOutput.trim() : ''
    if (!finalOutput) throw new Error('Agent 未返回可交付文本')
    if (!projection.assistantText || projection.assistantText !== finalOutput) {
      const synthetic: AgentInputItem = {
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: finalOutput }],
      }
      const content = assistantText(synthetic)
      if (!content) throw new Error('终止工具未生成可持久化文本')
      const persisted = await this.store.appendTranscript({
        threadId: assembly.threadId,
        runId: options.runId,
        turnId: assembly.turnId,
        kind: 'message',
        payload: { role: 'assistant', content },
      })
      itemSink.appendAssistantMessage(finalOutput, {
        transcriptEntryId: persisted.entryId,
      })
    }
    await this.persistSdkState(options.runId, stream.state, assembly)
    await this.store.conversationStore.saveRun(this.store.getRun(options.runId), {
      pendingToolCallIds: [],
      recoveryStatus: 'clean',
    })
    return 'completed'
  }

  private async projectStreamEvent(
    event: RunStreamEvent,
    projection: StreamProjectionState,
    assembly: RuntimeAssembly,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<void> {
    if (event.type === 'raw_model_stream_event') {
      if (event.data.type === 'output_text_delta' && event.data.delta) {
        if (!projection.assistantItemId) {
          projection.assistantItemId = itemSink.startItem('message', { role: 'assistant' }).itemId
        }
        projection.assistantText += event.data.delta
        itemSink.deltaItem(projection.assistantItemId, event.data.delta)
      }
      if (event.data.type === 'model') {
        const delta = extractReasoningDelta(event.data.event)
        if (delta) {
          if (!projection.reasoningItemId) {
            projection.reasoningItemId = itemSink.startItem('reasoning', { role: 'assistant' }).itemId
          }
          projection.reasoningText += delta
          itemSink.deltaItem(projection.reasoningItemId, delta)
        }
      }
      return
    }
    if (event.type === 'agent_updated_stream_event') {
      eventSink.emit('step.started', `Agent：${event.agent.name}`, { agentId: event.agent.name })
      return
    }
    if (event.name === 'message_output_created') {
      const raw = event.item.rawItem as AgentInputItem
      const text = isAssistantMessage(raw) ? assistantText(raw) : ''
      if (text) {
        let itemId: string
        if (projection.assistantItemId) {
          itemId = projection.assistantItemId
          itemSink.completeItem(itemId, { body: text })
        } else {
          itemId = itemSink.appendAssistantMessage(text).itemId
        }
        projection.completedAssistantItems.push({ itemId, text })
        projection.assistantText = text
        projection.assistantItemId = null
      }
    } else if (event.name === 'reasoning_item_created') {
      if (projection.reasoningItemId) {
        itemSink.completeItem(projection.reasoningItemId, { body: projection.reasoningText })
        projection.reasoningItemId = null
      }
    } else if (event.name === 'tool_called') {
      const raw = event.item.rawItem
      if (raw.type === 'function_call' && assembly.subAgentNames.has(raw.name)) {
        const exists = (await this.store.activeTranscript(assembly.threadId))
          .some(entry => entry.kind === 'tool_call' && entry.payload.callId === raw.callId)
        if (!exists) {
          const parsedArgs = parseArguments(raw.arguments)
          await this.store.appendTranscript({
            threadId: assembly.threadId,
            runId: assembly.context.runId,
            turnId: assembly.turnId,
            kind: 'tool_call',
            payload: {
              callId: raw.callId,
              name: raw.name,
              arguments: parsedArgs,
              ledgerStatus: 'started',
            },
          })
          const item = itemSink.startItem('function_call', {
            name: raw.name,
            callId: raw.callId,
            arguments: raw.arguments,
          })
          itemSink.completeItem(item.itemId, { name: raw.name, callId: raw.callId, body: '子 Agent 已启动' })
        }
      }
      eventSink.emit('tool.started', event.item.type, { sdkItemType: event.item.type })
    } else if (event.name === 'tool_approval_requested') {
      eventSink.emit('approval.required', '工具调用等待审批', {})
    }
  }

  // linkAssistantTranscriptEntries
  //
  // SDK Session 是 assistant 语义落盘的唯一入口；流式 item 在 completed 后只回填
  // canonical entry 身份，数量或顺序不一致时直接报告协议错误。
  private async linkAssistantTranscriptEntries(
    runId: string,
    assembly: RuntimeAssembly,
    projection: StreamProjectionState,
    itemSink: ItemSink,
  ): Promise<void> {
    if (!projection.completedAssistantItems.length) return
    const entries = (await this.store.activeTranscript(assembly.threadId)).filter(entry => (
      entry.runId === runId
      && entry.turnId === assembly.turnId
      && entry.kind === 'message'
      && entry.payload.role === 'assistant'
    ))
    if (entries.length < projection.completedAssistantItems.length) {
      throw new Error('SDK Session 未持久化全部 assistant 消息')
    }
    const persisted = entries.slice(-projection.completedAssistantItems.length)
    for (let index = 0; index < projection.completedAssistantItems.length; index += 1) {
      const projected = projection.completedAssistantItems[index]
      const entry = persisted[index]
      if (entry.payload.content !== projected.text) {
        throw new Error('SDK Session assistant 消息顺序与流事件不一致')
      }
      itemSink.completeItem(projected.itemId, {
        body: projected.text,
        metadata: { transcriptEntryId: entry.entryId },
      })
    }
  }

  private async persistApprovals(
    options: RunOptions,
    interruptions: RunToolApprovalItem[],
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<void> {
    const run = this.store.getRun(options.runId)
    const approvals = [...run.state.approvals]
    for (const interruption of interruptions) {
      const callId = functionCallId(interruption)
      const toolName = interruption.name
      if (!callId || !toolName) throw new Error('SDK 审批中断缺少 callId/toolName')
      if (approvals.some(item => item.payload.callId === callId && item.payload.consumed !== true)) continue
      const args = parseArguments(interruption.arguments)
      const definition = this.toolRegistry.get(toolName)
      const request = {
        approvalId: makeId('approval'),
        action: toolName,
        title: `批准执行：${definition?.label ?? toolName}`,
        description: definition?.description ?? `工具 ${toolName} 需要审批`,
        status: 'pending',
        artifactId: null,
        payload: {
          toolName,
          args,
          callId,
          turnId: await this.requireExistingTurnId(requireThreadId(options.threadId), options.runId),
          consumed: false,
        },
        createdAt: nowUtc(),
        resolvedAt: null,
      }
      approvals.push(request)
      eventSink.emit('approval.required', request.title, { approvalId: request.approvalId, tool: toolName, callId })
      itemSink.appendResult('waiting_approval', { approvalId: request.approvalId, tool: toolName, callId })
    }
    await this.store.updateRunState(options.runId, { approvals })
    await this.store.completeRun(options.runId, 'waiting_approval')
  }

  private async persistSdkState(
    runId: string,
    state: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>,
    assembly: RuntimeAssembly,
  ): Promise<void> {
    await this.store.conversationStore.saveAgentsSdkState(runId, state.toString(), {
      agentsSdkVersion: assembly.sdkVersion,
      runtimeConfigDigest: assembly.configDigest,
    })
  }

  private async restoreSdkState(
    assembly: RuntimeAssembly,
    options: RunOptions,
  ): Promise<RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>> {
    const checkpoint = await this.store.conversationStore.getRunCheckpoint(options.runId)
    if (checkpoint.orchestrationEngine !== 'openai_agents') {
      throw new Error(`run '${options.runId}' 不是 OpenAI Agents SDK 检查点，不能续跑`)
    }
    if (checkpoint.sdkStateSchemaVersion !== SDK_STATE_SCHEMA_VERSION) {
      throw new Error(`run '${options.runId}' SDK 状态 schema 不匹配`)
    }
    if (checkpoint.agentsSdkVersion !== assembly.sdkVersion) {
      throw new Error(`run '${options.runId}' SDK 版本不匹配：${checkpoint.agentsSdkVersion} != ${assembly.sdkVersion}`)
    }
    if (checkpoint.runtimeConfigDigest !== assembly.configDigest) {
      throw new Error(`run '${options.runId}' 运行配置已变化，拒绝恢复`)
    }
    const serialized = await this.store.conversationStore.readAgentsSdkState(options.runId)
    return RunState.fromStringWithContext(
      assembly.agent,
      serialized,
      new RunContext(assembly.context),
      { contextStrategy: 'replace' },
    )
  }

  private async requireExistingTurnId(threadId: string, runId: string): Promise<string> {
    const entries = await this.store.activeTranscript(threadId)
    const entry = [...entries].reverse().find(candidate => candidate.runId === runId && candidate.turnId)
    if (!entry?.turnId) throw new Error(`run '${runId}' 缺少可恢复 turnId`)
    return entry.turnId
  }

  private async updateUsage(runId: string, responses: Array<{ usage: { inputTokens: number; outputTokens: number; totalTokens: number } }>): Promise<void> {
    const usage = responses.reduce((total, response) => ({
      inputTokens: total.inputTokens + response.usage.inputTokens,
      outputTokens: total.outputTokens + response.usage.outputTokens,
      totalTokens: total.totalTokens + response.usage.totalTokens,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    const run = this.store.getRun(runId)
    await this.store.updateRunState(runId, {
      runtimeStats: {
        ...run.state.runtimeStats,
        modelInputTokens: usage.inputTokens,
        modelOutputTokens: usage.outputTokens,
        modelTotalTokens: usage.totalTokens,
      },
    })
  }
}

function modelSettings(reasoning = true): ModelSettings {
  return {
    parallelToolCalls: false,
    ...(reasoning ? { reasoning: { effort: 'high' as const } } : {}),
    retry: {
      maxRetries: 1,
      policy: ({ providerAdvice }: { providerAdvice?: { replaySafety?: 'safe' | 'unsafe'; suggested?: boolean } }) =>
        providerAdvice?.replaySafety === 'safe' && providerAdvice.suggested === true,
    },
  }
}

function conversationMessagesToAgentItems(
  sourceMessages: ConversationChatMessage[],
  currentQuery: string,
  systemPrompt: string,
): AgentInputItem[] {
  const items: AgentInputItem[] = []
  const callNames = new Map<string, string>()
  let messages = sourceMessages[0]?.role === 'system' && sourceMessages[0].content === systemPrompt
    ? sourceMessages.slice(1)
    : [...sourceMessages]
  let skippedCurrentInput = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!skippedCurrentInput && message.role === 'user' && message.content?.trim() === currentQuery.trim()) {
      messages = [...messages.slice(0, index), ...messages.slice(index + 1)]
      skippedCurrentInput = true
      break
    }
  }
  for (const message of messages) {
    if (message.role === 'system') {
      items.push({ type: 'message', role: 'system', content: message.content ?? '' })
    } else if (message.role === 'user') {
      items.push({ type: 'message', role: 'user', content: message.content ?? '' })
    } else if (message.role === 'assistant') {
      if (message.content) {
        items.push({
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: message.content }],
        })
      }
      for (const call of message.tool_calls ?? []) {
        callNames.set(call.id, call.function.name)
        items.push({
          type: 'function_call', status: 'completed', callId: call.id,
          name: call.function.name, arguments: call.function.arguments,
        })
      }
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('历史工具结果缺少 tool_call_id')
      items.push({
        type: 'function_call_result',
        status: 'completed',
        callId: message.tool_call_id,
        name: callNames.get(message.tool_call_id) ?? 'tool',
        output: message.content ?? '',
      })
    } else {
      throw new Error(`不支持的历史消息角色 '${message.role}'`)
    }
  }
  return items
}

function serializeAgentEvent(event: RunStreamEvent): Record<string, unknown> {
  if (event.type === 'run_item_stream_event') {
    return { type: event.type, name: event.name, item: event.item.toJSON() }
  }
  if (event.type === 'agent_updated_stream_event') {
    return { type: event.type, agent: event.agent.name }
  }
  return { type: event.type, data: event.data }
}

function isAssistantMessage(item: AgentInputItem): item is Extract<AgentInputItem, { role: 'assistant' }> {
  return 'role' in item && item.role === 'assistant'
}

function assistantText(item: Extract<AgentInputItem, { role: 'assistant' }>): string {
  return item.content.map(part => {
    if (part.type === 'output_text') return part.text
    if (part.type === 'refusal') return part.refusal
    return ''
  }).join('').trim()
}

function toolResultText(output: Extract<AgentInputItem, { type: 'function_call_result' }>['output']): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const text = output.flatMap(part => part.type === 'input_text' ? [part.text] : []).join('')
    if (text) return text
  }
  if (isRecord(output) && output.type === 'text' && typeof output.text === 'string') return output.text
  throw new Error('SDK Session 工具结果不是文本')
}

function extractReasoningDelta(value: unknown): string {
  if (!isRecord(value)) return ''
  const choices = Array.isArray(value.choices) ? value.choices : []
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first.delta)) return ''
  const reasoning = first.delta.reasoning ?? first.delta.reasoning_content
  return typeof reasoning === 'string' ? reasoning : ''
}

function functionCallId(interruption: RunToolApprovalItem): string | null {
  const raw = interruption.rawItem
  return raw.type === 'function_call' && typeof raw.callId === 'string' ? raw.callId : null
}

function parseArguments(value: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value ?? '{}')
  if (!isRecord(parsed)) throw new Error('审批工具参数必须为 JSON object')
  return parsed
}

function requireThreadId(threadId: string | null | undefined): string {
  if (!threadId) throw new Error('连续对话运行必须属于 thread')
  return threadId
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} 不能为空`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
