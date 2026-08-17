// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体运行时公共边界
//
//   文件:       subAgentRuntimeSupport.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  Agent,
  MaxTurnsExceededError,
  ToolTimeoutError,
  type Model,
} from '@openai/agents'
import {
  subAgentDeliverySchema,
  type RuntimeSubAgentConfig,
  type SubAgentDelivery,
  type SubAgentInvocation,
} from '@geo-agent-platform/shared-types/runtime'

import type { ToolRegistry } from '../framework/registry.js'
import {
  resolveAdapterModelCapabilities,
  type ModelAdapter,
} from '../model/registry.js'
import type { LocalAgentTracing } from '../observability/agentTracing.js'
import type { SubAgentState } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { createAgentsTools, type AgentsExecutionContext } from './agentsToolBridge.js'
import { errorMessage, modelSettings } from './runtimeSdkProjection.js'
import { protectModelTransportFromRunInputMarkers } from './runtimeModelInput.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import type { RunEventSink } from './turnRunner.js'
import type { RunToolConcurrencyGate } from './runToolConcurrencyGate.js'
import type { SubAgentControlPlane } from './subAgentControlPlane.js'
import { makeId, nowUtc } from '../utils/ids.js'

export interface SubAgentRuntimeDependencies {
  selectedModel: string
  rootModel: Model
  reasoning: boolean | undefined
  adapter: ModelAdapter
  toolRegistry: ToolRegistry
  approvalTools: ReadonlySet<string>
  store: AgentRuntimeStore
  runId: string
  threadId: string
  eventSink: RunEventSink
  coordinator: ToolExecutionCoordinator
  executionGate: RunToolConcurrencyGate
  subAgentControls: SubAgentControlPlane
  agentTracing?: LocalAgentTracing
}

export function createSubAgentDeliveryAgent(
  config: RuntimeSubAgentConfig,
  dependencies: SubAgentRuntimeDependencies,
  approvalTools: ReadonlySet<string> = dependencies.approvalTools,
): Agent<AgentsExecutionContext, typeof subAgentDeliverySchema> {
  const modelCapabilities = resolveSubAgentModelCapabilities(config, dependencies)
  if (!modelCapabilities.capabilities.structuredOutput) {
    throw new Error(`子智能体模型 '${modelCapabilities.modelId}' 不支持结构化输出`)
  }
  if (config.tools.length && !modelCapabilities.capabilities.toolCalls) {
    throw new Error(`子智能体模型 '${modelCapabilities.modelId}' 不支持工具调用`)
  }
  return new Agent<AgentsExecutionContext, typeof subAgentDeliverySchema>({
    name: config.agentId,
    instructions: async () => {
      await dependencies.subAgentControls.touch(
        dependencies.runId,
        config.agentId,
        '子智能体正在准备模型调用',
      )
      return [
        config.systemPrompt ?? config.summary,
        ...await dependencies.subAgentControls.consumeInstructions(dependencies.runId, config.agentId),
      ].join('\n\n')
    },
    handoffDescription: config.summary,
    model: resolveSubAgentModel(config, dependencies),
    modelSettings: modelSettings(
      dependencies.reasoning,
      modelCapabilities.capabilities.reasoning,
    ),
    outputType: subAgentDeliverySchema,
    tools: createAgentsTools(dependencies.toolRegistry, approvalTools, {
      schemaMode: dependencies.adapter.agentToolSchemaMode,
      allowedToolNames: new Set(config.tools),
    }),
  })
}

export function createSubAgentExecutionContext(
  config: RuntimeSubAgentConfig,
  dependencies: SubAgentRuntimeDependencies,
): AgentsExecutionContext {
  return {
    runId: dependencies.runId,
    currentObjectiveRevision: () => dependencies.coordinator.currentModelInputObjectiveRevision(),
    isExecutionEnabled: () => dependencies.coordinator.isExecutionEnabled(),
    isSdkExtensionEnabled: () => false,
    isToolEnabled: toolName => dependencies.coordinator.isToolEnabledForSubAgent(config.agentId, toolName),
    validateToolCall: (toolName, args) => dependencies.coordinator.validateToolCall(toolName, args),
    formatToolFailureForModel: (toolName, message) => dependencies.coordinator.formatToolFailureForModel(toolName, message),
    rejectPreparedToolCall: (toolName, callId, message) => dependencies.coordinator.rejectPreparedToolCall(toolName, callId, message),
    prepareToolCall: (toolName, args, callId) => dependencies.coordinator.prepare(toolName, args, callId),
    executeTool: (toolName, args, callId) => dependencies.coordinator.executeForSubAgent(
      config.agentId,
      toolName,
      args,
      callId,
    ),
    runToolExecution: (lane, operation) => dependencies.executionGate.run(lane, operation),
    toolOutputMetadata: callId => dependencies.coordinator.toolOutputMetadata(callId),
  }
}

export function subAgentErrorHandlers(config: RuntimeSubAgentConfig) {
  const message = subAgentMaxTurnsMessage(config)
  return {
    maxTurns: () => ({
      finalOutput: {
        status: 'failed' as const,
        summary: message,
        evidence: [],
        artifactIds: [],
        warnings: [],
        error: message,
      },
      includeInHistory: true,
    }),
  }
}

export function formatSubAgentInput(input: SubAgentInvocation): string {
  return [
    `任务目标：${input.objective}`,
    `预期交付：\n${input.expectedDeliverables.map(item => `- ${item}`).join('\n')}`,
    input.contextRefs.length ? `上下文引用：\n${input.contextRefs.map(item => `- ${item}`).join('\n')}` : '',
    input.constraints.length ? `约束：\n${input.constraints.map(item => `- ${item}`).join('\n')}` : '',
    '请只交付 outputType 要求的结构化结果，并为每项关键结论提供证据。',
    'artifactIds 只能填写工具结果 artifacts[].artifactId 中以 artifact_ 开头的真实平台 ID；valueRefs[].refId（ref_ 开头）只能写入 evidence.source。没有 Artifact 时返回空数组。',
  ].filter(Boolean).join('\n\n')
}

export function parseSubAgentDelivery(agentId: string, value: unknown): SubAgentDelivery {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`子 Agent '${agentId}' 返回的结构化结果不是有效 JSON`)
    }
  }
  const result = subAgentDeliverySchema.safeParse(parsed)
  if (!result.success) throw new Error(`子 Agent '${agentId}' 返回结果不符合 delivery 契约`)
  if (result.data.status === 'failed') {
    throw new Error(result.data.error ?? result.data.summary)
  }
  if (result.data.error !== null) {
    throw new Error(`子 Agent '${agentId}' 的完成结果不能包含 error`)
  }
  return result.data
}

export function assertSubAgentDeliveryArtifacts(
  delivery: SubAgentDelivery,
  dependencies: Pick<SubAgentRuntimeDependencies, 'store' | 'runId'>,
): void {
  if (!delivery.artifactIds.length) return
  const run = dependencies.store.getRun(dependencies.runId)
  const owned = new Set(run.state.artifacts.map(artifact => artifact.artifactId))
  const missing = [...new Set(delivery.artifactIds)].filter(artifactId => !owned.has(artifactId))
  if (missing.length) {
    throw new Error(`子 Agent 最终输出引用了当前运行不存在的 Artifact：${missing.join('、')}`)
  }
}

export function subAgentFailureMessage(error: unknown, config: RuntimeSubAgentConfig): string {
  if (error instanceof MaxTurnsExceededError) return subAgentMaxTurnsMessage(config)
  if (error instanceof ToolTimeoutError) {
    return `${config.name}超过单次调用时限 ${config.timeoutMs}ms，已停止。`
  }
  return errorMessage(error)
}

export class SubAgentStateController {
  private mutation: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: SubAgentRuntimeDependencies) {}

  async initialize(configs: RuntimeSubAgentConfig[]): Promise<void> {
    await this.dependencies.store.mutateRunState(this.dependencies.runId, state => {
      const previous = new Map(state.subAgents.map(agent => [agent.agentId, agent]))
      return {
        subAgents: configs.map(config => {
          const prior = previous.get(config.agentId)
          return {
            ...(prior ?? {
              status: 'pending' as const,
              stepIds: [],
              currentStepId: null,
              currentStep: null,
              activeCallId: null,
              latestMessage: null,
              progressPercent: null,
              activityCount: 0,
              startedAt: null,
              completedAt: null,
              lastActivityAt: null,
              stalled: false,
              stalledSince: null,
              resultRefs: [],
              deliveryEvidence: [],
              controls: [],
            }),
            agentId: config.agentId,
            name: config.name,
            role: config.role,
            delegationMode: config.delegationMode,
            summary: config.summary,
            tools: config.tools,
          }
        }),
      }
    })
    const state = this.dependencies.store.getRun(this.dependencies.runId).state
    const handoffConfigs = new Map(
      configs
        .filter(config => config.delegationMode === 'handoff')
        .map(config => [config.agentId, config]),
    )
    const runningHandoffs = state.subAgents.filter(agent => (
      agent.status === 'running' && handoffConfigs.has(agent.agentId)
    ))
    if (runningHandoffs.length > 1) {
      throw new Error(`检测到多个运行中的 Handoff 所有者：${runningHandoffs.map(agent => agent.agentId).join('、')}`)
    }
    const runningHandoff = runningHandoffs[0]
    if (runningHandoff) {
      if (!runningHandoff.activeCallId) {
        throw new Error(`Handoff Agent '${runningHandoff.agentId}' 的持久化运行状态缺少 activeCallId`)
      }
      this.dependencies.coordinator.restoreHandoffOwnership(runningHandoff.agentId)
      const config = handoffConfigs.get(runningHandoff.agentId)
      if (!config) throw new Error(`Handoff Agent '${runningHandoff.agentId}' 缺少运行配置`)
      this.dependencies.subAgentControls.begin({
        runId: this.dependencies.runId,
        agentId: runningHandoff.agentId,
        callId: runningHandoff.activeCallId,
        delegationMode: 'handoff',
        timeoutMs: config.timeoutMs,
      })
    }
  }

  async start(
    config: RuntimeSubAgentConfig,
    invocation: SubAgentInvocation,
    callId: string,
  ): Promise<string | null> {
    const stepId = await this.dependencies.coordinator.beginExternalAgentStep(
      config.agentId,
      invocation,
      callId,
    )
    const startedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: 'running',
      stepIds: stepId && !current.stepIds.includes(stepId) ? [...current.stepIds, stepId] : current.stepIds,
      currentStepId: stepId,
      currentStep: '正在启动子智能体',
      activeCallId: callId,
      latestMessage: '子智能体正在执行',
      progressPercent: 5,
      activityCount: current.activityCount + 1,
      startedAt,
      completedAt: null,
      lastActivityAt: startedAt,
      stalled: false,
      stalledSince: null,
      resultRefs: [],
      deliveryEvidence: [],
    }))
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 正在执行`, {
      agentId: config.agentId,
      callId,
      status: 'running',
      stepId,
    })
    return stepId
  }

  async resume(
    config: RuntimeSubAgentConfig,
    callId: string,
  ): Promise<string | null> {
    const state = this.dependencies.store.getRun(this.dependencies.runId).state
    const subAgent = state.subAgents.find(candidate => candidate.agentId === config.agentId)
    if (!subAgent || subAgent.status !== 'running') {
      throw new Error(`子 Agent '${config.agentId}' 没有可恢复的运行中状态`)
    }
    const stepId = subAgent.currentStepId
    this.dependencies.coordinator.restoreExternalAgentStep(
      config.agentId,
      callId,
      stepId,
    )
    await this.update(config.agentId, current => ({
      ...current,
      activeCallId: callId,
      currentStep: '正在恢复子智能体调用',
      lastActivityAt: nowUtc(),
      stalled: false,
      stalledSince: null,
    }))
    return stepId
  }

  async complete(
    config: RuntimeSubAgentConfig,
    callId: string,
    stepId: string | null,
    delivery: SubAgentDelivery,
  ): Promise<void> {
    await this.dependencies.coordinator.completeExternalAgentStep(callId, delivery.summary)
    const completedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: current.status === 'cancelling' ? 'cancelled' : 'completed',
      currentStepId: null,
      currentStep: null,
      activeCallId: null,
      latestMessage: current.status === 'cancelling' ? '子智能体已按用户请求取消' : delivery.summary,
      progressPercent: current.status === 'cancelling' ? current.progressPercent : 100,
      completedAt,
      lastActivityAt: completedAt,
      stalled: false,
      stalledSince: null,
      resultRefs: [...new Set([
        ...delivery.evidence.map(evidence => evidence.source),
        ...delivery.artifactIds,
      ])],
      deliveryEvidence: delivery.evidence,
    }))
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 已完成`, {
      agentId: config.agentId,
      callId,
      status: 'completed',
      stepId,
    })
  }

  async fail(
    config: RuntimeSubAgentConfig,
    callId: string,
    stepId: string | null,
    message: string,
  ): Promise<void> {
    await this.dependencies.coordinator.failExternalAgentStep(callId, message)
    const completedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: 'failed',
      currentStepId: null,
      currentStep: null,
      activeCallId: null,
      latestMessage: message,
      completedAt,
      lastActivityAt: completedAt,
      stalled: false,
      stalledSince: null,
    }))
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 执行失败`, {
      agentId: config.agentId,
      callId,
      status: 'failed',
      stepId,
    })
  }

  async startHandoff(config: RuntimeSubAgentConfig): Promise<void> {
    const callId = makeId('handoff')
    this.dependencies.subAgentControls.begin({
      runId: this.dependencies.runId,
      agentId: config.agentId,
      callId,
      delegationMode: 'handoff',
      timeoutMs: config.timeoutMs,
    })
    this.dependencies.coordinator.activateHandoff(config.agentId)
    const startedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: 'running',
      activeCallId: callId,
      currentStep: 'Handoff 已接管对话',
      latestMessage: '已取得当前对话的处理权',
      progressPercent: 10,
      activityCount: current.activityCount + 1,
      startedAt,
      completedAt: null,
      lastActivityAt: startedAt,
      stalled: false,
      stalledSince: null,
    }))
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 已接管当前对话`, {
      agentId: config.agentId,
      callId,
      status: 'running',
      delegationMode: 'handoff',
    })
  }

  async completeHandoff(config: RuntimeSubAgentConfig, summary: string): Promise<void> {
    const callId = this.requireActiveCallId(config.agentId)
    this.dependencies.coordinator.finishHandoff(config.agentId)
    const completedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: current.status === 'cancelling' ? 'cancelled' : 'completed',
      currentStepId: null,
      currentStep: null,
      activeCallId: null,
      latestMessage: current.status === 'cancelling' ? 'Handoff 子智能体已按请求结束' : summary,
      progressPercent: current.status === 'cancelling' ? current.progressPercent : 100,
      completedAt,
      lastActivityAt: completedAt,
      stalled: false,
      stalledSince: null,
    }))
    this.dependencies.subAgentControls.finish(
      this.dependencies.runId,
      config.agentId,
      callId,
    )
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 已完成接管任务`, {
      agentId: config.agentId,
      callId,
      status: 'completed',
      delegationMode: 'handoff',
    })
  }

  async failHandoff(config: RuntimeSubAgentConfig, message: string): Promise<void> {
    const callId = this.requireActiveCallId(config.agentId)
    this.dependencies.coordinator.finishHandoff(config.agentId)
    const completedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: 'failed',
      currentStepId: null,
      currentStep: null,
      activeCallId: null,
      latestMessage: message,
      completedAt,
      lastActivityAt: completedAt,
      stalled: false,
      stalledSince: null,
    }))
    this.dependencies.subAgentControls.finish(
      this.dependencies.runId,
      config.agentId,
      callId,
    )
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 接管后失败`, {
      agentId: config.agentId,
      callId,
      status: 'failed',
      delegationMode: 'handoff',
    })
  }

  async cancel(
    config: RuntimeSubAgentConfig,
    callId: string,
    stepId: string | null,
    message: string,
  ): Promise<void> {
    await this.dependencies.coordinator.failExternalAgentStep(callId, message)
    const completedAt = nowUtc()
    await this.update(config.agentId, current => ({
      ...current,
      status: 'cancelled',
      currentStepId: null,
      currentStep: null,
      activeCallId: null,
      latestMessage: message,
      completedAt,
      lastActivityAt: completedAt,
      stalled: false,
      stalledSince: null,
    }))
    this.dependencies.eventSink.emit('subagent.updated', `${config.name} 已取消`, {
      agentId: config.agentId,
      callId,
      status: 'cancelled',
      stepId,
    })
  }

  activity(config: RuntimeSubAgentConfig, currentStep: string): Promise<void> {
    return this.dependencies.subAgentControls.touch(
      this.dependencies.runId,
      config.agentId,
      currentStep,
    )
  }

  private requireActiveCallId(agentId: string): string {
    const subAgent = this.dependencies.store.getRun(this.dependencies.runId).state.subAgents
      .find(candidate => candidate.agentId === agentId)
    if (!subAgent?.activeCallId) {
      throw new Error(`子 Agent '${agentId}' 的运行状态缺少 activeCallId`)
    }
    return subAgent.activeCallId
  }

  private update(agentId: string, operation: (state: SubAgentState) => SubAgentState): Promise<void> {
    const pending = this.mutation.then(async () => {
      await this.dependencies.store.mutateRunState(this.dependencies.runId, state => {
        const subAgent = state.subAgents.find(candidate => candidate.agentId === agentId)
        if (!subAgent) throw new Error(`子 Agent '${agentId}' 的运行状态不存在`)
        return {
          subAgents: state.subAgents.map(candidate => candidate.agentId === agentId
            ? operation(candidate)
            : candidate),
        }
      })
    }, async () => {
      await this.dependencies.store.mutateRunState(this.dependencies.runId, state => {
        const subAgent = state.subAgents.find(candidate => candidate.agentId === agentId)
        if (!subAgent) throw new Error(`子 Agent '${agentId}' 的运行状态不存在`)
        return {
          subAgents: state.subAgents.map(candidate => candidate.agentId === agentId
            ? operation(candidate)
            : candidate),
        }
      })
    })
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }
}

export function resolveSubAgentModel(config: RuntimeSubAgentConfig, dependencies: SubAgentRuntimeDependencies): Model {
  const modelName = config.model ?? dependencies.selectedModel
  if (modelName === dependencies.selectedModel) return dependencies.rootModel
  if (!dependencies.adapter.createAgentModel) {
    throw new Error(`模型 provider '${dependencies.adapter.provider}' 不支持创建子智能体模型`)
  }
  return protectModelTransportFromRunInputMarkers(
    dependencies.adapter.createAgentModel(modelName),
  )
}

export function resolveSubAgentModelCapabilities(
  config: RuntimeSubAgentConfig,
  dependencies: Pick<SubAgentRuntimeDependencies, 'adapter' | 'selectedModel'>,
) {
  return resolveAdapterModelCapabilities(
    dependencies.adapter,
    config.model ?? dependencies.selectedModel,
  )
}

function subAgentMaxTurnsMessage(config: RuntimeSubAgentConfig): string {
  return `${config.name}已达到最大运行轮次 ${config.maxTurns}，为避免循环调用已停止。`
}
