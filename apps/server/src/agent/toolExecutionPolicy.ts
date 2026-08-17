// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行策略
//
//   文件:       toolExecutionPolicy.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentState } from '@geo-agent-platform/shared-types'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import type { ToolRegistry } from '../framework/registry.js'

export const DEVELOPER_TOOL_PROVIDER_ID = 'geo-platform-developer-tools'

export function developerToolsEnabledForRuntime(config: AgentRuntimeConfig): boolean {
  return config.developer.enabled && config.developer.allowedRoots.length > 0
}

export interface ToolExecutionPolicyDependencies {
  registry: ToolRegistry
  state: () => AgentState
  claimedWorkflowSteps: () => ReadonlySet<string>
  externalAgentCalls: () => ReadonlyMap<string, string>
  developerModeEnabled?: () => boolean
}

/**
 * 只拥有“当前运行允许什么”的策略，不写 Run、Transcript 或 checkpoint。
 * Coordinator 负责执行和提交；将这组规则隔离后，计划/工作流边界可以单独
 * 测试，也不会因新增一种 transport 而复制副作用判断。
 */
export class ToolExecutionPolicy {
  private activeHandoffAgentId: string | null = null

  constructor(private readonly dependencies: ToolExecutionPolicyDependencies) {}

  isExecutionEnabled(): boolean {
    return !this.dependencies.state().planMode
  }

  isSdkExtensionEnabled(): boolean {
    const state = this.dependencies.state()
    return !state.planMode && state.agentWorkflow === null
  }

  isToolEnabled(toolName: string): boolean {
    const tool = this.dependencies.registry.get(toolName)
    if (!tool) return false
    if (!this.isDeveloperToolAllowed(tool.providerId)) return false
    const state = this.dependencies.state()
    if (state.planMode) return tool.isReadOnly && !tool.isDestructive
    if (!state.agentWorkflow) return true
    if (state.agentWorkflow.status === 'cancelled') return false
    if (ACTIVE_WORKFLOW_CONTROL_TOOLS.has(toolName)) return true
    if (state.agentWorkflow.status === 'adjusting' || state.agentWorkflow.status === 'completed') {
      return tool.isReadOnly && !tool.isDestructive
    }
    return this.hasReadyWorkflowStep(toolName, 'supervisor')
  }

  isExternalAgentEnabled(agentId: string): boolean {
    const state = this.dependencies.state()
    return !state.planMode && (
      this.hasReadyWorkflowStep(agentId, agentId)
      || this.hasRunningExternalAgentStep(agentId)
    )
  }

  isHandoffEnabled(agentId: string): boolean {
    const state = this.dependencies.state()
    if (state.planMode || state.agentWorkflow !== null) return false
    if (this.activeHandoffAgentId === null) return true
    if (this.activeHandoffAgentId !== agentId) return false
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    return owner?.status === 'running' && Boolean(owner.activeCallId)
  }

  activateHandoff(agentId: string): void {
    if (!this.isHandoffEnabled(agentId)) {
      throw new Error(`当前运行边界禁止转交给子智能体 '${agentId}'`)
    }
    this.activeHandoffAgentId = agentId
  }

  restoreHandoffOwnership(agentId: string): void {
    const state = this.dependencies.state()
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    if (state.planMode
      || state.agentWorkflow !== null
      || !owner
      || owner.status !== 'running'
      || !owner.activeCallId) {
      throw new Error(`Handoff 子智能体 '${agentId}' 没有可恢复的对话所有权`)
    }
    if (this.activeHandoffAgentId && this.activeHandoffAgentId !== agentId) {
      throw new Error(`Handoff 所有权已属于 '${this.activeHandoffAgentId}'，不能恢复 '${agentId}'`)
    }
    this.activeHandoffAgentId = agentId
  }

  finishHandoff(agentId: string): void {
    if (this.activeHandoffAgentId === agentId) this.activeHandoffAgentId = null
  }

  activeHandoffAgent(): string | null {
    return this.activeHandoffAgentId
  }

  isToolEnabledForHandoff(agentId: string, toolName: string): boolean {
    const state = this.dependencies.state()
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    const tool = this.dependencies.registry.get(toolName)
    return this.activeHandoffAgentId === agentId
      && owner?.status === 'running'
      && Boolean(owner.activeCallId)
      && Boolean(tool)
      && this.isDeveloperToolAllowed(tool?.providerId)
      && this.isHandoffEnabled(agentId)
  }

  assertHandoffToolExecutionAllowed(agentId: string, toolName: string): void {
    const state = this.dependencies.state()
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    if (owner?.status === 'cancelling' || owner?.status === 'cancelled') {
      throw new Error(`subagent_cancelled: Handoff 子智能体 '${agentId}' 已接受取消请求，禁止启动新的工具 '${toolName}'。`)
    }
    if (!this.isToolEnabledForHandoff(agentId, toolName)) {
      throw new Error(`Handoff 子智能体 '${agentId}' 当前无权执行工具 '${toolName}'。`)
    }
  }

  isToolEnabledForSubAgent(agentId: string, toolName: string): boolean {
    const tool = this.dependencies.registry.get(toolName)
    return Boolean(tool)
      && this.isDeveloperToolAllowed(tool?.providerId)
      && this.isExecutionEnabled()
      && [...this.dependencies.externalAgentCalls().values()].some(candidate => candidate === agentId)
  }

  assertPlanModeAllows(toolName: string): void {
    if (this.activeHandoffAgentId) {
      this.assertHandoffToolExecutionAllowed(this.activeHandoffAgentId, toolName)
    }
    const state = this.dependencies.state()
    if (!state.planMode) return
    const tool = this.dependencies.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.isReadOnly && !tool.isDestructive) return
    throw new Error(`计划模式只允许无副作用的读取工具，工具 '${toolName}' 会产生写入或外部影响。请先提交工作流结束规划阶段。`)
  }

  assertExecutionPhaseAllowsExternalAgent(agentId: string): void {
    if (this.isExecutionEnabled()) return
    throw new Error(`计划模式禁止调用子智能体 '${agentId}'。请先用 submit_agent_workflow 记录工作流并开始执行。`)
  }

  assertExternalAgentIsRunning(agentId: string): void {
    const running = [...this.dependencies.externalAgentCalls().values()].some(candidate => candidate === agentId)
    if (!running) {
      throw new Error(`子智能体 '${agentId}' 没有正在执行的已批准工作流步骤，不能调用平台工具。`)
    }
  }

  private hasReadyWorkflowStep(toolName: string, ownerAgentId: string): boolean {
    const workflow = this.dependencies.state().agentWorkflow
    if (!workflow || workflow.status !== 'running') return false
    const completed = new Set(workflow.steps
      .filter(step => step.status === 'completed' || step.status === 'skipped')
      .map(step => step.stepId))
    const claimed = this.dependencies.claimedWorkflowSteps()
    return workflow.steps.some(step => (
      step.status === 'pending'
      && step.toolName === toolName
      && step.ownerAgentId === ownerAgentId
      && !claimed.has(step.stepId)
      && step.dependsOn.every(dependency => completed.has(dependency))
    ))
  }

  private hasRunningExternalAgentStep(agentId: string): boolean {
    const state = this.dependencies.state()
    const subAgent = state.subAgents.find(candidate => (
      candidate.agentId === agentId
      && candidate.status === 'running'
      && candidate.currentStepId
    ))
    if (!subAgent?.currentStepId || state.agentWorkflow?.status !== 'running') return false
    return state.agentWorkflow.steps.some(step => (
      step.stepId === subAgent.currentStepId
      && step.status === 'running'
      && step.kind === 'agent'
      && step.toolName === agentId
      && step.ownerAgentId === agentId
    ))
  }

  private isDeveloperToolAllowed(providerId?: string): boolean {
    return providerId !== DEVELOPER_TOOL_PROVIDER_ID
      || this.dependencies.developerModeEnabled?.() === true
  }
}

const ACTIVE_WORKFLOW_CONTROL_TOOLS = new Set([
  'request_clarification',
  'revise_agent_workflow',
])
