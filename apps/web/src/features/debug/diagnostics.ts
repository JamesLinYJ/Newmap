// +-------------------------------------------------------------------------
//
//   地理智能平台 - DebugPage 诊断派生
//
//   文件:       diagnostics.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  ApprovalRequest,
  ExecutionPlan,
  LoopTraceEntry,
  RunEvent,
  SubAgentState,
  TodoItem,
  ToolCall,
  UserIntent,
} from '@geo-agent-platform/shared-types'
import type { StatusPillTone } from '../../shared/components/StatusPill'

type ExecutionTone = 'neutral' | 'success' | 'warning' | 'accent' | 'danger'

export function shortId(id?: string | null) {
  if (!id) return '--'
  return id.length <= 10 ? id : id.slice(-8)
}

export function compactPath(path?: string | null) {
  if (!path) return '未记录'
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.length <= 3 ? normalized : `.../${parts.slice(-3).join('/')}`
}

export function formatRunStatus(status?: string) {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '运行中'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'clarification_needed') return '待澄清'
  if (status === 'requires_action') return '需处理'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '已中断'
  return '准备就绪'
}

export function deriveTone(status?: string): ExecutionTone {
  if (status === 'completed') return 'success'
  if (status === 'running' || status === 'queued') return 'accent'
  if (status === 'waiting_approval' || status === 'clarification_needed' || status === 'requires_action') return 'warning'
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 'danger'
  return 'neutral'
}

export function formatExecutionStatus(status?: string) {
  if (status === 'completed' || status === 'done') return '完成'
  if (status === 'running' || status === 'in_progress') return '运行中'
  if (status === 'pending' || status === 'queued') return '等待'
  if (status === 'failed') return '失败'
  if (status === 'blocked') return '受阻'
  if (status === 'cancelled') return '取消'
  return status || '未知'
}

export function deriveExecutionTone(status?: string): StatusPillTone {
  if (status === 'completed' || status === 'done') return 'success'
  if (status === 'running' || status === 'in_progress') return 'accent'
  if (status === 'pending' || status === 'queued' || status === 'blocked') return 'warning'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  return 'neutral'
}

export function formatApprovalStatus(status?: string) {
  if (status === 'approved') return '已同意'
  if (status === 'rejected') return '已拒绝'
  if (status === 'pending') return '待审批'
  return status || '未知'
}

export function deriveApprovalTone(status?: string): StatusPillTone {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'pending') return 'warning'
  return 'neutral'
}

export function formatLoopPhase(phase?: string | null) {
  if (!phase) return '未开始'
  const labels: Record<string, string> = {
    idle: '空闲',
    planning: '规划',
    tool_execution: '工具执行',
    tool_result: '工具结果',
    responding: '生成回答',
    finalizing: '收尾',
    failed: '失败',
  }
  return labels[phase] ?? phase
}

export function formatPlaceResolutionStatus(status?: string | null) {
  if (!status) return '未解析'
  if (status === 'resolved') return '已解析'
  if (status === 'unresolved') return '未解析'
  if (status === 'ambiguous') return '候选待选'
  if (status === 'failed') return '解析失败'
  return status
}

export function deriveLoopTraceFromEvents(events: RunEvent[]): LoopTraceEntry[] {
  return events.slice(-16).map((event, index) => ({
    iteration: index + 1,
    phase: String(event.payload?.phase ?? event.type),
    title: event.type,
    description: event.message,
    status: event.type.includes('failed') ? 'failed' : 'completed',
    timestamp: event.timestamp,
    agentId: typeof event.payload?.agentId === 'string' ? event.payload.agentId : null,
    toolName: typeof event.payload?.toolName === 'string' ? event.payload.toolName : null,
    stepId: typeof event.payload?.stepId === 'string' ? event.payload.stepId : null,
  }))
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
  todos: TodoItem[]
  subAgents: SubAgentState[]
  approvals: ApprovalRequest[]
  toolCalls: ToolCall[]
  events: RunEvent[]
}) {
  return [
    {
      id: 'input',
      title: '接收问题',
      description: query ? `当前输入：${query}` : '等待用户输入空间或气象分析需求。',
      status: query || events.length ? 'completed' : 'pending',
    },
    {
      id: 'intent',
      title: '理解意图',
      description: intent ? summarizeIntent(intent) : '尚未生成结构化意图。',
      status: intent ? 'completed' : runStatus === 'running' ? 'running' : 'pending',
    },
    {
      id: 'plan',
      title: '规划执行',
      description: executionPlan?.steps.length ? `${executionPlan.steps.length} 个步骤：${executionPlan.goal}` : '尚未形成执行计划。',
      status: executionPlan?.steps.length ? 'completed' : runStatus === 'running' ? 'running' : 'pending',
    },
    {
      id: 'tools',
      title: '工具与子智能体',
      description: `${toolCalls.length} 次工具调用，${subAgents.length} 个子智能体，${todos.length} 个 Todo。`,
      status: toolCalls.some(item => item.status === 'failed') ? 'failed' : toolCalls.some(item => item.status === 'running') ? 'running' : toolCalls.length ? 'completed' : 'pending',
    },
    {
      id: 'approval',
      title: '审批边界',
      description: approvals.some(item => item.status === 'pending') ? '存在待审批动作。' : '当前没有待审批动作。',
      status: approvals.some(item => item.status === 'pending') ? 'blocked' : 'completed',
    },
    {
      id: 'delivery',
      title: '交付结果',
      description: runStatus === 'completed' ? '运行已完成，结果可在地图或下载区查看。' : '等待最终回答或 artifact。',
      status: runStatus === 'completed' ? 'completed' : deriveExecutionStatus(runStatus),
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
  todos: TodoItem[]
  subAgents: SubAgentState[]
  approvals: ApprovalRequest[]
  toolCalls: ToolCall[]
  events: RunEvent[]
  finalSummary?: string
}) {
  const pendingApproval = approvals.find(item => item.status === 'pending')
  if (pendingApproval) {
    return { title: '等待审批', description: pendingApproval.title }
  }
  const runningTool = toolCalls.find(item => item.status === 'running')
  if (runningTool) {
    return { title: '工具执行中', description: `${runningTool.tool}：${runningTool.message}` }
  }
  const runningTodo = todos.find(item => item.status === 'running')
  if (runningTodo) {
    return { title: '推进 Todo', description: runningTodo.activeForm || runningTodo.title }
  }
  const runningAgent = subAgents.find(item => item.status === 'running')
  if (runningAgent) {
    return { title: runningAgent.name, description: runningAgent.latestMessage || runningAgent.summary || '子智能体运行中。' }
  }
  if (runStatus === 'completed') {
    return { title: '已完成', description: finalSummary || '运行已交付最终结果。' }
  }
  return {
    title: formatRunStatus(runStatus),
    description: events.at(-1)?.message ?? '等待下一次状态更新。',
  }
}

export function buildSubAgentDiagnostic(
  agent: SubAgentState,
  todos: TodoItem[],
  toolCalls: ToolCall[],
  events: RunEvent[],
) {
  const ownedTodos = todos.filter(todo => todo.ownerAgentId === agent.agentId || agent.stepIds.includes(todo.stepId ?? ''))
  const ownedTools = toolCalls.filter(tool => agent.stepIds.includes(tool.stepId))
  const recentEvents = events
    .filter(event => event.payload?.agentId === agent.agentId || agent.stepIds.includes(String(event.payload?.stepId ?? '')))
    .slice(-5)
  const completed = ownedTodos.filter(todo => todo.status === 'completed').length
  const total = ownedTodos.length
  return {
    agent,
    currentWork: agent.latestMessage || ownedTodos.find(todo => todo.status === 'running')?.title || '暂无活动步骤',
    latestMessage: agent.summary || ownedTools.at(-1)?.message || recentEvents.at(-1)?.message || '暂无消息',
    progressLabel: total ? `${completed}/${total}` : formatExecutionStatus(agent.status),
    recentEvents,
  }
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
    {
      label: '会话',
      description: currentSessionId ? `session=${currentSessionId}` : '当前没有活动会话',
      href: currentSessionId ? `?session=${encodeURIComponent(currentSessionId)}` : '#',
      enabled: Boolean(currentSessionId),
    },
    {
      label: '运行',
      description: currentRunId ? `run=${currentRunId}` : '当前没有活动运行',
      href: currentRunId ? `?run=${encodeURIComponent(currentRunId)}` : '#',
      enabled: Boolean(currentRunId),
    },
    {
      label: 'Artifact',
      description: selectedArtifactId ? `artifact=${selectedArtifactId}` : '当前没有选中结果',
      href: selectedArtifactId ? `/api/v1/results/${encodeURIComponent(selectedArtifactId)}/metadata` : '#',
      enabled: Boolean(selectedArtifactId),
    },
  ]
}

function summarizeIntent(intent: UserIntent) {
  const parts = [
    intent.taskType,
    intent.placeQuery,
    intent.area,
    ...intent.desiredOutputs,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : '已解析基础意图。'
}

function deriveExecutionStatus(runStatus?: string) {
  if (runStatus === 'completed') return 'completed'
  if (runStatus === 'running' || runStatus === 'queued') return 'running'
  if (runStatus === 'failed') return 'failed'
  if (runStatus === 'waiting_approval' || runStatus === 'requires_action') return 'blocked'
  return 'pending'
}
