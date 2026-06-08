// +-------------------------------------------------------------------------
//
//   地理智能平台 - Debug 诊断派生工具
//
//   文件:       diagnostics.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// DebugPage 的纯诊断派生逻辑：状态文案、supervisor 阶段、
// sub-agent 归因和 loop trace 投影。聊天预览仍只从 ConversationItem 派生。

import type { AgentState, ExecutionPlan, LoopTraceEntry, RunEvent, UserIntent } from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../../api/client'

export function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}

export function compactPath(value?: string | null) {
  if (!value) {
    return '暂无路径'
  }
  return value.length > 42 ? `…${value.slice(-41)}` : value
}

export function formatRunStatus(status?: string) {
  if (status === 'completed') {
    return '分析完成'
  }
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'cancelled') {
    return '已取消'
  }
  if (status === 'failed') {
    return '运行失败'
  }
  if (status === 'running') {
    return '执行中'
  }
  return '待命'
}

export function deriveTone(status?: string): 'neutral' | 'success' | 'warning' | 'accent' | 'danger' {
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'waiting_approval') {
    return 'warning'
  }
  if (status === 'clarification_needed') {
    return 'warning'
  }
  if (status === 'cancelled') {
    return 'danger'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'running') {
    return 'accent'
  }
  return 'neutral'
}

export function buildQuickLinks({
  currentSessionId,
  currentRunId,
  selectedArtifactId,
}: {
  currentSessionId?: string
  currentRunId?: string
  selectedArtifactId?: string
}) {
  return [
    currentSessionId
      ? {
          label: '会话运行列表',
          description: '查看当前 session 的所有运行记录',
          href: `${apiBaseUrl}/api/v1/sessions/${currentSessionId}/runs`,
        }
      : null,
    currentRunId
      ? {
          label: '当前运行产物',
          description: '直接检查本次分析生成的 artifact 列表',
          href: `${apiBaseUrl}/api/v2/runs/${currentRunId}/artifacts`,
        }
      : null,
    {
      label: '系统图层目录',
      description: '检查可用图层、类型与要素数',
      href: `${apiBaseUrl}/api/v1/layers`,
    },
    selectedArtifactId
      ? {
          label: '当前结果元数据',
          description: '查看被选中结果的原始 metadata',
          href: `${apiBaseUrl}/api/v1/results/${selectedArtifactId}/metadata`,
        }
      : null,
  ].flatMap((item) => (item ? [item] : []))
}

export function buildSupervisorStages({
  query,
  runStatus,
  intent,
  executionPlan,
  todos,
  subAgents,
  approvals,
  toolCalls,
  events,
}: {
  query: string
  runStatus?: string
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  todos: AgentState['todos']
  subAgents: AgentState['subAgents']
  approvals: AgentState['approvals']
  toolCalls: AgentState['toolResults']
  events: RunEvent[]
}) {
  const hasEvent = (type: RunEvent['type']) => events.some((event) => event.type === type)
  const hasPendingApproval = approvals.some((approval) => approval.status === 'pending')
  const allApprovalsResolved = approvals.length > 0 && approvals.every((approval) => approval.status !== 'pending')
  const hasFailure =
    runStatus === 'failed' ||
    runStatus === 'cancelled' ||
    todos.some((todo) => todo.status === 'failed') ||
    subAgents.some((agent) => agent.status === 'failed') ||
    toolCalls.some((tool) => tool.status === 'failed')
  const hasRunningExecution =
    todos.some((todo) => todo.status === 'running') ||
    subAgents.some((agent) => agent.status === 'running') ||
    toolCalls.some((tool) => tool.status === 'running')
  const allTodosCompleted = todos.length > 0 && todos.every((todo) => todo.status === 'completed')
  const executionStarted = hasEvent('step.started') || hasEvent('tool.started') || toolCalls.length > 0 || todos.length > 0

  return [
    {
      id: 'input',
      title: '接收任务',
      status: query.trim() ? 'completed' : 'pending',
      description: query.trim() ? '用户问题已经进入当前 thread/run。' : '等待新的空间分析请求进入。 ',
    },
    {
      id: 'intent',
      title: '解析意图',
      status: hasFailure ? 'failed' : intent || hasEvent('intent.parsed') ? 'completed' : runStatus === 'running' ? 'running' : 'pending',
      description: intent ? '主 agent 已识别查询区域、目标图层和空间约束。' : '等待 supervisor 解析用户意图与歧义。',
    },
    {
      id: 'planning',
      title: '拆分计划',
      status:
        hasFailure
          ? 'failed'
          : executionPlan || hasEvent('plan.ready')
            ? 'completed'
            : intent || hasEvent('intent.parsed')
              ? 'running'
              : 'pending',
      description: executionPlan ? `已拆出 ${executionPlan.steps.length} 个执行步骤，并回写到运行状态。` : '等待把用户问题落成可执行的 todo 和步骤。',
    },
    {
      id: 'execution',
      title: '调度执行',
      status: hasFailure ? 'failed' : hasRunningExecution ? 'running' : allTodosCompleted || runStatus === 'waiting_approval' || runStatus === 'completed' ? 'completed' : executionStarted ? 'running' : 'pending',
      description:
        todos.length || toolCalls.length
          ? `当前共有 ${todos.length} 个 todo，记录了 ${toolCalls.length} 次工具调用。`
          : '尚未进入工具调用与子智能体执行阶段。',
    },
    {
      id: 'approval',
      title: '审批节点',
      status: hasPendingApproval ? 'blocked' : allApprovalsResolved ? 'completed' : approvals.length ? 'running' : 'pending',
      description:
        approvals.length
          ? `${approvals.length} 个审批节点已进入运行状态，发布和 execute 这类敏感动作会在这里停住。`
          : '本次运行没有产生审批请求，supervisor 可以直接完成交付。',
    },
    {
      id: 'delivery',
      title: '结果交付',
      status:
        hasFailure
          ? 'failed'
          : runStatus === 'completed'
            ? 'completed'
            : runStatus === 'waiting_approval'
              ? 'running'
              : executionStarted
                ? 'running'
                : 'pending',
      description:
        runStatus === 'completed'
          ? '最终总结已经写回，结果可以被地图、历史和下载入口消费。'
          : runStatus === 'waiting_approval'
            ? '结果已经生成，但还在等待审批通过后继续交付。'
            : '最终总结和交付说明还在生成中。',
    },
  ]
}

export function buildSupervisorFocus({
  runStatus,
  todos,
  subAgents,
  approvals,
  toolCalls,
  events,
  finalSummary,
}: {
  runStatus?: string
  todos: AgentState['todos']
  subAgents: AgentState['subAgents']
  approvals: AgentState['approvals']
  toolCalls: AgentState['toolResults']
  events: RunEvent[]
  finalSummary?: string
}) {
  const runningTodo = todos.find((todo) => todo.status === 'running')
  if (runStatus === 'waiting_approval') {
    const pendingApproval = approvals.find((approval) => approval.status === 'pending')
    return {
      title: pendingApproval?.title ?? '等待审批',
      description: pendingApproval?.description ?? '主 agent 已停在审批节点，等待人工确认敏感动作。',
    }
  }
  if (runningTodo) {
    return {
      title: runningTodo.title,
      description: runningTodo.description ?? '主 agent 正在推进当前 todo。',
    }
  }
  const runningSubAgent = subAgents.find((agent) => agent.status === 'running')
  if (runningSubAgent) {
    return {
      title: `${runningSubAgent.name} 正在执行`,
      description: runningSubAgent.latestMessage ?? runningSubAgent.summary,
    }
  }
  const runningTool = toolCalls.find((tool) => tool.status === 'running')
  if (runningTool) {
    return {
      title: runningTool.tool,
      description: runningTool.message,
    }
  }
  if (runStatus === 'completed' && finalSummary) {
    return {
      title: '运行完成',
      description: finalSummary,
    }
  }
  const latestMeaningfulEvent = events.at(-1)
  return {
    title: latestMeaningfulEvent?.type ?? '等待执行',
    description: latestMeaningfulEvent?.message ?? '当前还没有可展示的主 agent 轨迹。',
  }
}

export function buildSubAgentDiagnostic(
  agent: AgentState['subAgents'][number],
  todos: AgentState['todos'],
  toolCalls: AgentState['toolResults'],
  events: RunEvent[],
) {
  const ownedTodos = todos.filter((todo) => todo.ownerAgentId === agent.agentId || (todo.stepId ? agent.stepIds.includes(todo.stepId) : false))
  const completedTodos = ownedTodos.filter((todo) => todo.status === 'completed').length
  const recentEvents = events
    .filter((event) => isEventOwnedByAgent(event, agent))
    .slice(-3)
    .reverse()
  const latestToolCall = [...toolCalls].reverse().find((tool) => agent.tools.includes(tool.tool))

  return {
    agent,
    progressLabel: ownedTodos.length ? `${completedTodos}/${ownedTodos.length} todo 完成` : `${agent.tools.length} 个专属工具`,
    currentWork: agent.currentStepId ?? latestToolCall?.tool ?? '当前待命',
    latestMessage: agent.latestMessage ?? latestToolCall?.message ?? agent.summary,
    recentEvents,
  }
}

function isEventOwnedByAgent(event: RunEvent, agent: AgentState['subAgents'][number]) {
  const payload = event.payload ?? {}
  const eventAgentId = toStringValue(payload.agentId) ?? toStringValue(payload.agent_id)
  const eventAgentName = toStringValue(payload.name)
  const payloadTool = toStringValue(payload.tool)
  return (
    eventAgentId === agent.agentId ||
    eventAgentName === agent.name ||
    Boolean(payloadTool && agent.tools.includes(payloadTool))
  )
}

function toStringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function deriveLoopTraceFromEvents(events: RunEvent[]): LoopTraceEntry[] {
  const entries: LoopTraceEntry[] = []
  for (const event of events) {
    if (event.type === 'loop.updated') {
      const payload = event.payload ?? {}
      entries.push({
        iteration: Number(payload.iteration ?? 0),
        phase: String(payload.phase ?? 'observe'),
        title: String(payload.title ?? event.message),
        description: String(payload.description ?? event.message),
        status: String(payload.status ?? 'running') as LoopTraceEntry['status'],
        timestamp: String(payload.timestamp ?? event.timestamp),
        agentId: typeof payload.agentId === 'string' ? payload.agentId : null,
        toolName: typeof payload.toolName === 'string' ? payload.toolName : null,
        stepId: typeof payload.stepId === 'string' ? payload.stepId : null,
      })
      continue
    }
    // 从 tool 事件中提取 loop 信息作为回退
    if ((event.type === 'tool.started' || event.type === 'tool.completed') && event.payload) {
      const p = event.payload as Record<string, unknown>
      const loopPhase = typeof p.loopPhase === 'string' ? p.loopPhase : undefined
      const loopIteration = typeof p.loopIteration === 'number' ? p.loopIteration : undefined
      if (loopPhase && loopIteration !== undefined) {
        entries.push({
          iteration: loopIteration,
          phase: loopPhase,
          title: event.type === 'tool.started'
            ? `调用工具 ${String(p.tool ?? '')}`
            : `工具 ${String(p.tool ?? '')} 完成`,
          description: event.message,
          status: event.type === 'tool.started' ? 'running' : 'completed',
          timestamp: event.timestamp,
          agentId: null,
          toolName: typeof p.tool === 'string' ? p.tool : null,
          stepId: null,
        })
      }
    }
  }
  return entries
}

export function formatExecutionStatus(status?: string) {
  if (status === 'completed') {
    return '已完成'
  }
  if (status === 'running') {
    return '执行中'
  }
  if (status === 'blocked') {
    return '阻塞中'
  }
  if (status === 'failed') {
    return '失败'
  }
  return '待命'
}

export function deriveExecutionTone(status?: string): 'neutral' | 'success' | 'warning' | 'accent' | 'danger' {
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'running') {
    return 'accent'
  }
  if (status === 'blocked') {
    return 'warning'
  }
  if (status === 'failed') {
    return 'danger'
  }
  return 'neutral'
}

export function formatApprovalStatus(status?: string) {
  if (status === 'approved') {
    return '已批准'
  }
  if (status === 'rejected') {
    return '已拒绝'
  }
  return '待审批'
}

export function formatLoopPhase(phase?: string) {
  if (phase === 'observe') {
    return '观察'
  }
  if (phase === 'decide') {
    return '决策'
  }
  if (phase === 'act') {
    return '执行'
  }
  if (phase === 'observe_result') {
    return '吸收结果'
  }
  if (phase === 'approval') {
    return '审批'
  }
  if (phase === 'deliver') {
    return '交付'
  }
  if (phase === 'failed') {
    return '失败'
  }
  return '待命'
}

export function deriveApprovalTone(status?: string): 'neutral' | 'success' | 'warning' | 'accent' | 'danger' {
  if (status === 'approved') {
    return 'success'
  }
  if (status === 'rejected') {
    return 'danger'
  }
  return 'warning'
}

export function formatPlaceResolutionStatus(status?: string) {
  if (status === 'resolved') {
    return '已解析'
  }
  if (status === 'ambiguous') {
    return '待澄清'
  }
  if (status === 'not_found') {
    return '未找到'
  }
  if (status === 'failed') {
    return '解析失败'
  }
  if (status === 'unresolved') {
    return '未触发'
  }
  return '未知'
}
