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
import {
  Capabilities,
  Manifest,
  SandboxAgent,
  type SandboxSessionLike,
} from '@openai/agents/sandbox'
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local'
import type { ToolRegistry } from '../framework/registry.js'
import type { ModelAdapter, ModelAdapterRegistry } from '../model/registry.js'
import type {
  AgentRuntimeConfig,
  AnalysisRun,
  DecisionRequest,
  RuntimeSandboxConfig,
  ToolValueRef,
  TranscriptEntry,
} from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { buildSystemPrompt } from './prompts.js'
import { buildMemoryPrompt, createMemoryRuntime, dreamMemories, extractMemoriesFromThread, rebuildSessionMemory } from '../memory/service.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import {
  assembleThreadContext,
  compactThreadIfNeeded,
  type ConversationChatMessage,
} from './contextManager.js'
import { FileAgentsSession } from './fileAgentsSession.js'
import { createAgentsTools, type AgentsExecutionContext } from './agentsToolBridge.js'
import { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import { runDeterministicNowcast, shouldRunDeterministicNowcast } from './deterministicNowcastRunner.js'
import { agentsSdkVersion, runtimeConfigDigest, SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'

const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]+$/u

function buildSandboxManifest(options: RunOptions, threadId: string): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# GeoForge Sandbox

本工作区由 GeoForge 运行时为单次 Agent run 创建。

- runId: ${options.runId}
- threadId: ${threadId}
- sessionId: ${options.sessionId}

文件、shell 和 patch 操作必须在这个 sandbox 工作区内完成。平台运行时数据、上传文件和气象数据集只能通过已注册工具访问，不要猜测宿主机路径。
`,
      },
    },
  })
}

export type SandboxSessionFactory = (
  manifest: Manifest,
  config: RuntimeSandboxConfig,
) => Promise<SandboxSessionLike>

export interface OpenAIAgentsRuntimeOptions {
  createSandboxSession?: SandboxSessionFactory
}

async function createConfiguredSandboxSession(
  manifest: Manifest,
  config: RuntimeSandboxConfig,
): Promise<SandboxSessionLike> {
  if (config.backend === 'docker') {
    return new DockerSandboxClient({ image: config.dockerImage }).create(manifest)
  }
  if (config.backend === 'unix_local') {
    return new UnixLocalSandboxClient().create(manifest)
  }
  throw new Error(`不支持的 sandbox backend：${config.backend}`)
}

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
  sandboxSession: SandboxSessionLike
  configDigest: string
  sdkVersion: string
  threadId: string
  turnId: string
  subAgentNames: ReadonlySet<string>
  flushPendingSessionAssistantMessage: () => Promise<void>
}

interface StreamProjectionState {
  assistantItemId: string | null
  reasoningItemId: string | null
  reasoningText: string
  lastAssistantText: string
  completedAssistantItems: Array<{ itemId: string; text: string; entryId: string | null }>
}

// OpenAIAgentsRuntime
//
// Runner 是单次 run 内编排的唯一状态机；本类只投影 SDK 事件并维护 GeoForge
// 文件事实源、审批边界和确定性领域入口。
export class OpenAIAgentsRuntime {
  private readonly abortControllers = new Map<string, AbortController>()

  constructor(
    private readonly store: PostgresPlatformStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly modelRegistry: ModelAdapterRegistry,
    private readonly runtimeOptions: OpenAIAgentsRuntimeOptions = {},
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
    if (!options.resume && options.executionMode === 'plan') {
      await this.store.updateRunState(options.runId, {
        planMode: true,
        executionPlan: null,
      })
    }

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
        const valueState = this.createThreadValueState(threadId, options.runId)
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
          runtimeConfig: options.runtimeConfig,
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
        await this.maybeExtractLongTermMemories(options, threadId, eventSink)
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
      if (completed === 'clarification_needed') return this.store.getRun(options.runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, threadId, eventSink)
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
    await this.store.updateRunState(runId, {
      approvals: run.state.approvals,
      decisions: resolveDecision(run.state.decisions, approvalId, approved ? 'approved' : 'rejected', { approved }),
    })
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
      await this.store.updateRunState(runId, {
        approvals: run.state.approvals,
        decisions: resolveDecision(this.store.getRun(runId).state.decisions, approvalId, approved ? 'approved' : 'rejected', { approved, consumed: true }),
      })
      if (result === 'waiting_approval') return this.store.getRun(runId)
      if (result === 'clarification_needed') return this.store.getRun(runId)
      const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, run.threadId, eventSink)
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

  private createThreadValueState(threadId: string, currentRunId: string): Map<string, unknown> {
    const refs = this.visibleThreadValueRefs(threadId, currentRunId)
    return new Map<string, unknown>(refs.map(ref => [ref.refId, ref]))
  }

  private visibleThreadValueRefs(threadId: string, currentRunId: string): ToolValueRef[] {
    const currentRun = this.store.getRun(currentRunId)
    const currentCreatedAt = Date.parse(currentRun.createdAt)
    const priorRuns = this.store.listRunsForThread(threadId)
      .filter(run => run.id !== currentRunId && Date.parse(run.createdAt) <= currentCreatedAt)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

    // 连续对话会把上一轮 tool_result 作为可见上下文交给模型；运行时黑板必须恢复
    // 同一 thread 中已落盘的 valueRef，否则模型可见的 refId 会在执行边界变成未知引用。
    return [
      ...priorRuns.flatMap(run => run.state.toolValueRefs),
      ...currentRun.state.toolValueRefs,
    ]
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
      try {
        await rebuildSessionMemory(this.store, threadId, contextConfig, summarize, false, options.runId)
      } catch (error) {
        await this.recordWarning(options.runId, `会话记忆更新失败：${errorMessage(error)}`, eventSink)
      }
    }
    const run = this.store.getRun(options.runId)
    const memoryToolsAvailable = this.memoryToolsAvailable()
    const memoryPrompt = await buildMemoryPrompt(createMemoryRuntime(this.store.runtimeRoot, contextConfig), memoryToolsAvailable)
    const systemPrompt = buildSystemPrompt(options.runtimeConfig, run.state, '', '', memoryPrompt)
    const assembled = await assembleThreadContext(this.store, threadId, contextConfig, systemPrompt)
    await this.store.updateRunState(options.runId, {
      runtimeStats: {
        ...run.state.runtimeStats,
        contextEstimatedTokens: assembled.report.estimatedTokens,
        contextUsagePermille: Math.round(assembled.report.usageRatio * 1000),
      },
    })

    const valueState = this.createThreadValueState(threadId, options.runId)
    let coordinator: ToolExecutionCoordinator
    const context: AgentsExecutionContext = {
      runId: options.runId,
      prepareToolCall: (toolName, args, callId) => coordinator.prepare(toolName, args, callId),
      executeTool: (toolName, args, callId) => coordinator.executeForModel(toolName, args, callId),
    }
    coordinator = new ToolExecutionCoordinator({
      store: this.store,
      registry: this.toolRegistry,
      adapter,
      runId: options.runId,
      sessionId: options.sessionId,
      threadId,
      turnId,
      modelName: selectedModel,
      inlineToolResultMaxChars: options.runtimeConfig.context.inlineToolResultMaxChars,
      runtimeConfig: options.runtimeConfig,
      eventSink,
      itemSink,
      valueState,
    })
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
    const sandboxManifest = buildSandboxManifest(options, threadId)
    const createSandboxSession = this.runtimeOptions.createSandboxSession ?? createConfiguredSandboxSession
    const sandboxSession = await createSandboxSession(sandboxManifest, options.runtimeConfig.sandbox)
    const agent = new SandboxAgent<AgentsExecutionContext>({
      name: options.runtimeConfig.supervisor.name,
      instructions: systemPrompt,
      model,
      modelSettings: modelSettings(options.reasoning),
      tools: [...supervisorTools, ...subAgentTools],
      toolUseBehavior: { stopAtToolNames: ['answer_nowcast_question', 'request_clarification'] },
      defaultManifest: sandboxManifest,
      capabilities: Capabilities.default(),
    })
    const runner = new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      toolNotFoundBehavior: 'raise_error',
      toolExecution: { maxFunctionToolConcurrency: 1, preApprovalInputGuardrails: true },
    })

    let assembly: RuntimeAssembly | null = null
    let pendingSessionAssistantContent: string | null = null
    const flushPendingSessionAssistantMessage = async (): Promise<void> => {
      if (!pendingSessionAssistantContent) return
      if (!assembly) throw new Error('SDK Session assistant 消息早于运行时装配完成')
      const content = pendingSessionAssistantContent
      pendingSessionAssistantContent = null
      await this.appendAssistantMessageTranscript(assembly, content)
    }
    const projectSessionItems = async (items: AgentInputItem[]): Promise<void> => {
      for (const item of items) {
        if (isAssistantMessage(item)) {
          const content = assistantText(item)
          if (!content) continue
          await flushPendingSessionAssistantMessage()
          pendingSessionAssistantContent = content
          continue
        }
        if (item.type === 'reasoning' || ('role' in item && item.role === 'user')) continue
        if (item.type === 'function_call') {
          const exists = (await this.store.activeTranscript(threadId))
            .some(entry => entry.kind === 'tool_call' && entry.payload.callId === item.callId)
          if (!exists) {
            if (this.isPlatformManagedTool(item.name, options.runtimeConfig)) {
              throw new Error(`SDK Session 收到未准备的工具调用 '${item.callId}'`)
            }
            await this.appendSandboxNativeToolCallTranscript(options.runId, threadId, turnId, item, itemSink)
          }
          if (pendingSessionAssistantContent) {
            if (!assembly) throw new Error('SDK Session 工具调用早于运行时装配完成')
            await this.appendAssistantContentCheckpoint(assembly, item.callId, pendingSessionAssistantContent)
            pendingSessionAssistantContent = null
          }
          continue
        }
        await flushPendingSessionAssistantMessage()
        if (item.type === 'function_call_result') {
          const exists = (await this.store.activeTranscript(threadId))
            .some(entry => entry.kind === 'tool_result' && entry.payload.callId === item.callId)
          if (exists) continue
          const content = toolResultText(item.output)
          const isSubAgent = options.runtimeConfig.subAgents.some(config => config.agentId === item.name)
          const isSandboxNativeTool = !this.isPlatformManagedTool(item.name, options.runtimeConfig)
          const ledgerStatus = isSandboxNativeTool
            ? sdkNativeLedgerStatus(item.status)
            : (isSubAgent ? 'completed' : 'rejected')
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
              ledgerStatus,
              resultId: null,
              ...(isSandboxNativeTool ? { source: 'openai_agents_sandbox' } : {}),
            },
          })
          if (isSandboxNativeTool) {
            const outputItem = itemSink.startItem('function_call_output', {
              callId: item.callId,
              name: item.name,
              role: 'tool',
              metadata: { source: 'openai_agents_sandbox' },
            })
            itemSink.completeItem(outputItem.itemId, {
              callId: item.callId,
              name: item.name,
              output: content,
              isError: ledgerStatus === 'failed',
              metadata: { source: 'openai_agents_sandbox' },
            })
          }
          await this.store.conversationStore.saveRun(this.store.getRun(options.runId), {
            pendingToolCallIds: [],
            recoveryStatus: 'clean',
          })
        }
      }
    }
    const history = conversationMessagesToAgentItems(assembled.messages, options.query, systemPrompt)
    const session = new FileAgentsSession(
      `${options.sessionId}:${threadId}`,
      history,
      projectSessionItems,
    )
    assembly = {
      agent,
      runner,
      session,
      context,
      coordinator,
      adapter,
      sandboxSession,
      configDigest: runtimeConfigDigest(options.runtimeConfig),
      sdkVersion: await agentsSdkVersion(),
      threadId,
      turnId,
      subAgentNames: new Set(options.runtimeConfig.subAgents.map(config => config.agentId)),
      flushPendingSessionAssistantMessage,
    }
    return assembly
  }

  private async executeSdkRun(
    options: RunOptions,
    assembly: RuntimeAssembly,
    resumeState: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>> | null,
    signal: AbortSignal,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<'completed' | 'waiting_approval' | 'clarification_needed'> {
    let outcome: 'completed' | 'waiting_approval' | 'clarification_needed' | null = null
    const projection: StreamProjectionState = {
      assistantItemId: null,
      reasoningItemId: null,
      reasoningText: '',
      lastAssistantText: '',
      completedAssistantItems: [],
    }
    try {
      const stream = await assembly.runner.run(
        assembly.agent,
        resumeState ?? options.query,
        {
          stream: true,
          context: new RunContext(assembly.context),
          session: assembly.session,
          sandbox: { session: assembly.sandboxSession },
          maxTurns: options.runtimeConfig.maxTurns,
          signal,
        },
      )
      await this.persistSdkState(options.runId, stream.state, assembly)
      for await (const event of stream) {
        await this.projectStreamEvent(event, projection, assembly, eventSink, itemSink)
        if (event.type === 'run_item_stream_event' && ['tool_output', 'tool_approval_requested'].includes(event.name)) {
          await this.persistSdkState(options.runId, stream.state, assembly)
        }
      }
      await stream.completed
      if (stream.error) throw stream.error
      await assembly.flushPendingSessionAssistantMessage()
      await this.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
      if (projection.reasoningItemId) {
        itemSink.completeItem(projection.reasoningItemId, { body: projection.reasoningText })
      }
      await this.updateUsage(options.runId, stream.rawResponses)
      const interruptions = stream.interruptions
      if (interruptions.length) {
        await this.persistSdkState(options.runId, stream.state, assembly)
        await this.persistApprovals(options, interruptions, eventSink, itemSink)
        outcome = 'waiting_approval'
        return outcome
      }
      const finalOutput = typeof stream.finalOutput === 'string' ? stream.finalOutput.trim() : ''
      if (!finalOutput) throw new Error('Agent 未返回可交付文本')
      const runAfterTools = this.store.getRun(options.runId)
      if (runAfterTools.state.clarification && !runAfterTools.state.clarification.selectedOptionId) {
        eventSink.emit('clarification.required', runAfterTools.state.clarification.question, {
          clarification: runAfterTools.state.clarification,
        })
        itemSink.appendResult('clarification_needed', {
          decisionId: runAfterTools.state.clarification.clarificationId,
          clarification: runAfterTools.state.clarification,
          message: runAfterTools.state.clarification.question,
        })
        await this.persistSdkState(options.runId, stream.state, assembly)
        await this.store.conversationStore.saveRun(this.store.getRun(options.runId), {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
        await this.store.completeRun(options.runId, 'clarification_needed')
        outcome = 'clarification_needed'
        return outcome
      }
      if (this.store.getRun(options.runId).state.planMode) {
        throw new Error('计划模式必须通过 request_clarification 或 exit_plan_mode 结束。')
      }
      if (!projection.lastAssistantText || projection.lastAssistantText !== finalOutput) {
        const synthetic: AgentInputItem = {
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: finalOutput }],
        }
        const content = assistantText(synthetic)
        if (!content) throw new Error('终止工具未生成可持久化文本')
        const item = itemSink.startItem('message', { role: 'assistant' })
        const persisted = await this.appendAssistantMessageTranscript(assembly, content, item.itemId)
        itemSink.completeItem(item.itemId, {
          body: finalOutput,
          metadata: { transcriptEntryId: persisted.entryId },
        })
      }
      await this.persistSdkState(options.runId, stream.state, assembly)
      await this.store.conversationStore.saveRun(this.store.getRun(options.runId), {
        pendingToolCallIds: [],
        recoveryStatus: 'clean',
      })
      outcome = 'completed'
      return outcome
    } finally {
      if (outcome !== 'waiting_approval') {
        await assembly.sandboxSession.close?.().catch(error => {
          console.warn('[agents-runtime] sandbox close failed:', errorMessage(error))
        })
      }
    }
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
        } else {
          itemId = itemSink.startItem('message', { role: 'assistant' }).itemId
        }
        itemSink.completeItem(itemId, { body: text })
        projection.completedAssistantItems.push({ itemId, text, entryId: null })
        projection.lastAssistantText = text
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
  // 流式 item 只负责实时可见状态；完成后根据 canonical transcript 回填
  // message 或 assistant_content_for_tool_call checkpoint 的身份。
  private async linkAssistantTranscriptEntries(
    runId: string,
    assembly: RuntimeAssembly,
    projection: StreamProjectionState,
    itemSink: ItemSink,
  ): Promise<void> {
    if (!projection.completedAssistantItems.length) return
    if (projection.completedAssistantItems.every(item => item.entryId)) return
    const entries = (await this.store.activeTranscript(assembly.threadId)).filter(entry => (
      entry.runId === runId
      && entry.turnId === assembly.turnId
    ))
    const assistantMessages = entries.filter(entry => (
      entry.kind === 'message'
      && entry.payload.role === 'assistant'
    ))
    const assistantToolContent = entries.filter(isAssistantContentCheckpoint)
    for (const projected of projection.completedAssistantItems) {
      const messageIndex = assistantMessages.findIndex(entry => entry.payload.content === projected.text)
      if (messageIndex >= 0) {
        const [entry] = assistantMessages.splice(messageIndex, 1)
        itemSink.completeItem(projected.itemId, {
          body: projected.text,
          metadata: { transcriptEntryId: entry.entryId },
        })
        projected.entryId = entry.entryId
        continue
      }
      const checkpointIndex = assistantToolContent.findIndex(entry => entry.payload.content === projected.text)
      if (checkpointIndex < 0) throw new Error('SDK Session 未持久化全部 assistant 可见正文')
      const [entry] = assistantToolContent.splice(checkpointIndex, 1)
      itemSink.completeItem(projected.itemId, {
        body: projected.text,
        metadata: {
          transcriptEntryId: entry.entryId,
          assistantContentForCallId: entry.payload.callId,
        },
      })
      projected.entryId = entry.entryId
    }
  }

  private isPlatformManagedTool(toolName: string, runtimeConfig: AgentRuntimeConfig): boolean {
    return Boolean(this.toolRegistry.get(toolName))
      || runtimeConfig.subAgents.some(config => config.agentId === toolName)
  }

  private async appendSandboxNativeToolCallTranscript(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'function_call' }>,
    itemSink: ItemSink,
  ): Promise<void> {
    const args = parseArguments(item.arguments)
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'tool_call',
      payload: {
        callId: item.callId,
        name: item.name,
        arguments: args,
        ledgerStatus: sdkNativeLedgerStatus(item.status),
        source: 'openai_agents_sandbox',
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.callId,
      arguments: item.arguments,
      metadata: { source: 'openai_agents_sandbox' },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.callId,
      body: item.status === 'incomplete' ? 'SDK 沙箱工具执行未完成' : 'SDK 沙箱工具已执行',
      isError: item.status === 'incomplete',
      metadata: { source: 'openai_agents_sandbox' },
    })
  }

  // appendAssistantMessageTranscript
  //
  // 独立 assistant 正文直接进入 transcript；若同一 SDK assistant 消息还
  // 携带 tool_call，则由 appendAssistantContentCheckpoint 绑定到 callId。
  private async appendAssistantMessageTranscript(
    assembly: RuntimeAssembly,
    content: string,
    itemId?: string | null,
  ) {
    return this.store.appendTranscript({
      threadId: assembly.threadId,
      runId: assembly.context.runId,
      turnId: assembly.turnId,
      kind: 'message',
      payload: itemId
        ? { role: 'assistant', content, itemId }
        : { role: 'assistant', content },
    })
  }

  // appendAssistantContentCheckpoint
  //
  // Chat Completions 允许同一 assistant 消息同时包含正文和 tool_calls。
  // transcript 保持工具 ledger append-only，用 checkpoint 按 callId 记录正文归属。
  private async appendAssistantContentCheckpoint(
    assembly: RuntimeAssembly,
    callId: string,
    content: string,
  ) {
    const entries = await this.store.activeTranscript(assembly.threadId)
    const toolCall = entries.find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (!toolCall) throw new Error(`SDK Session 收到未准备的工具调用 '${callId}'`)
    const existingContent = typeof toolCall.payload.assistantContent === 'string' && toolCall.payload.assistantContent.trim()
      ? toolCall.payload.assistantContent.trim()
      : null
    if (existingContent && existingContent !== content) {
      throw new Error(`工具调用 '${callId}' 的 assistant 前导正文不一致`)
    }
    const existingCheckpoint = entries.find(entry => (
      isAssistantContentCheckpoint(entry)
      && entry.payload.callId === callId
    ))
    if (existingCheckpoint) {
      if (existingCheckpoint.payload.content !== content) {
        throw new Error(`工具调用 '${callId}' 的 assistant 前导正文 checkpoint 不一致`)
      }
      return existingCheckpoint
    }
    return this.store.appendTranscript({
      threadId: assembly.threadId,
      runId: assembly.context.runId,
      turnId: assembly.turnId,
      kind: 'checkpoint',
      payload: {
        type: 'assistant_content_for_tool_call',
        callId,
        content,
        source: 'openai_agents_session',
      },
    })
  }

  private async persistApprovals(
    options: RunOptions,
    interruptions: RunToolApprovalItem[],
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<void> {
    const run = this.store.getRun(options.runId)
    const approvals = [...run.state.approvals]
    let decisions = [...run.state.decisions]
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
        title: approvalTitle(toolName, definition?.label),
        description: approvalDescription(toolName, definition?.description),
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
      decisions = upsertDecision(decisions, approvalDecisionFromRequest(request))
      eventSink.emit('approval.required', request.title, { approvalId: request.approvalId, tool: toolName, callId })
      itemSink.appendResult('waiting_approval', {
        decisionId: request.approvalId,
        approvalId: request.approvalId,
        tool: toolName,
        callId,
        title: request.title,
        description: request.description,
        args,
      })
    }
    await this.store.updateRunState(options.runId, { approvals, decisions })
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

  private async maybeExtractLongTermMemories(options: RunOptions, threadId: string, eventSink: RunEventSink): Promise<void> {
    const config = options.runtimeConfig.context
    if (!config.memoryEnabled || !config.memoryAutoExtractEnabled) return
    if (!this.memoryToolsAvailable()) return
    try {
      const selector = this.makeStructuredSelector(options)
      const runtimeMemory = createMemoryRuntime(this.store.runtimeRoot, config)
      await extractMemoriesFromThread(
        runtimeMemory,
        this.store,
        threadId,
        options.runId,
        selector,
      )
      if (config.memoryAutoDreamEnabled) {
        await dreamMemories(runtimeMemory, selector)
      }
    } catch (error) {
      await this.recordWarning(options.runId, `长期记忆自动提取失败：${errorMessage(error)}`, eventSink)
    }
  }

  private makeStructuredSelector(options: RunOptions): (prompt: string) => Promise<Record<string, unknown>> {
    const adapter = this.modelRegistry.resolveProvider(options.runtimeConfig.context.summaryProvider ?? options.provider)
    const model = options.runtimeConfig.context.summaryModel
      ?? adapter.subagentModel
      ?? options.modelName
      ?? adapter.defaultModel
    if (!model) throw new Error('未配置记忆选择模型')
    return async (prompt: string) => {
      const response = await adapter.chat(prompt, { model, reasoning: false })
      const content = response.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('记忆选择模型未返回文本')
      return parseStructuredJson(content)
    }
  }

  private async recordWarning(runId: string, message: string, eventSink: RunEventSink): Promise<void> {
    const run = this.store.getRun(runId)
    await this.store.updateRunState(runId, { warnings: [...run.state.warnings, message] })
    eventSink.emit('warning.raised', message, {})
  }

  private memoryToolsAvailable(): boolean {
    return Boolean(this.toolRegistry.get('list_memories')
      && this.toolRegistry.get('search_memory')
      && this.toolRegistry.get('read_memory')
      && this.toolRegistry.get('write_memory')
      && this.toolRegistry.get('forget_memory'))
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

function isAssistantContentCheckpoint(entry: TranscriptEntry): entry is TranscriptEntry & {
  kind: 'checkpoint'
  payload: Record<string, unknown> & { callId: string; content: string }
} {
  return entry.kind === 'checkpoint'
    && entry.payload.type === 'assistant_content_for_tool_call'
    && typeof entry.payload.callId === 'string'
    && typeof entry.payload.content === 'string'
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

function parseStructuredJson(value: string): Record<string, unknown> {
  const cleaned = value.trim().replace(/^```json\s*|\s*```$/gu, '')
  const parsed: unknown = JSON.parse(cleaned)
  if (!isRecord(parsed)) throw new Error('结构化模型输出必须是 JSON object')
  return parsed
}

function approvalTitle(toolName: string, label?: string): string {
  if (toolName === 'exit_plan_mode') return '接受这个执行计划？'
  return `批准执行：${label ?? toolName}`
}

function approvalDescription(toolName: string, description?: string): string {
  if (toolName === 'exit_plan_mode') {
    return '计划已准备好。批准后系统会退出只读计划模式，并按这个计划继续执行写入、导出或计算动作。'
  }
  return description ?? `工具 ${toolName} 需要审批`
}

function approvalDecisionFromRequest(request: {
  approvalId: string
  action: string
  title: string
  description: string
  status: string
  payload: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
}): DecisionRequest {
  return {
    decisionId: request.approvalId,
    kind: 'approval',
    title: request.title,
    question: request.title,
    description: request.description,
    options: [
      {
        optionId: 'approve',
        label: request.action === 'exit_plan_mode' ? '批准，开始执行' : '批准执行',
        description: '允许系统继续执行这个动作。',
        kind: 'approval',
        reason: null,
        payload: { approved: true },
      },
      {
        optionId: 'reject',
        label: request.action === 'exit_plan_mode' ? '退回，继续规划' : '拒绝',
        description: '拒绝本次动作，运行会按拒绝结果继续。',
        kind: 'approval',
        reason: null,
        payload: { approved: false },
      },
    ],
    allowFreeText: false,
    status: request.status,
    payload: {
      ...request.payload,
      approvalId: request.approvalId,
      action: request.action,
    },
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
  }
}

function upsertDecision(decisions: DecisionRequest[], decision: DecisionRequest): DecisionRequest[] {
  return [...decisions.filter(item => item.decisionId !== decision.decisionId), decision]
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

function requireThreadId(threadId: string | null | undefined): string {
  if (!threadId) throw new Error('连续对话运行必须属于 thread')
  return threadId
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} 不能为空`)
  return value
}

function sdkNativeLedgerStatus(status: 'completed' | 'in_progress' | 'incomplete'): 'started' | 'completed' | 'failed' {
  if (status === 'incomplete') return 'failed'
  if (status === 'in_progress') return 'started'
  return 'completed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
