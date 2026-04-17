import type { AgentRuntimeConfig, AgentState, AnalysisRun, ArtifactRef, RunEvent } from '@geo-agent-platform/shared-types'

export type TranscriptEntryKind = 'user' | 'assistant' | 'supervisor' | 'subagent' | 'tool' | 'approval' | 'artifact' | 'error'
export type TranscriptEntryStatus = 'idle' | 'running' | 'completed' | 'blocked' | 'failed'

export interface TranscriptEntry {
  id: string
  kind: TranscriptEntryKind
  timestamp: string
  title: string
  body: string
  status: TranscriptEntryStatus
  commandText?: string | null
  recoveryNote?: string | null
  agentId?: string | null
  toolName?: string | null
  artifactId?: string | null
  approvalId?: string | null
  stepId?: string | null
  details?: Record<string, unknown> | null
}

interface DeriveRunTranscriptInput {
  run?: AnalysisRun
  agentState?: AgentState
  events: RunEvent[]
  artifacts: ArtifactRef[]
  query?: string
  runtimeConfig?: AgentRuntimeConfig
}

export function deriveRunTranscript({
  run,
  agentState,
  events,
  artifacts,
  query,
  runtimeConfig,
}: DeriveRunTranscriptInput): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const userQuery = run?.userQuery ?? agentState?.userQuery ?? query?.trim()
  if (userQuery) {
    entries.push({
      id: `user:${run?.id ?? 'draft'}`,
      kind: 'user',
      timestamp: run?.createdAt ?? events[0]?.timestamp ?? new Date().toISOString(),
      title: '用户问题',
      body: userQuery,
      status: 'completed',
    })
  }

  for (const event of events) {
    const entry = mapEventToTranscriptEntry(event, events)
    if (entry) {
      entries.push(entry)
    }
  }

  const finalSummary = agentState?.finalResponse?.summary?.trim()
  if (finalSummary && !entries.some((entry) => entry.kind === 'assistant' && entry.body === finalSummary)) {
    entries.push({
      id: `assistant:final:${run?.id ?? 'current'}`,
      kind: 'assistant',
      timestamp: run?.updatedAt ?? agentState?.loopTrace.at(-1)?.timestamp ?? new Date().toISOString(),
      title: '最终结果',
      body: finalSummary,
      status: run?.status === 'failed' ? 'failed' : run?.status === 'waiting_approval' ? 'blocked' : 'completed',
    })
  }

  if (!entries.some((entry) => entry.kind === 'artifact') && artifacts.length) {
    for (const artifact of artifacts) {
      entries.push({
        id: `artifact:fallback:${artifact.artifactId}`,
        kind: 'artifact',
        timestamp: run?.updatedAt ?? new Date().toISOString(),
        title: artifact.name,
        body: '结果已经写入 artifact store，可在地图和右侧面板继续查看。',
        status: 'completed',
        artifactId: artifact.artifactId,
      })
    }
  }

  const maxEntries = Math.max(runtimeConfig?.ui?.transcriptMaxEntries ?? 40, 12)
  return compactTranscriptEntries(entries).slice(-maxEntries)
}

export function pickTranscriptHeadline(entries: TranscriptEntry[], runStatus?: string) {
  const latest = [...entries].reverse().find((entry) => entry.kind !== 'user') ?? entries.at(-1)
  if (latest) {
    return latest
  }
  return {
    id: 'headline:idle',
    kind: 'assistant' as const,
    timestamp: new Date().toISOString(),
    title: runStatus === 'running' ? '正在连接运行流' : '等待新的分析任务',
    body: runStatus === 'running' ? '事件流已经打开，正在等待第一条运行事件。' : '输入空间问题后，系统会在这里实时展示分析过程、工具和结果。',
    status: runStatus === 'running' ? ('running' as const) : ('idle' as const),
  }
}

function mapEventToTranscriptEntry(event: RunEvent, events: RunEvent[]): TranscriptEntry | null {
  const payload = event.payload ?? {}
  if (event.type === 'message.delta') {
    return {
      id: event.eventId,
      kind: 'assistant',
      timestamp: event.timestamp,
      title: '助手回复',
      body: event.message,
      status: 'running',
      details: payload,
    }
  }
  if (event.type === 'loop.updated') {
    const title = sanitizeUserFacingText(String(payload.title ?? '正在处理'))
    const body = sanitizeUserFacingText(String(payload.description ?? event.message))
    return {
      id: event.eventId,
      kind: 'supervisor',
      timestamp: event.timestamp,
      title,
      body,
      status: normalizeTranscriptStatus(payload.status),
      agentId: stringOrNull(payload.agentId),
      toolName: stringOrNull(payload.toolName),
      stepId: stringOrNull(payload.stepId),
      details: payload,
    }
  }
  if (event.type === 'subagent.created' || event.type === 'subagent.updated') {
    const status = normalizeTranscriptStatus(payload.status)
    const currentStepId = stringOrNull(payload.currentStepId)
    const latestMessage = sanitizeUserFacingText(String(payload.latestMessage ?? payload.summary ?? event.message))
    if (status === 'idle' && !currentStepId) {
      return null
    }
    return {
      id: event.eventId,
      kind: 'subagent',
      timestamp: event.timestamp,
      title: sanitizeUserFacingText(String(payload.role ?? payload.name ?? payload.agentId ?? '子智能体')),
      body: latestMessage,
      status,
      agentId: stringOrNull(payload.agentId),
      stepId: currentStepId,
      details: payload,
    }
  }
  if (event.type === 'tool.started' || event.type === 'tool.completed') {
    const toolName = stringOrNull(payload.tool)
    const toolArgs = payload.args ?? findPreviousToolArgs(event, events)
    const commandText = toolName ? buildToolCommandText(toolName, toolArgs) : null
    return {
      id: event.eventId,
      kind: 'tool',
      timestamp: event.timestamp,
      title: toolName ?? '工具调用',
      body: event.type === 'tool.started' ? `正在调用工具“${toolName ?? '未知工具'}”。` : sanitizeUserFacingText(event.message),
      status: event.type === 'tool.started' ? 'running' : 'completed',
      commandText,
      toolName,
      stepId: stringOrNull(payload.stepId),
      details: { ...payload, args: toolArgs },
    }
  }
  if (event.type === 'artifact.created') {
    return {
      id: event.eventId,
      kind: 'artifact',
      timestamp: event.timestamp,
      title: String(payload.name ?? '新结果图层'),
      body: sanitizeUserFacingText(event.message),
      status: 'completed',
      artifactId: stringOrNull(payload.artifactId),
      details: payload,
    }
  }
  if (event.type === 'approval.required') {
    return {
      id: event.eventId,
      kind: 'approval',
      timestamp: event.timestamp,
      title: sanitizeUserFacingText(String(payload.title ?? '等待审批')),
      body: sanitizeUserFacingText(String(payload.description ?? event.message)),
      status: 'blocked',
      approvalId: stringOrNull(payload.approvalId),
      artifactId: stringOrNull(payload.artifactId),
      details: payload,
    }
  }
  if (event.type === 'warning.raised' || event.type === 'run.failed') {
    return {
      id: event.eventId,
      kind: 'error',
      timestamp: event.timestamp,
      title: event.type === 'run.failed' ? '运行失败' : '运行警告',
      body: sanitizeUserFacingText(event.message),
      status: event.type === 'run.failed' ? 'failed' : 'blocked',
      recoveryNote: deriveRecoveryNote(event, events),
      details: payload,
    }
  }
  if (event.type === 'run.completed') {
    return {
      id: event.eventId,
      kind: 'assistant',
      timestamp: event.timestamp,
      title: '最终结果',
      body: sanitizeUserFacingText(String((payload.finalResponse as Record<string, unknown> | undefined)?.summary ?? event.message)),
      status: payload.approvals ? 'blocked' : 'completed',
      details: payload,
    }
  }
  return null
}

function buildToolCommandText(toolName: string, args: unknown) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return `> ${toolName}`
  }
  const pairs = Object.entries(args as Record<string, unknown>)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${formatCommandValue(value)}`)
  return pairs.length ? `> ${toolName} ${pairs.join(' ')}` : `> ${toolName}`
}

function formatCommandValue(value: unknown) {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

function deriveRecoveryNote(event: RunEvent, events: RunEvent[]) {
  const currentIndex = events.findIndex((item) => item.eventId === event.eventId)
  const nextMeaningfulEvent = events
    .slice(currentIndex + 1)
    .find((item) => item.type !== 'warning.raised' && item.type !== 'message.delta')
  if (!nextMeaningfulEvent) {
    return event.type === 'run.failed' ? '本次运行已在当前步骤终止。' : '当前仍停留在这个异常节点，等待后续处理。'
  }
  if (nextMeaningfulEvent.type === 'tool.started') {
    return `系统已继续尝试下一步，并转向工具“${String(nextMeaningfulEvent.payload?.tool ?? '未知工具')}”。`
  }
  if (nextMeaningfulEvent.type === 'approval.required') {
    return '系统已转入审批节点，等待你确认后继续。'
  }
  if (nextMeaningfulEvent.type === 'run.completed') {
    return '系统已完成剩余步骤，并生成了最终结果。'
  }
  if (nextMeaningfulEvent.type === 'loop.updated') {
    return `系统仍在继续推进：${nextMeaningfulEvent.message}`
  }
  if (nextMeaningfulEvent.type === 'run.failed') {
    return '系统无法自动恢复，本次运行已经停止。'
  }
  return `系统后续进入了“${nextMeaningfulEvent.type}”阶段。`
}

function compactTranscriptEntries(entries: TranscriptEntry[]) {
  const compacted: TranscriptEntry[] = []

  for (const entry of entries) {
    const previous = compacted.at(-1)
    if (previous && shouldMergeTranscriptEntries(previous, entry)) {
      compacted[compacted.length - 1] = {
        ...previous,
        ...entry,
        id: previous.id,
        timestamp: entry.timestamp,
        details: entry.details ?? previous.details,
        commandText: entry.commandText ?? previous.commandText,
        recoveryNote: entry.recoveryNote ?? previous.recoveryNote,
      }
      continue
    }
    compacted.push(entry)
  }

  return compacted
}

function shouldMergeTranscriptEntries(previous: TranscriptEntry, current: TranscriptEntry) {
  if (previous.kind !== current.kind) {
    return false
  }
  if (!['supervisor', 'subagent', 'tool'].includes(current.kind)) {
    return false
  }
  if (previous.status !== current.status) {
    return false
  }
  if ((previous.agentId ?? null) !== (current.agentId ?? null)) {
    return false
  }
  if ((previous.toolName ?? null) !== (current.toolName ?? null)) {
    return false
  }
  if (previous.title !== current.title) {
    return false
  }

  if (current.kind === 'tool') {
    return previous.commandText === current.commandText
  }

  return previous.body === current.body
}

function findPreviousToolArgs(event: RunEvent, events: RunEvent[]) {
  const currentIndex = events.findIndex((item) => item.eventId === event.eventId)
  if (currentIndex <= 0) {
    return null
  }
  const toolName = event.payload?.tool
  const stepId = event.payload?.stepId
  const matched = [...events.slice(0, currentIndex)]
    .reverse()
    .find(
      (item) =>
        item.type === 'tool.started' &&
        item.payload?.tool === toolName &&
        (stepId == null || item.payload?.stepId === stepId),
    )
  return matched?.payload?.args ?? null
}

function sanitizeUserFacingText(value: string) {
  return value
    .replaceAll('Spatial Analyst', '空间分析')
    .replaceAll('QGIS Operator', 'QGIS 执行')
    .replaceAll('Publisher', '结果发布')
    .replaceAll('live supervisor', '主智能体')
    .replaceAll('supervisor', '主智能体')
    .replaceAll('thread', '会话')
    .replaceAll('run', '任务')
    .replaceAll('deepagents', '系统')
    .trim()
}

function normalizeTranscriptStatus(value: unknown): TranscriptEntryStatus {
  if (value === 'completed' || value === 'failed' || value === 'blocked' || value === 'running') {
    return value
  }
  return 'idle'
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null
}
