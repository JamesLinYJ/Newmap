// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行 Transcript 派生器
//
//   文件:       runTranscript.ts
//
//   日期:       2026年04月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------
// 模块职责
//
// 把 run、agent state、events 和 artifacts 统一派生成前端 REPL 可直接渲染的记录列表。
import type { AgentRuntimeConfig, AgentState, AnalysisRun, ArtifactRef, RunEvent, ToolDescriptor } from '@geo-agent-platform/shared-types'

export type TranscriptEntryKind = 'user' | 'assistant' | 'supervisor' | 'subagent' | 'tool' | 'approval' | 'artifact' | 'error' | 'system'
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

export interface ConversationCommand {
  id: string
  title: string
  status: TranscriptEntryStatus
  body: string
  commandText?: string | null
  toolName?: string | null
  details?: Record<string, unknown> | null
}

export type ConversationEntryKind = 'message' | 'command_batch' | 'approval' | 'artifact' | 'error' | 'system'

export interface ConversationEntry {
  id: string
  kind: ConversationEntryKind
  timestamp: string
  title: string
  body: string
  status: TranscriptEntryStatus
  role?: 'user' | 'assistant'
  badge?: string | null
  note?: string | null
  commands?: ConversationCommand[]
  artifactId?: string | null
  approvalId?: string | null
  recoveryNote?: string | null
  details?: Record<string, unknown> | null
}

export function isActivityEntry(kind: TranscriptEntryKind) {
  // 这些 kind 会在首页和 debug 页里显示为“过程节点”，而不是普通对话消息。
  return kind === 'supervisor' || kind === 'subagent' || kind === 'tool' || kind === 'approval' || kind === 'artifact'
}

export interface DeriveRunTranscriptInput {
  run?: AnalysisRun
  agentState?: AgentState
  events: RunEvent[]
  artifacts: ArtifactRef[]
  query?: string
  runtimeConfig?: AgentRuntimeConfig
}

export interface DeriveThreadTranscriptInput extends DeriveRunTranscriptInput {
  threadRuns?: ReadonlyArray<AnalysisRun>
}

export function deriveThreadTranscript({
  run,
  agentState,
  events,
  artifacts,
  query,
  runtimeConfig,
  threadRuns = [],
}: DeriveThreadTranscriptInput): TranscriptEntry[] {
  // 线程 transcript
  //
  // 首页需要看到同一 thread 里的连续对话，而不是每次只盯着最后一个 run。
  // 这样澄清、补充和继续分析会自然插入原任务上下文，而不是视觉上跳成新任务。
  const candidateRuns = dedupeRunsById([...(threadRuns ?? []), ...(run ? [run] : [])])
  if (candidateRuns.length <= 1) {
    return deriveRunTranscript({ run, agentState, events, artifacts, query, runtimeConfig })
  }

  const orderedRuns = [...candidateRuns].sort(compareRunCreatedAt)
  const entries = orderedRuns.flatMap((item) =>
    deriveRunTranscript({
      run: item,
      agentState: item.id === run?.id ? agentState ?? item.state : item.state,
      events: item.id === run?.id ? events : filterEventsByRunId(events, item.id),
      artifacts: item.id === run?.id ? artifacts : item.state.artifacts,
      query: item.userQuery,
      runtimeConfig,
    }),
  )

  const maxEntries = Math.max(runtimeConfig?.ui?.transcriptMaxEntries ?? 40, 12)
  return entries.slice(-maxEntries)
}

export function deriveRunTranscript({
  run,
  agentState,
  events,
  artifacts,
  query,
  runtimeConfig,
}: DeriveRunTranscriptInput): TranscriptEntry[] {
  // transcript 派生层是前端唯一的“运行叙事编排器”。
  //
  // 它只消费事实源：run / state / events / artifacts，
  // 不额外发明阶段文案，保证首页和 debug 页能共享同一套记录语义。
  const entries: TranscriptEntry[] = []
  const effectiveAgentState = agentState ?? run?.state
  const userQuery =
    run?.userQuery ??
    effectiveAgentState?.userQuery ??
    (run || effectiveAgentState || events.length > 0 ? query?.trim() : undefined)
  if (userQuery) {
    entries.push({
      id: `user:${run?.id ?? 'draft'}`,
      kind: 'user',
      timestamp: run?.createdAt ?? events[0]?.timestamp ?? new Date().toISOString(),
      title: '用户问题',
      body: normalizeTranscriptText(userQuery),
      status: 'completed',
    })
  }

  for (const event of events) {
    appendEventTranscriptEntry(entries, event, events)
  }

  const completionEvent = [...events].reverse().find((event) => event.type === 'run.completed')
  const completionPayload = completionEvent?.payload ?? {}
  const completionFinalResponse = completionPayload.finalResponse as Record<string, unknown> | undefined
  const completionApprovals = Array.isArray(completionPayload.approvals) ? completionPayload.approvals : []
  const rawFinalSummary =
    normalizeTranscriptText(effectiveAgentState?.finalResponse?.summary) ||
    normalizeTranscriptText(completionFinalResponse?.summary) ||
    normalizeTranscriptText(completionEvent?.message)
  const finalSummary = sanitizeUserFacingText(rawFinalSummary)
  const finalStatus: TranscriptEntryStatus =
    run?.status === 'failed'
      ? 'failed'
      : run?.status === 'waiting_approval' || completionApprovals.length > 0 || Boolean(effectiveAgentState?.approvals?.length)
        ? 'blocked'
        : 'completed'
  const hasStreamedAnswer = entries.some(
    (entry) =>
      entry.kind === 'assistant' &&
      (entry.details?._streaming === true || entry.details?.streamingDelta === true) &&
      entry.body.trim().length > 20,
  )
  // 仅当没有流式文本时才追加 final summary（失败/澄清场景）
  if (
    finalSummary &&
    !isGenericFailureSummary(finalSummary) &&
    !hasStreamedAnswer &&
    !entries.some((entry) => normalizeComparableText(entry.body) === normalizeComparableText(finalSummary))
  ) {
    entries.push({
      id: `assistant:final:${run?.id ?? 'current'}`,
      kind: 'assistant',
      timestamp: run?.updatedAt ?? effectiveAgentState?.loopTrace.at(-1)?.timestamp ?? completionEvent?.timestamp ?? new Date().toISOString(),
      title: '',
      body: finalSummary,
      status: finalStatus,
    })
  }

  if (!entries.some((entry) => entry.kind === 'artifact') && artifacts.length) {
    for (const artifact of artifacts) {
      entries.push({
        id: `artifact:store:${artifact.artifactId}`,
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
  // 首屏 headline 只是 transcript 的摘要视图，不单独维护另一套状态机。
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

export function deriveConversationEntries(
  entries: ReadonlyArray<TranscriptEntry>,
  runStatus?: string,
  toolDescriptors: ReadonlyArray<ToolDescriptor> = [],
): ConversationEntry[] {
  const conversation: ConversationEntry[] = []
  let pendingActivity: TranscriptEntry[] = []
  const toolMetadataByName = new Map(toolDescriptors.map((tool) => [tool.name, tool] as const))

  const flushPendingActivity = () => {
    if (!pendingActivity.length) {
      return
    }
    const narration = buildNarrationEntry(pendingActivity, runStatus, toolMetadataByName)
    if (narration) {
      conversation.push(narration)
    }
    const commandBatch = buildCommandBatchEntry(pendingActivity, toolMetadataByName)
    if (commandBatch) {
      conversation.push(commandBatch)
    }
    pendingActivity = []
  }

  for (const entry of entries) {
    if (entry.kind === 'supervisor' || entry.kind === 'subagent' || entry.kind === 'tool') {
      pendingActivity.push(entry)
      continue
    }

    flushPendingActivity()

    if (entry.kind === 'user' || entry.kind === 'assistant') {
      conversation.push({
        id: `message:${entry.id}`,
        kind: 'message',
        role: entry.kind === 'user' ? 'user' : 'assistant',
        timestamp: entry.timestamp,
        title: entry.title,
        body: entry.body,
        status: entry.status,
        recoveryNote: entry.recoveryNote,
        details: entry.details,
      })
      continue
    }

    if (entry.kind === 'approval') {
      conversation.push({
        id: `approval:${entry.id}`,
        kind: 'approval',
        timestamp: entry.timestamp,
        title: entry.title,
        body: entry.body,
        status: entry.status,
        approvalId: entry.approvalId,
        artifactId: entry.artifactId,
        badge: '待确认',
        details: entry.details,
      })
      continue
    }

    if (entry.kind === 'artifact') {
      conversation.push({
        id: `message:artifact:${entry.id}`,
        kind: 'message',
        role: 'assistant',
        timestamp: entry.timestamp,
        title: '结果已生成',
        body: `我已经生成结果”${sanitizeUserFacingText(entry.title)}”，现在可以在地图里继续查看。`,
        status: entry.status,
        artifactId: entry.artifactId,
        note: '如果你想继续分析，我会直接基于这个结果往下处理。',
        details: entry.details,
      })
      continue
    }

    if (entry.kind === 'system') {
      conversation.push({
        id: `system:${entry.id}`,
        kind: 'system',
        timestamp: entry.timestamp,
        title: entry.title,
        body: entry.body,
        status: entry.status,
        details: entry.details,
      })
      continue
    }

    conversation.push({
      id: `error:${entry.id}`,
      kind: 'error',
      timestamp: entry.timestamp,
      title: entry.title,
      body: entry.body,
      status: entry.status,
      badge: entry.status === 'failed' ? '失败' : '提醒',
      recoveryNote: entry.recoveryNote,
      details: entry.details,
    })
  }

  flushPendingActivity()
  return conversation
}

function mapEventToTranscriptEntry(event: RunEvent, events: RunEvent[]): TranscriptEntry | null {
  // 事件到 transcript 的映射必须保持稳定且可逆理解。
  //
  // 同一种 event 在首页和 debug 页都应落成同一种 kind，
  // 否则用户会看到“同一条运行记录在不同页面像两回事”。
  const payload = event.payload ?? {}
  if (event.type === 'message.delta') {
    const streamId = (payload._id as string) || `msg-delta:${event.runId ?? 'stream'}`
    const body = sanitizeUserFacingText(normalizeTranscriptText(event.message))
    const isDone = !!(payload._done)
    return {
      id: streamId,
      kind: 'assistant',
      timestamp: event.timestamp,
      title: '',
      body,
      status: isDone ? 'completed' : 'running',
      details: { ...payload, _streaming: true },
    }
  }
  if (event.type === 'loop.updated') {
    const title = sanitizeUserFacingText(normalizeTranscriptText(payload.title ?? '正在处理'))
    const body = sanitizeUserFacingText(normalizeTranscriptText(payload.description ?? event.message))
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
    const latestMessage = sanitizeUserFacingText(normalizeTranscriptText(payload.latestMessage ?? payload.summary ?? event.message))
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
    const toolStatus: TranscriptEntryStatus =
      event.type === 'tool.started' ? 'running' : payload.status === 'failed' ? 'failed' : 'completed'
    return {
      id: event.eventId,
      kind: 'tool',
      timestamp: event.timestamp,
      title: toolName ?? '工具调用',
      body: event.type === 'tool.started' ? `正在调用工具“${toolName ?? '未知工具'}”。` : sanitizeUserFacingText(event.message),
      status: toolStatus,
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
      title: normalizeTranscriptText(payload.name ?? '新结果图层'),
      body: sanitizeUserFacingText(normalizeTranscriptText(event.message)),
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
      title: sanitizeUserFacingText(normalizeTranscriptText(payload.title ?? '等待审批')),
      body: sanitizeUserFacingText(normalizeTranscriptText(payload.description ?? event.message)),
      status: 'blocked',
      approvalId: stringOrNull(payload.approvalId),
      artifactId: stringOrNull(payload.artifactId),
      details: payload,
    }
  }
  if (event.type === 'clarification.required') {
    const clarification = payload.clarification as Record<string, unknown> | undefined
    return {
      id: event.eventId,
      kind: 'approval',
      timestamp: event.timestamp,
      title: '需要确认',
      body: sanitizeUserFacingText(normalizeTranscriptText(clarification?.question ?? event.message)),
      status: 'blocked',
      approvalId: null,
      details: payload,
    }
  }
  if (event.type === 'warning.raised' || event.type === 'run.failed') {
    const failurePayload = payload.finalResponse as Record<string, unknown> | undefined
    return {
      id: event.eventId,
      kind: 'error',
      timestamp: event.timestamp,
      title: event.type === 'run.failed' ? humanizeFailureTitle(event.message, payload) : humanizeWarningTitle(event.message),
      body: humanizeFailureBody(event.message, payload),
      status: event.type === 'run.failed' ? 'failed' : 'blocked',
      recoveryNote: deriveRecoveryNote(event, events) ?? extractNextActions(failurePayload),
      details: payload,
    }
  }
  if (event.type === 'run.completed') {
    // 流式文本已通过 message.delta 事件发送，不再重复输出
    return null
  }
  if ((event.type as string) === 'compaction.executed') {
    const level = stringOrNull(payload.level ?? payload.compaction_level) ?? 'auto'
    return {
      id: event.eventId,
      kind: 'system',
      timestamp: event.timestamp,
      title: '上下文压缩',
      body: `上下文已压缩（${level}）`,
      status: 'completed',
      details: payload,
    }
  }
  if ((event.type as string) === 'hook.triggered') {
    const hookEventType = stringOrNull(payload.event_type ?? payload.hook_type) ?? 'unknown'
    return {
      id: event.eventId,
      kind: 'system',
      timestamp: event.timestamp,
      title: 'Hook 触发',
      body: `Hook: ${hookEventType} triggered`,
      status: 'completed',
      details: payload,
    }
  }
  return null
}

function appendEventTranscriptEntry(entries: TranscriptEntry[], event: RunEvent, events: RunEvent[]) {
  // 流式消息聚合
  //
  // message.delta 是同一条助手回复的增量片段。这里在事件映射阶段把它们吸收到
  // 一个 transcript entry 里，避免 UI 先生成一串 token 节点再靠渲染层补救。
  if (event.type === 'message.delta') {
    const payload = event.payload ?? {}
    const streamId = stringOrNull(payload._id) ?? `msg-delta:${event.runId ?? event.eventId}`
    const body = sanitizeUserFacingText(normalizeTranscriptText(event.message))
    if (!body) {
      return
    }
    const isDone = payload._done === true
    const isOperationalNarration = shouldCollapseOperationalNarration(event, events, body)
    const entryStatus: TranscriptEntryStatus = isOperationalNarration ? 'completed' : isDone ? 'completed' : 'running'
    let existingIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].id === streamId) {
        existingIndex = i
        break
      }
    }
    if (existingIndex >= 0) {
      const previous = entries[existingIndex]
      entries[existingIndex] = {
        ...previous,
        body: mergeStreamingDelta(previous.body, body),
        timestamp: event.timestamp,
        title: isOperationalNarration ? '思考过程' : previous.title,
        status: entryStatus,
        details: {
          ...(previous.details ?? {}),
          ...payload,
          _streaming: true,
          streamingDelta: true,
          _thinking: isOperationalNarration ? true : previous.details?._thinking,
          _startedAt: previous.details?._startedAt ?? event.timestamp,
          _endedAt: entryStatus === 'completed' ? event.timestamp : undefined,
        },
      }
      return
    }
    entries.push({
      id: streamId,
      kind: 'assistant',
      timestamp: event.timestamp,
      title: isOperationalNarration ? '思考过程' : '',
      body,
      status: entryStatus,
      details: {
        ...payload,
        _streaming: true,
        streamingDelta: true,
        _thinking: isOperationalNarration ? true : undefined,
        _startedAt: event.timestamp,
        _endedAt: entryStatus === 'completed' ? event.timestamp : undefined,
      },
    })
    return
  }

  // thinking.delta — 同一 run 内使用稳定 _id 合并为一个块，增量替换不追加
  if (event.type === 'thinking.delta') {
    const delta = sanitizeUserFacingText(normalizeTranscriptText(event.message))
    if (!delta) {
      return
    }
    const phaseKey = (event.payload?._startedAt as string) ?? event.timestamp
    const streamId = (event.payload?._id as string) || `think-delta:${event.runId ?? event.eventId}:${phaseKey}`
    const isDone = !!(event.payload?._done)
    // 向前查找同 ID 的条目——因为相邻条目可能被中间的消息 delta 隔开（多阶段推理）
    let existingIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].id === streamId) {
        existingIndex = i
        break
      }
    }
    if (existingIndex >= 0) {
      const target = entries[existingIndex]
      entries[existingIndex] = {
        ...target,
        body: delta,
        timestamp: event.timestamp,
        status: isDone ? 'completed' : 'running',
        details: {
          ...(target.details ?? {}),
          ...(event.payload ?? {}),
          _thinking: true,
          _startedAt: target.details?._startedAt ?? event.timestamp,
          _endedAt: isDone ? event.timestamp : undefined,
        },
      }
      return
    }
    entries.push({
      id: streamId,
      kind: 'assistant',
      timestamp: event.timestamp,
      title: '思考过程',
      body: delta,
      status: isDone ? 'completed' : 'running',
      details: {
        ...(event.payload ?? {}),
        _thinking: true,
        _startedAt: (event.payload?._startedAt as string) ?? event.timestamp,
        _endedAt: isDone ? event.timestamp : undefined,
      },
    })
    return
  }

  const entry = mapEventToTranscriptEntry(event, events)
  if (!entry) {
    return
  }
  const previous = entries.at(-1)
  if (
    previous?.kind === 'assistant' &&
    previous.status === 'running' &&
    previous.details?.streamingDelta === true &&
    entry.kind === 'assistant' &&
    normalizeComparableText(previous.body) === normalizeComparableText(entry.body)
  ) {
    entries[entries.length - 1] = {
      ...previous,
      ...entry,
      id: previous.id,
      body: entry.body,
      title: previous.title,
      details: { ...(entry.details ?? {}), ...(previous.details ?? {}), streamingDelta: true },
    }
    return
  }
  entries.push(entry)
}

function mergeStreamingDelta(previousBody: string, delta: string) {
  if (delta.startsWith(previousBody)) {
    return delta
  }
  return `${previousBody}${delta}`
}

function shouldCollapseOperationalNarration(event: RunEvent, events: RunEvent[], body: string) {
  // 部分模型会把工具调用前的自我规划当 message.delta 输出。
  //
  // 如果这类英文计划文本后面紧跟真实工具事件，UI 应把它折叠进“思考过程”，
  // 不能当成最终回答占满对话流。
  const currentIndex = events.findIndex((item) => item.eventId === event.eventId)
  const hasLaterToolEvent = currentIndex >= 0 && events
    .slice(currentIndex + 1)
    .some((item) => item.type === 'tool.started' || item.type === 'tool.completed')
  if (!hasLaterToolEvent) {
    return false
  }
  return /\b(the user wants|i need to|let me|now let me|i'll use|got both coordinates|coordinate refs?|simultaneously since)\b/iu.test(body)
}

function buildNarrationEntry(
  _activityEntries: TranscriptEntry[],
  _runStatus: string | undefined,
  _toolMetadataByName: ReadonlyMap<string, ToolDescriptor>,
): ConversationEntry | null {
  // CC 不生成人工叙述文本。工具调用以紧凑卡片内联在对话中，不额外制造假对话消息。
  return null
}

function buildCommandBatchEntry(activityEntries: TranscriptEntry[], toolMetadataByName: ReadonlyMap<string, ToolDescriptor>): ConversationEntry | null {
  const toolEntries = activityEntries.filter((entry) => entry.kind === 'tool')
  if (!toolEntries.length) {
    return null
  }
  const commands = mergeConversationCommands(toolEntries, toolMetadataByName)
  if (!commands.length) {
    return null
  }

  const runningCount = commands.filter((command) => command.status === 'running').length
  const failedCount = commands.filter((command) => command.status === 'failed').length
  const completedCount = commands.filter((command) => command.status === 'completed').length
  const status: TranscriptEntryStatus =
    failedCount > 0 ? 'failed' : runningCount > 0 ? 'running' : completedCount > 0 ? 'completed' : 'idle'
  const title =
    failedCount > 0
      ? `已运行 ${commands.length} 个命令，其中 ${failedCount} 个失败`
      : runningCount > 0
        ? `正在执行 ${commands.length} 个命令`
        : `已运行 ${commands.length} 个命令`
  const latest = commands.at(-1)

  // batch ID 从最早的 tool entry ID 派生，保证同批次稳定，避免 React key 跳动
  const batchId = toolEntries[0]?.id ?? 'current'
  return {
    id: `command-batch:${batchId}`,
    kind: 'command_batch',
    timestamp: toolEntries.at(-1)?.timestamp ?? new Date().toISOString(),
    title,
    body: latest ? latest.body : '当前命令批次已经整理完成。',
    status,
    badge: null,
    commands,
    details: latest?.details ?? null,
  }
}

function mergeConversationCommands(toolEntries: TranscriptEntry[], toolMetadataByName: ReadonlyMap<string, ToolDescriptor>): ConversationCommand[] {
  // 优先按后端 stepId 配对 started/completed；旧历史事件没有 stepId 时，
  // 回退到 toolName + commandText 签名，避免同一次工具调用显示成“执行中/完成”两条。
  const orderedPairs: Array<{ key: string; started?: TranscriptEntry; completed?: TranscriptEntry }> = []
  const pairsByKey = new Map<string, Array<{ key: string; started?: TranscriptEntry; completed?: TranscriptEntry }>>()

  for (const entry of toolEntries) {
    const key = buildCommandPairKey(entry)
    const pairs = pairsByKey.get(key) ?? []
    pairsByKey.set(key, pairs)
    if (entry.status === 'running') {
      const pair = { key, started: entry }
      pairs.push(pair)
      orderedPairs.push(pair)
    } else {
      let pair = pairs.find((item) => !item.completed)
      if (!pair) {
        pair = { key }
        pairs.push(pair)
        orderedPairs.push(pair)
      }
      pair.completed = entry
    }
  }

  const commands: ConversationCommand[] = []
  for (const pair of orderedPairs) {
    const anchorEntry = pair.started ?? pair.completed
    if (!anchorEntry) continue
    const status: TranscriptEntryStatus = pair.completed
      ? pair.completed.status
      : 'running'
    const body = pair.completed ? pair.completed.body : (pair.started ? '执行中…' : '')
    const displayEntry = pair.started ?? pair.completed ?? anchorEntry

    commands.push({
      id: anchorEntry.id,
      title: humanizeToolLabel(displayEntry.title, displayEntry.toolName, toolMetadataByName),
      status,
      body,
      commandText: pair.started?.commandText ?? pair.completed?.commandText,
      toolName: displayEntry.toolName,
      details: pair.completed?.details ?? pair.started?.details,
    })
  }
  return commands
}

function buildCommandPairKey(entry: TranscriptEntry) {
  if (entry.stepId) {
    return `step:${entry.stepId}`
  }
  return `signature:${entry.toolName ?? entry.title}:${entry.commandText ?? ''}`
}

function buildToolCommandText(toolName: string, args: unknown) {
  // commandText 刻意控制得很短，只保留用户能看懂的工具名和关键参数，
  // 不把整份 payload 直接抛给 UI。
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

function humanizeToolLabel(label: string, toolName: string | null | undefined, toolMetadataByName: ReadonlyMap<string, ToolDescriptor>) {
  const descriptor = toolName ? toolMetadataByName.get(toolName) : undefined
  if (descriptor?.label?.trim()) {
    return descriptor.label.trim()
  }
  const normalized = sanitizeUserFacingText(label)
  if (normalized.includes('_')) {
    return normalized
      .split('_')
      .filter(Boolean)
      .join(' ')
  }
  return normalized
}

function deriveRecoveryNote(event: RunEvent, events: RunEvent[]) {
  // 异常块不仅显示失败，还尝试告诉用户“系统后来有没有继续往前走”。
  const currentIndex = events.findIndex((item) => item.eventId === event.eventId)
  const nextMeaningfulEvent = events
    .slice(currentIndex + 1)
    .find((item) => item.type !== 'warning.raised' && item.type !== 'message.delta')
  if (!nextMeaningfulEvent) {
    return event.type === 'run.failed' ? null : '当前仍停留在这个异常节点，等待后续处理。'
  }
  if (nextMeaningfulEvent.type === 'tool.started') {
    return `系统已继续尝试下一步，并转向工具“${String(nextMeaningfulEvent.payload?.tool ?? '未知工具')}”。`
  }
  if (nextMeaningfulEvent.type === 'approval.required') {
    return '系统已转入审批节点，等待你确认后继续。'
  }
  if (nextMeaningfulEvent.type === 'clarification.required') {
    return '系统已转入澄清节点，等待你选择后继续。'
  }
  if (nextMeaningfulEvent.type === 'run.completed') {
    return '系统已完成剩余步骤，并生成了最终结果。'
  }
  if (nextMeaningfulEvent.type === 'loop.updated') {
    return `系统仍在继续推进：${nextMeaningfulEvent.message}`
  }
  if (nextMeaningfulEvent.type === 'run.failed') {
    return null
  }
  return `系统后续进入了“${nextMeaningfulEvent.type}”阶段。`
}

function compactTranscriptEntries(entries: TranscriptEntry[]) {
  // 折叠连续重复的 supervisor / subagent / tool 记录，
  // 避免高频事件把 REPL 列表刷成难以阅读的流水账。
  const compacted: TranscriptEntry[] = []

  for (const entry of entries) {
    const previous = compacted.at(-1)
    if (previous && shouldMergeTranscriptEntries(previous, entry)) {
      const isStreaming = previous.kind === 'assistant' && previous.status === 'running'
      compacted[compacted.length - 1] = {
        ...previous,
        ...entry,
        id: previous.id,
        body: isStreaming ? previous.body + entry.body : entry.body,
        timestamp: isStreaming ? previous.timestamp : entry.timestamp,
        details: { ...(previous.details ?? {}), ...(entry.details ?? {}) },
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
  // 流式 delta 合并：相同 ID 的连续 running assistant 条目累积 body。
  // 思考条目（_thinking）已在 appendEventTranscriptEntry 中完成合并，这里跳过避免 body 重复拼接。
  if (
    current.kind === 'assistant' &&
    previous.status === 'running' &&
    current.status === 'running' &&
    previous.id === current.id &&
    !previous.details?._thinking
  ) {
    return true
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
  // tool.completed 经常只带 tool 名，不重复携带 args；
  // 这里回看最近一次同 step 的 tool.started，把命令文本补完整。
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

/** 将 raw JSON final response 提取为纯 summary 文本，否则返回 null */
function _stripJsonWrapper(text: string): string | null {
  const t = text.trim()
  if (!t.includes('"summary"')) return null

  const tryParse = (candidate: string): string | null => {
    try {
      const p = JSON.parse(candidate)
      return typeof p.summary === 'string' && p.summary.trim() ? p.summary.trim() : null
    } catch { return null }
  }

  // 1) 纯 JSON: {"summary":"..."}
  if (t.startsWith('{')) {
    const r = tryParse(t)
    if (r) return r
  }
  // 2) 流式合并丢失开头 {
  if (t.startsWith('"summary"')) {
    const r = tryParse(`{${t}}`)
    if (r) return r
  }
  // 3) 自然语言后附带 JSON 块
  const braceIdx = t.indexOf('{"summary"')
  if (braceIdx >= 0) {
    const r = tryParse(t.slice(braceIdx))
    if (r) return r
  }
  return null
}

function sanitizeUserFacingText(value: string) {
  // 过滤模型输出的 raw JSON final response，只保留 summary 文本
  const stripped = _stripJsonWrapper(value)
  if (stripped !== null) return stripped
  return value
    .replaceAll('Spatial Analyst', '空间分析')
    .replaceAll('Publisher', '结果发布')
    .replace(/\blive supervisor\b/giu, '主智能体')
    .replace(/\bsupervisor\b/giu, '主智能体')
    .replace(/\bthread\b/giu, '会话')
    .replace(/\brun\b/giu, '任务')
    .replace(/\bAgent SDK\b/gu, '系统')
    .replace(/\bOpenAI Agents SDK\b/gu, '系统')
    .replace(/\bAgents SDK\b/gu, '系统')
    .replace(/\bError running tool\b/giu, '工具调用失败')
    .trim()
}

function humanizeWarningTitle(message: string) {
  if (message.includes('审批')) {
    return '需要你继续确认'
  }
  return '运行提醒'
}

function humanizeFailureTitle(message: string, payload: Record<string, unknown>) {
  const failedTool = typeof payload.failedTool === 'string' ? payload.failedTool : ''
  if (message.includes('模型') || String(payload.kind ?? '').includes('model')) {
    return '模型调用失败'
  }
  if (failedTool) {
    return `${failedTool} 执行失败`
  }
  return '本次运行失败'
}

function humanizeFailureBody(message: string, payload: Record<string, unknown>) {
  // 用户优先看到后端给出的失败事实。
  //
  // 如果没有合格摘要，直接显示原始错误文本，不再生成恢复话术。
  const summary = (payload.finalResponse as Record<string, unknown> | undefined)?.summary
  if (typeof summary === 'string' && summary.trim() && !isGenericFailureSummary(summary)) {
    return sanitizeUserFacingText(summary)
  }
  const errors = Array.isArray(payload.errors)
    ? payload.errors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (errors.length) {
    return sanitizeUserFacingText(errors[0])
  }
  return sanitizeUserFacingText(message)
}

function isGenericFailureSummary(value: string) {
  const normalized = normalizeComparableText(value)
  return normalized === '抱歉，这次分析没能完成' || normalized === '本次运行失败' || normalized === '分析执行失败'
}

function normalizeComparableText(value: string) {
  return value.replace(/[。！!？?]+$/u, '').trim()
}

function extractNextActions(finalResponse: Record<string, unknown> | undefined) {
  const nextActions = Array.isArray(finalResponse?.nextActions)
    ? finalResponse?.nextActions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (!nextActions.length) {
    return null
  }
  return `接下来可以：${nextActions.slice(0, 3).join('、')}。`
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

function normalizeTranscriptText(value: unknown): string {
  if (value == null) {
    return ''
  }
  if (typeof value === 'string') {
    return value.trim()
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeTranscriptText(item))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const contentType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : ''
    if (contentType === 'text') {
      return normalizeTranscriptText(record.text)
    }
    if ('content' in record) {
      return normalizeTranscriptText(record.content)
    }
    if ('text' in record) {
      return normalizeTranscriptText(record.text)
    }
    if ('message' in record) {
      return normalizeTranscriptText(record.message)
    }
    return ''
  }
  return String(value).trim()
}

function filterEventsByRunId(events: RunEvent[], runId: string): RunEvent[] {
  return events.filter((event) => event.runId === runId)
}

function dedupeRunsById(runs: ReadonlyArray<AnalysisRun>) {
  const seen = new Set<string>()
  const ordered: AnalysisRun[] = []
  for (const item of runs) {
    if (seen.has(item.id)) {
      continue
    }
    seen.add(item.id)
    ordered.push(item)
  }
  return ordered
}

function compareRunCreatedAt(left: AnalysisRun, right: AnalysisRun) {
  const leftTime = new Date(left.createdAt).getTime()
  const rightTime = new Date(right.createdAt).getTime()
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return left.id.localeCompare(right.id)
  }
  return leftTime - rightTime
}
