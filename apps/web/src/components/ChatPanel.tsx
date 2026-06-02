// +-------------------------------------------------------------------------
//
//   地理智能平台 - 智能对话面板
//
//   文件:       ChatPanel.tsx
//
//   日期:       2026年05月11日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 把运行 transcript 渲染为 Claude/Codex 风格的聊天时间线：
// 用户输入、思考过程、工具调用、审批通知和最终回答都保持同一条对话叙事。

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, LayoutGroup, m, useReducedMotion, type Variants } from 'framer-motion'
import { ArrowUp, ChevronDown, ClipboardList, FileText, FolderUp, LoaderCircle, Pencil, Plus, Search, Settings2, Square, Trash2, Zap, type LucideIcon } from 'lucide-react'
import type { AgentRuntimeConfig, AgentThreadRecord, ClarificationOption, ClarificationState, ToolDescriptor, UserIntent } from '@geo-agent-platform/shared-types'
import { SAMPLES, type DataReferenceSummary } from '../constants'
import { buildFadeMotion, buildFadeUpMotion, buildListItemVariants, buildListVariants, buildScaleInMotion } from '../motion'
import { deriveConversationEntries, type ConversationCommand, type ConversationEntry, type TranscriptEntry } from '../runTranscript'
import { AppIcon } from './AppIcon'
import { Markdown } from './Markdown'

interface ChatPanelProps {
  artifactCount: number
  currentRunId?: string
  currentThreadId?: string
  currentThreadTitle?: string
  runCreatedAt?: string
  providerLabel: string
  runStatus?: string
  query: string
  isSubmitting: boolean
  errorMessage?: string
  uploadedLayerName?: string
  intent?: UserIntent
  clarification?: ClarificationState | null
  sessionThreads: AgentThreadRecord[]
  transcriptEntries: ReadonlyArray<TranscriptEntry>
  runtimeConfig?: AgentRuntimeConfig
  availableTools?: ToolDescriptor[]
  onQueryChange: (value: string) => void
  onSubmit: (mode: 'plan' | 'auto') => void
  onInterrupt?: () => void
  onNewConversation: () => void
  onFillSample: (value: string) => void
  onSelectClarification: (value: string, id?: string | null) => void
  onUseTemplate: () => void
  onUploadFiles: (files: File[]) => void
  onSelectArtifact: (id: string) => void
  onSelectTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onDeleteTask: (id: string) => void
  onResolveApproval: (id: string, approved: boolean) => void
  dataReferences: DataReferenceSummary[]

  // 新增 — 记忆系统
  memories?: MemoryEntry[]
  onRefreshMemories?: () => void

  // 新增 — Token 预算
  tokenBudget?: { used: number; max: number; status: 'normal'|'warning'|'critical'|'exceeded' }

  // 新增 — 运行状态
  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: { toolAttempts: number; toolSuccesses: number; toolFailures: number; tokensUsed: number }
  denialCounts?: Record<string, number>

  // 新增 — Plan 面板
  executionPlan?: { goal: string; steps: { tool: string; args: any; reason: string }[] } | null
  onApprovePlan?: () => void
  onEditPlan?: () => void

  // 新增 — Task 面板
  tasks?: { id: string; content: string; status: string; activeForm: string }[]

  // 新增 — Session 历史面板
  sessions?: { id: string; title: string; created_at: string; latest_query: string; run_count: number }[]
  onSelectSession?: (id: string) => void
  onResumeSession?: (sessionId: string) => void
}

type MemoryEntry = {
  name: string; description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  age: string;
}

type TaskView = 'chat' | 'summary' | 'all'
type TaskDialog = { mode: 'rename' | 'delete'; task: AgentThreadRecord } | null
type ComposerMode = 'plan' | 'auto'
type ActiveClarification = {
  key: string
  question: string
  options: ClarificationOption[]
  allowFreeText: boolean
}
const DIRECTORY_PICKER_PROPS = { webkitdirectory: '', directory: '' } as Record<string, string>

const COMPOSER_MODES = [
  {
    id: 'plan',
    label: '计划模式',
    description: '先整理步骤和风险，确认后再执行分析。',
    icon: ClipboardList,
  },
  {
    id: 'auto',
    label: '自动模式',
    description: '自动执行安全分析，高风险动作仍会停下确认。',
    icon: Zap,
  },
] as const satisfies ReadonlyArray<{
  id: ComposerMode
  label: string
  description: string
  icon: LucideIcon
}>

function errorCardTitle(message?: string) {
  // 错误标题只描述已知事实。
  //
  // 模型、工具和网络问题要分别呈现，避免把 provider 400 误导成连接失败。
  const normalized = (message ?? '').toLowerCase()
  if (!normalized.trim()) return '运行出错'
  if (normalized.includes('response_format') || normalized.includes('invalid_request_error') || normalized.includes('badrequesterror') || normalized.includes('模型')) {
    return '模型调用失败'
  }
  if (normalized.includes('工具') || normalized.includes('tool')) {
    return '工具执行失败'
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network') || normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('无法连接') || normalized.includes('连接')) {
    return '连接失败'
  }
  return '运行出错'
}

export function ChatPanel(props: ChatPanelProps) {
  const {
    artifactCount,
    currentRunId,
    currentThreadId,
    currentThreadTitle,
    runCreatedAt,
    providerLabel,
    runStatus,
    query,
    isSubmitting,
    errorMessage,
    uploadedLayerName,
    intent,
    clarification,
    sessionThreads,
    transcriptEntries,
    availableTools = [],
    onQueryChange,
    onSubmit,
    onInterrupt,
    onNewConversation,
    onFillSample,
    onSelectClarification,
    onUseTemplate,
    onUploadFiles,
    onSelectArtifact,
    onSelectTask,
    onRenameTask,
    onDeleteTask,
    onResolveApproval,
    dataReferences,

    memories,
    onRefreshMemories,
    tokenBudget,
    activeSkills,
    compactionLevel,
    runStats,
    denialCounts,

    executionPlan,
    onApprovePlan,
    onEditPlan,
    tasks: progressTasks,
    sessions,
    onSelectSession,
    onResumeSession,
  } = props
  const [taskViewState, setTaskViewState] = useState<{ mode: TaskView; bound?: string }>({
    mode: 'chat',
    bound: currentRunId,
  })
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<TaskDialog>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [composing, setComposing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [clarificationDialogOpen, setClarificationDialogOpen] = useState(false)
  const [composerMode, setComposerMode] = useState<ComposerMode>('auto')
  const triggerRef = useRef<HTMLElement | null>(null)
  const firstClarificationOptionRef = useRef<HTMLButtonElement | null>(null)
  const composerInputRef = useRef<HTMLInputElement | null>(null)
  const submittingRef = useRef(false)
  const reducedMotion = useReducedMotion() ?? false
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const timelineRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  const handleTimelineScroll = useCallback(() => {
    const el = timelineRef.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  useEffect(() => {
    if (!isSubmitting) {
      submittingRef.current = false
    }
  }, [isSubmitting])

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const taskView = taskViewState.bound === currentRunId ? taskViewState.mode : 'chat'
  const setTaskView = (mode: TaskView) => setTaskViewState({ mode, bound: currentRunId })
  const selectedComposerMode = COMPOSER_MODES.find((mode) => mode.id === composerMode) ?? COMPOSER_MODES[1]
  const SelectedModeIcon = selectedComposerMode.icon
  const conversation = useMemo(
    () => deriveConversationEntries(transcriptEntries, runStatus, availableTools),
    [availableTools, runStatus, transcriptEntries],
  )
  const errorTitle = useMemo(() => errorCardTitle(errorMessage), [errorMessage])
  const activeClarification = useMemo(
    () => buildActiveClarification(clarification, intent),
    [clarification, intent],
  )
  const activeClarificationKey = activeClarification?.key ?? null
  const clarificationBusy = isSubmitting && runStatus === 'running'

  useEffect(() => {
    setClarificationDialogOpen(Boolean(activeClarificationKey))
  }, [activeClarificationKey])

  useEffect(() => {
    if (!clarificationDialogOpen || !activeClarification) {
      return
    }
    const frame = requestAnimationFrame(() => firstClarificationOptionRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [activeClarification, clarificationDialogOpen])

  // 新消息到达时自动滚到底部，除非用户手动上滚
  useEffect(() => {
    const el = timelineRef.current
    if (!el || !nearBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [conversation])

  const recentTasks = useMemo(() => sessionThreads.slice(0, 4), [sessionThreads])
  const filteredTasks = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) {
      return sessionThreads
    }
    return sessionThreads.filter((task) =>
      [task.title, task.latestUserQuery, task.historyPreview, task.id]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(keyword)),
    )
  }, [search, sessionThreads])
  const tasks = taskView === 'all' ? filteredTasks : recentTasks
  const isTaskMode = taskView !== 'chat'
  const showSamples = !isSubmitting && conversation.length === 0 && !isTaskMode
  const feedVariants = buildListVariants(reducedMotion, 0.02, 0.008)
  const entryVariants = buildListItemVariants(reducedMotion, 8)

  const openRename = (task: AgentThreadRecord) => {
    triggerRef.current = document.activeElement as HTMLElement | null
    setTitleDraft(task.title)
    setDialog({ mode: 'rename', task })
  }
  const openDelete = (task: AgentThreadRecord) => {
    triggerRef.current = document.activeElement as HTMLElement | null
    setDialog({ mode: 'delete', task })
  }
  const closeDialog = () => {
    setDialog(null)
    setTitleDraft('')
    requestAnimationFrame(() => {
      triggerRef.current?.focus()
      triggerRef.current = null
    })
  }
  const submitRename = () => {
    if (dialog?.mode === 'rename' && titleDraft.trim() && titleDraft.trim() !== dialog.task.title) {
      onRenameTask(dialog.task.id, titleDraft.trim())
    }
    closeDialog()
  }
  const submitDelete = () => {
    if (dialog?.mode === 'delete') {
      onDeleteTask(dialog.task.id)
    }
    closeDialog()
  }
  const handleSubmit = (event?: FormEvent) => {
    event?.preventDefault()
    if (submittingRef.current || isSubmitting || composing || !query.trim()) {
      return
    }
    submittingRef.current = true
    setModeMenuOpen(false)
    onSubmit(composerMode)
  }
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      setComposerMode((current) => {
        const index = COMPOSER_MODES.findIndex((mode) => mode.id === current)
        return COMPOSER_MODES[(index + 1) % COMPOSER_MODES.length].id
      })
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing) {
      event.preventDefault()
      handleSubmit()
    }
  }
  const handleInterrupt = () => {
    setModeMenuOpen(false)
    onInterrupt?.()
  }
  const handleClarificationSelect = (option: ClarificationOption) => {
    setClarificationDialogOpen(false)
    onSelectClarification(option.label, option.optionId)
  }
  const handleClarificationFreeText = () => {
    setClarificationDialogOpen(false)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  const renderTimelineEntry = (entry: ConversationEntry) => {
    if (entry.kind === 'message' && entry.role === 'user') {
      return (
        <m.div key={entry.id} className="cc-user-prompt" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          {entry.body}
        </m.div>
      )
    }

    if (entry.kind === 'message' && entry.role === 'assistant') {
      const isThought = isThoughtEntry(entry)
      const thoughtExpanded = isThought && expandedIds.has(entry.id)
      return (
        <m.div
          key={entry.id}
          className={`cc-timeline-item ${isThought ? 'cc-timeline-item--thought' : 'cc-timeline-item--answer'}`}
          layout
          variants={entryVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            {isThought ? (
              <button className="cc-thought-toggle" type="button" aria-expanded={thoughtExpanded} onClick={() => toggleExpanded(entry.id)}>
                <ChevronDown size={14} className={`cc-chevron ${thoughtExpanded ? 'cc-chevron--open' : ''}`} />
                <span>{formatThoughtLabel(entry)}</span>
                {entry.status === 'running' && <span className="cc-thinking-pulse" />}
              </button>
            ) : null}
            <AnimatePresence initial={false}>
              {(!isThought || thoughtExpanded) && (
                <m.div className={`cc-assistant-copy ${isThought ? 'cc-assistant-copy--thought' : ''}`} {...(isThought ? buildFadeUpMotion(reducedMotion, 0, 6) : {})}>
                  <Markdown streaming={entry.status === 'running'}>{entry.body}</Markdown>
                </m.div>
              )}
            </AnimatePresence>
            {entry.artifactId && (
              <button className="cc-mini-button mt-2" onClick={() => onSelectArtifact(entry.artifactId!)}>
                在地图中查看
              </button>
            )}
          </div>
        </m.div>
      )
    }

    if (entry.kind === 'command_batch') {
      const commands = entry.commands ?? []
      return (
        <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--tool" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            {commands.length > 1 && (
              <div className="cc-command-summary cc-command-summary--static">
                <span>{formatCommandBatchTitle(entry)}</span>
              </div>
            )}
            <m.div className="cc-tool-stack" {...buildFadeUpMotion(reducedMotion, 0, 6)}>
              {commands.map((command) => (
                <ToolCommandCard
                  key={command.id}
                  command={command}
                  expanded={expandedIds.has(command.id)}
                  onToggle={() => toggleExpanded(command.id)}
                />
              ))}
            </m.div>
          </div>
        </m.div>
      )
    }

    if (entry.kind === 'approval') {
      return (
        <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <ApprovalCard entry={entry} onResolve={onResolveApproval} />
          </div>
        </m.div>
      )
    }

    if (entry.kind === 'error') {
      return (
        <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--error" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <div className="cc-error-card">
              <strong>{entry.title || '运行遇到问题'}</strong>
              <span>{entry.body}</span>
              {entry.recoveryNote && <em>{entry.recoveryNote}</em>}
            </div>
          </div>
        </m.div>
      )
    }

    if (entry.kind === 'system') {
      return (
        <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--system" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <div className="cc-system-card">
              <span className="cc-system-card__badge">{entry.title}</span>
              <span>{entry.body}</span>
            </div>
          </div>
        </m.div>
      )
    }

    const isExpanded = expandedIds.has(entry.id)
    return (
      <m.div key={entry.id} className={`cc-timeline-item cc-timeline-item--${entry.status === 'running' ? 'running' : 'thought'}`} layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          <button className="cc-thought-toggle" type="button" aria-expanded={isExpanded} onClick={() => toggleExpanded(entry.id)}>
            <ChevronDown size={14} className={`cc-chevron ${isExpanded ? 'cc-chevron--open' : ''}`} />
            <span>{formatThoughtLabel(entry)}</span>
          </button>
          <AnimatePresence initial={false}>
            {isExpanded && (
              <m.div className="cc-assistant-copy" {...buildFadeUpMotion(reducedMotion, 0, 6)}>
                <Markdown streaming={entry.status === 'running'}>{entry.body}</Markdown>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </m.div>
    )
  }

  return (
    <div className="cc-wrap">
      <LayoutGroup id={currentRunId ?? currentThreadId ?? 'home'}>
        <m.section className="cc-panel" layout {...buildFadeUpMotion(reducedMotion, 0, 10)}>
          <header className="cc-panel-header">
            <div className="cc-title-block">
              <span>{currentThreadTitle ?? '新对话'}</span>
              <small>{formatStatusLine(runStatus, providerLabel, artifactCount, uploadedLayerName)}</small>
            </div>
            <div className="cc-header-actions">
              {sessionThreads.length > 0 && (
                <button className="cc-icon-button" aria-label="任务历史" onClick={() => setTaskView(taskView === 'chat' ? 'summary' : 'chat')}>
                  <AppIcon name="history" size={15} />
                  <span>{taskView === 'chat' ? sessionThreads.length : '返回'}</span>
                </button>
              )}
              {sessions && sessions.length > 0 && (
                <button className="cc-icon-button" aria-label="历史会话" onClick={() => setShowHistory(!showHistory)}>
                  <AppIcon name="history_edu" size={15} />
                  <span>{showHistory ? '返回' : sessions.length}</span>
                </button>
              )}
              <button className="cc-icon-button" aria-label="新建对话" onClick={onNewConversation}>
                <Pencil size={14} />
                <span>新建</span>
              </button>
            </div>
          </header>

          <AnimatePresence mode="wait" initial={false}>
            {showHistory ? (
              <m.section key="sessions" className="cc-session-view" aria-label="历史会话" layout {...buildFadeUpMotion(reducedMotion, 0, 16)}>
                <ProgressSessionPanel
                  sessions={sessions ?? []}
                  onSelectSession={onSelectSession}
                  onResume={onResumeSession}
                />
              </m.section>
            ) : isTaskMode ? (
              <m.section key={`tasks-${taskView}`} className="cc-task-view" aria-label="任务列表" layout {...buildFadeUpMotion(reducedMotion, 0, 16)}>
                <div className="cc-task-top">
                  <button className="cc-back-button" onClick={() => (taskView === 'all' ? setTaskView('summary') : setTaskView('chat'))}>
                    <AppIcon name="arrow_back" size={15} />
                    {taskView === 'all' ? '最近' : '关闭'}
                  </button>
                  <strong>{taskView === 'all' ? '全部任务' : '最近任务'}</strong>
                  <span>{sessionThreads.length} 个</span>
                </div>
                {taskView === 'all' && <input className="cc-task-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务" />}
                <m.div className="cc-task-list" variants={feedVariants} initial="hidden" animate="visible" layout>
                  {tasks.length ? (
                    tasks.map((task) => (
                      <div key={task.id} className="cc-task-row-wrap">
                        <button
                          className={`cc-task-row ${task.id === currentThreadId ? 'cc-task-row--active' : ''}`}
                          onClick={() => {
                            onSelectTask(task.id)
                            setTaskView('chat')
                            setSearch('')
                          }}
                        >
                          <span>
                            <strong>{task.title}</strong>
                            <small>{task.historyPreview || task.latestUserQuery || '暂无摘要'}</small>
                          </span>
                        </button>
                        <div className="cc-task-actions">
                          <button aria-label="重命名" onClick={() => openRename(task)}>
                            <Pencil size={13} />
                          </button>
                          <button aria-label="删除" onClick={() => openDelete(task)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="cc-empty">没有匹配的任务</div>
                  )}
                </m.div>
                {taskView === 'summary' && sessionThreads.length > recentTasks.length && (
                  <button className="cc-view-all" onClick={() => setTaskView('all')}>
                    查看全部 {sessionThreads.length} 个任务
                  </button>
                )}
              </m.section>
            ) : (
              <m.div key={`chat-${currentRunId ?? 'idle'}`} className="cc-chat-mode" layout {...buildFadeMotion(reducedMotion)}>
                <m.div ref={timelineRef} onScroll={handleTimelineScroll} className="cc-timeline" aria-label="对话" aria-live="polite" variants={feedVariants} initial="hidden" animate="visible">
                  {executionPlan && executionPlan.steps.length > 0 && (
                    <PlanPanel plan={executionPlan} onApprove={onApprovePlan} onEdit={onEditPlan} entryVariants={entryVariants} />
                  )}
                  {progressTasks && progressTasks.length > 0 && (
                    <TaskPanel tasks={progressTasks} entryVariants={entryVariants} />
                  )}
                  {memories && memories.length > 0 && (
                    <MemoryPanel memories={memories} onRefresh={onRefreshMemories} />
                  )}
                  {activeClarification && (
                    <m.div className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
                      <span className="cc-timeline-dot" />
                      <div className="cc-timeline-body">
                        <div className="cc-clarification-card">
                          <div className="cc-clarification-card__copy">
                            <strong>需要确认</strong>
                            <span>{activeClarification.question}</span>
                          </div>
                          <button className="cc-mini-button cc-mini-button--primary" disabled={clarificationBusy} onClick={() => setClarificationDialogOpen(true)}>
                            选择答案
                          </button>
                        </div>
                      </div>
                    </m.div>
                  )}
                  {errorMessage && (
                    <m.div className="cc-timeline-item cc-timeline-item--error" role="alert" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
                      <span className="cc-timeline-dot" />
                      <div className="cc-timeline-body">
                        <div className="cc-error-card">
                          <strong>{errorTitle}</strong>
                          <span>{errorMessage}</span>
                          <button className="cc-mini-button" onClick={() => onSubmit(composerMode)}>
                            重试
                          </button>
                        </div>
                      </div>
                    </m.div>
                  )}
                  {conversation.length ? (
                    <AnimatePresence initial={false}>{conversation.map(renderTimelineEntry)}</AnimatePresence>
                  ) : isSubmitting ? (
                    <m.div className="cc-timeline-item cc-timeline-item--running" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
                      <span className="cc-timeline-dot" />
                      <div className="cc-timeline-body">
                        <button className="cc-thought-toggle" type="button">
                          <span>正在思考…</span>
                          <ChevronDown size={14} />
                        </button>
                        <div className="cc-assistant-copy">
                          <p>正在分析你的问题...</p>
                        </div>
                      </div>
                    </m.div>
                  ) : (
                    <m.div className="cc-empty cc-empty--chat" layout {...buildFadeUpMotion(reducedMotion, 0, 12)}>
                      {dataReferences.length ? (
                        <DataReferenceCard references={dataReferences} />
                      ) : (
                        <>
                          <strong>有什么可以帮你分析？</strong>
                          <span>输入一个地点、范围、图层或空间关系，我会把过程放在这条时间线上。</span>
                        </>
                      )}
                    </m.div>
                  )}
                </m.div>

                <div className="cc-run-footer">
                  <span>{runCreatedAt && runStatus === 'running' ? `运行中 ${fmtElapsed(runCreatedAt)}` : '输入空间问题，按回车开始分析'}</span>
                  {dataReferences.length ? <span>引用 {dataReferences.length} 个数据</span> : uploadedLayerName && <span>已接入 {uploadedLayerName}</span>}
                </div>
              </m.div>
            )}
          </AnimatePresence>

          <m.form className="cc-composer" layout onSubmit={handleSubmit} {...buildFadeUpMotion(reducedMotion, 0.02, 10)}>
            <input
              ref={composerInputRef}
              className="cc-composer-input"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={handleKey}
              placeholder="描述你的空间分析需求…"
              autoComplete="off"
            />
            <div className={`cc-composer-mode-note cc-composer-mode-note--${composerMode}`}>
              <SelectedModeIcon size={14} />
              <span>{selectedComposerMode.label}</span>
              <small>{composerMode === 'plan' ? '待办优先 · 先出计划' : 'Todo 跟踪 · 自动推进'}</small>
            </div>
            {tokenBudget && <TokenBudgetBar budget={tokenBudget} />}
            {(activeSkills && activeSkills.length > 0) || compactionLevel || runStats || (denialCounts && Object.keys(denialCounts).length > 0) ? (
              <RunStatusBar
                activeSkills={activeSkills}
                compactionLevel={compactionLevel}
                runStats={runStats}
                denialCounts={denialCounts}
              />
            ) : null}
            <div className="cc-composer-toolbar">
              <label className="cc-composer-tool" htmlFor="chat-file-upload" aria-label="上传图层">
                <Plus size={19} />
              </label>
              <input
                id="chat-file-upload"
                type="file"
                hidden
                multiple
                accept=".geojson,.json,.gpkg,.zip,.nc,.nc4,.tif,.tiff,.grib,.grb,.grb2,.h5,.hdf5,.bz2"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  if (files.length) {
                    onUploadFiles(files)
                  }
                  event.target.value = ''
                }}
              />
              <label className="cc-composer-tool" htmlFor="chat-folder-upload" aria-label="上传文件夹">
                <FolderUp size={18} />
              </label>
              <input
                id="chat-folder-upload"
                type="file"
                hidden
                multiple
                {...DIRECTORY_PICKER_PROPS}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  if (files.length) {
                    onUploadFiles(files)
                  }
                  event.target.value = ''
                }}
              />
              <button className="cc-composer-tool" type="button" aria-label="使用模板" onClick={onUseTemplate}>
                <Square size={17} />
              </button>
            <span className="cc-composer-spacer" />
              <div className="cc-mode-picker">
                <button
                  className={`cc-mode-trigger cc-mode-trigger--${composerMode}`}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={modeMenuOpen}
                  onClick={() => setModeMenuOpen((open) => !open)}
                >
                  <SelectedModeIcon size={14} />
                  <span>{selectedComposerMode.label}</span>
                </button>
                <AnimatePresence initial={false}>
                  {modeMenuOpen && (
                    <m.div
                      className="cc-mode-menu"
                      role="menu"
                      {...buildFadeUpMotion(reducedMotion, 0, 8)}
                    >
                      <div className="cc-mode-menu__header">
                        <span>模式</span>
                        <small>⇧ + Tab 切换</small>
                      </div>
                      <div className="cc-mode-menu__list">
                        {COMPOSER_MODES.map((mode) => {
                          const ModeIcon = mode.icon
                          const active = composerMode === mode.id
                          return (
                            <button
                              key={mode.id}
                              className={`cc-mode-option ${active ? 'cc-mode-option--active' : ''}`}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              onClick={() => {
                                setComposerMode(mode.id)
                                setModeMenuOpen(false)
                              }}
                            >
                              <ModeIcon size={18} />
                              <span>
                                <strong>{mode.label}</strong>
                                <small>{mode.description}</small>
                              </span>
                              {active && <span className="cc-mode-option__check">✓</span>}
                            </button>
                          )
                        })}
                      </div>
                    </m.div>
                  )}
                </AnimatePresence>
              </div>
              <span className="cc-provider-chip" title={providerLabel}>
                <Settings2 size={14} />
                {providerLabel}
              </span>
              <button
                className={`cc-send ${isSubmitting ? 'cc-send--interrupt' : ''}`}
                type={isSubmitting ? 'button' : 'submit'}
                disabled={!isSubmitting && !query.trim()}
                aria-label={isSubmitting ? '中断运行' : '发送'}
                onClick={isSubmitting ? handleInterrupt : undefined}
              >
                {isSubmitting ? (
                  <>
                    <Square size={14} />
                    <span>中断</span>
                  </>
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            </div>
          </m.form>
        </m.section>
      </LayoutGroup>

      {showSamples && (
        <m.div className="cc-samples" {...buildFadeUpMotion(reducedMotion, 0.06, 8)}>
          {SAMPLES.map((sample) => (
            <button key={sample} onClick={() => onFillSample(sample)}>
              {sample}
            </button>
          ))}
        </m.div>
      )}

      <AnimatePresence>
        {dialog && (
          <m.div className="alert-overlay" onClick={closeDialog} {...buildFadeMotion(reducedMotion)}>
            <m.div
              className="alert"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.key === 'Escape' && closeDialog()}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              {...buildFadeUpMotion(reducedMotion, 0, 12)}
            >
              {dialog.mode === 'rename' ? (
                <>
                  <div>
                    <h2>重命名任务</h2>
                    <p>给这个任务起个好记的名字。</p>
                  </div>
                  <input className="input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} autoFocus placeholder="输入新标题" />
                  <div className="alert-actions">
                    <button className="alert-btn" onClick={closeDialog}>
                      取消
                    </button>
                    <button className="alert-btn" onClick={submitRename} disabled={!titleDraft.trim()}>
                      保存
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <h2>删除任务</h2>
                    <p>「{dialog.task.title}」及其运行记录将被移除。</p>
                  </div>
                  <div className="alert-actions">
                    <button className="alert-btn" onClick={closeDialog}>
                      取消
                    </button>
                    <button className="alert-btn alert-btn-destructive" onClick={submitDelete}>
                      删除
                    </button>
                  </div>
                </>
              )}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {clarificationDialogOpen && activeClarification && (
          <m.div
            className="cc-clarification-overlay"
            onClick={() => setClarificationDialogOpen(false)}
            {...buildFadeMotion(reducedMotion)}
          >
            <m.div
              className="cc-clarification-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="clarification-title"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.key === 'Escape' && setClarificationDialogOpen(false)}
              tabIndex={-1}
              {...buildScaleInMotion(reducedMotion)}
            >
              <div className="cc-clarification-dialog__header">
                <span>需要确认</span>
                <strong id="clarification-title">{activeClarification.question}</strong>
              </div>
              {activeClarification.options.length > 0 ? (
                <m.div className="cc-clarification-options" variants={feedVariants} initial="hidden" animate="visible">
                  {activeClarification.options.map((option, index) => (
                    <m.button
                      key={option.optionId ?? `${option.label}:${index}`}
                      ref={index === 0 ? firstClarificationOptionRef : undefined}
                      className="cc-clarification-option"
                      type="button"
                      disabled={clarificationBusy}
                      variants={entryVariants}
                      onClick={() => handleClarificationSelect(option)}
                    >
                      <span>
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                      <ChevronDown size={15} />
                    </m.button>
                  ))}
                </m.div>
              ) : (
                <div className="cc-clarification-empty">
                  <span>没有可直接选择的候选项。</span>
                  {activeClarification.allowFreeText && (
                    <button className="cc-mini-button cc-mini-button--primary" type="button" onClick={handleClarificationFreeText}>
                      回到输入框补充
                    </button>
                  )}
                </div>
              )}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ===== 新增子组件 =====

function TokenBudgetBar({ budget }: { budget: NonNullable<ChatPanelProps['tokenBudget']> }) {
  const pct = budget.max > 0 ? Math.min((budget.used / budget.max) * 100, 100) : 0
  const fillClass = ({
    normal: 'cc-token-fill--normal',
    warning: 'cc-token-fill--warning',
    critical: 'cc-token-fill--critical',
    exceeded: 'cc-token-fill--exceeded',
  } as Record<string, string>)[budget.status] ?? 'cc-token-fill--normal'

  return (
    <div className="cc-token-budget">
      <div className="cc-token-budget__info">
        <span>Token 预算</span>
        <span className={budget.status === 'exceeded' || budget.status === 'critical' ? 'cc-token-budget__used--alert' : ''}>
          {budget.used.toLocaleString()} / {budget.max.toLocaleString()}
        </span>
      </div>
      <div className="cc-token-budget__bar">
        <div className={`cc-token-budget__fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function RunStatusBar({ activeSkills, compactionLevel, runStats, denialCounts }: {
  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: NonNullable<ChatPanelProps['runStats']>
  denialCounts?: Record<string, number>
}) {
  const denialItems = denialCounts && Object.keys(denialCounts).length > 0
    ? Object.entries(denialCounts).filter(([, count]) => count > 0)
    : []

  return (
    <div className="cc-run-status">
      {activeSkills && activeSkills.length > 0 && (
        <span className="cc-run-status__item">
          <Settings2 size={12} />
          {activeSkills.join(', ')}
        </span>
      )}
      {compactionLevel && (
        <span className="cc-run-status__item">
          压缩: {compactionLevel}
        </span>
      )}
      {runStats && (
        <span className="cc-run-status__item">
          工具: {runStats.toolSuccesses}/{runStats.toolAttempts} 成功
          · Token: {runStats.tokensUsed.toLocaleString()}
        </span>
      )}
      {denialItems.length > 0 && (
        <span className="cc-run-status__item cc-run-status__item--warning">
          拒绝: {denialItems.map(([tool, count]) => `${tool} ${count}`).join(', ')}
        </span>
      )}
    </div>
  )
}

function MemoryPanel({ memories, onRefresh }: { memories: MemoryEntry[]; onRefresh?: () => void }) {
  const [isOpen, setIsOpen] = useState(false)
  if (!memories.length) return null

  return (
    <div className="cc-memory-panel">
      <button className="cc-memory-panel__toggle" type="button" onClick={() => setIsOpen(!isOpen)}>
        <ChevronDown size={14} className={`cc-chevron ${isOpen ? 'cc-chevron--open' : ''}`} />
        <span>记忆系统</span>
        <span className="cc-memory-panel__count">{memories.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <m.div className="cc-memory-panel__list" {...buildFadeUpMotion(false, 0, 4)}>
            {memories.map((mem) => {
              const typeLabel = ({ user: '用户', feedback: '反馈', project: '项目', reference: '参考' } as Record<string, string>)[mem.type] ?? mem.type
              return (
                <div key={mem.name} className="cc-memory-item">
                  <span className={`cc-memory-item__type cc-memory-item__type--${mem.type}`}>{typeLabel}</span>
                  <div className="cc-memory-item__body">
                    <strong>{mem.name}</strong>
                    <span>{mem.description}</span>
                  </div>
                  <span className="cc-memory-item__age">{mem.age}</span>
                </div>
              )
            })}
            {onRefresh && (
              <button className="cc-memory-panel__refresh" type="button" onClick={onRefresh}>刷新记忆</button>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ApprovalCard({ entry, onResolve }: { entry: ConversationEntry; onResolve: (id: string, approved: boolean) => void }) {
  return (
    <>
      <pre className="cc-task-notice">{buildTaskNotification(entry)}</pre>
      <div className="cc-approval-copy">
        <strong>{entry.title}</strong>
        <span>{entry.body}</span>
      </div>
      {entry.approvalId && (
        <div className="cc-approval-actions">
          <button className="cc-mini-button cc-mini-button--primary" onClick={() => onResolve(entry.approvalId!, true)}>
            批准发布
          </button>
          <button className="cc-mini-button" onClick={() => onResolve(entry.approvalId!, false)}>
            暂不发布
          </button>
        </div>
      )}
    </>
  )
}

function DataReferenceCard({ references }: { references: DataReferenceSummary[] }) {
  const visible = references.slice(0, 8)
  const hiddenCount = Math.max(0, references.length - visible.length)
  return (
    <div className="cc-data-context">
      <div className="cc-data-context__head">
        <strong>当前引用的数据</strong>
        <span>{references.length} 个文件/结果</span>
      </div>
      <div className="cc-data-context__list">
        {visible.map((reference) => (
          <div key={reference.id} className="cc-data-reference">
            <span className={`cc-data-reference__kind cc-data-reference__kind--${reference.kind}`}>{formatReferenceKind(reference.kind)}</span>
            <span className="cc-data-reference__main">
              <strong title={reference.relativePath ?? reference.name}>{reference.relativePath ?? reference.name}</strong>
              <small>{reference.detail}</small>
            </span>
            <span className="cc-data-reference__status">{reference.status}</span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && <span className="cc-data-context__more">还有 {hiddenCount} 个文件已接入，可在数据源面板查看。</span>}
    </div>
  )
}

// ===== 新增 Plan / Task / Session 面板 =====

function PlanPanel({ plan, onApprove, onEdit, entryVariants }: {
  plan: NonNullable<ChatPanelProps['executionPlan']>
  onApprove?: () => void
  onEdit?: () => void
  entryVariants: Variants
}) {
  return (
    <m.div key="plan-panel" className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
      <span className="cc-timeline-dot" />
      <div className="cc-timeline-body">
        <div className="cc-plan-panel">
          <div className="cc-plan-panel__header">
            <AppIcon name="psychology" size={16} />
            <span>执行计划</span>
          </div>
          <div className="cc-plan-panel__goal">{plan.goal}</div>
          <div className="cc-plan-steps">
            {plan.steps.map((step, i) => (
              <div key={i} className="cc-plan-step">
                <span className="cc-plan-step__num">{i + 1}</span>
                <div className="cc-plan-step__body">
                  <span className="cc-plan-step__tool">{step.tool}</span>
                  {step.args && Object.keys(step.args).length > 0 && (
                    <code className="cc-plan-step__args">{JSON.stringify(step.args)}</code>
                  )}
                  <span className="cc-plan-step__reason">{step.reason}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="cc-plan-actions">
            {onApprove && (
              <button className="cc-mini-button cc-mini-button--primary" onClick={onApprove}>确认执行</button>
            )}
            {onEdit && (
              <button className="cc-mini-button" onClick={onEdit}>修改计划</button>
            )}
          </div>
        </div>
      </div>
    </m.div>
  )
}

function TaskPanel({ tasks, entryVariants }: {
  tasks: NonNullable<ChatPanelProps['tasks']>
  entryVariants: Variants
}) {
  const completed = tasks.filter(t => t.status === 'completed').length
  const total = tasks.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  const currentTask = tasks.find((task) => task.status === 'running') ?? tasks.find((task) => task.status === 'pending') ?? tasks.at(-1)
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <m.div key="task-progress" className="cc-timeline-item cc-timeline-item--todo" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
      <span className="cc-timeline-dot" />
      <div className="cc-timeline-body">
        <div className="cc-task-progress">
          <div className="cc-task-progress__header">
            <strong>Todo</strong>
            <span>{completed}/{total} 完成</span>
          </div>
          {currentTask && (
            <div className="cc-task-progress__current">
              <span>{formatTaskStatus(currentTask.status)}</span>
              <strong>{currentTask.status === 'running' ? currentTask.activeForm || currentTask.content : currentTask.content}</strong>
            </div>
          )}
          <div className="cc-task-progress__bar">
            <div className="cc-task-progress__fill" style={{ width: `${pct}%` }} />
          </div>
          <button className="cc-thought-toggle" type="button" onClick={() => setIsExpanded(!isExpanded)}>
            <ChevronDown size={14} className={`cc-chevron ${isExpanded ? 'cc-chevron--open' : ''}`} />
            <span>{isExpanded ? '收起 Todo' : '展开 Todo'}</span>
          </button>
          <AnimatePresence initial={false}>
            {isExpanded && (
              <m.div className="cc-task-progress__list" {...buildFadeUpMotion(false, 0, 4)}>
                {tasks.map(task => (
                  <div key={task.id} className="cc-task-progress-item">
                    <span className="cc-task-progress-item__content">{task.content}</span>
                    <span className={`cc-task-progress-item__tag cc-task-progress-item__tag--${task.status}`}>
                      {formatTaskStatus(task.status)}
                    </span>
                  </div>
                ))}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </m.div>
  )
}

function ProgressSessionPanel({ sessions, onSelectSession, onResume }: {
  sessions: NonNullable<ChatPanelProps['sessions']>
  onSelectSession?: (id: string) => void
  onResume?: (sessionId: string) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter(s =>
      s.title.toLowerCase().includes(keyword) ||
      s.latest_query.toLowerCase().includes(keyword)
    )
  }, [sessions, search])

  return (
    <div className="cc-session-panel">
      <div className="cc-session-panel__header">
        <strong>历史会话</strong>
        <span className="text-[12px] text-[#6e7781]">{sessions.length} 个</span>
      </div>
      <input
        className="cc-session-panel__search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="搜索会话..."
      />
      <div className="cc-session-panel__list">
        {filtered.length > 0 ? filtered.map(session => (
          <div key={session.id} className="cc-session-item">
            <div className="cc-session-item__info">
              <strong className="cc-session-item__title">{session.title || '未命名会话'}</strong>
              <span className="cc-session-item__query">{session.latest_query || '暂无查询记录'}</span>
            </div>
            <div className="cc-session-item__meta">
              <span>{formatSessionDate(session.created_at)}</span>
              <span>{session.run_count} 次运行</span>
            </div>
            <div className="cc-session-item__actions">
              {onSelectSession && (
                <button className="cc-mini-button" onClick={() => onSelectSession(session.id)}>查看</button>
              )}
              {onResume && (
                <button className="cc-mini-button cc-mini-button--primary" onClick={() => onResume(session.id)}>恢复</button>
              )}
            </div>
          </div>
        )) : (
          <div className="cc-session-empty">没有匹配的会话</div>
        )}
      </div>
    </div>
  )
}

function formatTaskStatus(status: string) {
  if (status === 'pending') return '待处理'
  if (status === 'in_progress' || status === 'running') return '进行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'blocked') return '待确认'
  return status
}

function formatSessionDate(dateStr: string) {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return dateStr
  }
}

function buildActiveClarification(clarification: ClarificationState | null | undefined, intent: UserIntent | undefined) {
  // 澄清显示事实源。
  //
  // request_clarification 工具写入 agentState.clarification；解析器早期歧义
  // 写入 intent。UI 优先展示运行态事实，避免工具成功但前端只看 intent 而空白。
  if (clarification && !clarification.selectedOptionId) {
    return {
      key: clarification.clarificationId,
      question: clarification.question,
      options: clarification.options,
      allowFreeText: clarification.allowFreeText,
    }
  }
  if (intent?.clarificationRequired) {
    return {
      key: `intent:${intent.clarificationQuestion ?? 'clarification'}`,
      question: intent.clarificationQuestion ?? '请确认下一步。',
      options: intent.clarificationOptions ?? [],
      allowFreeText: true,
    }
  }
  return null
}

function ToolCommandCard({
  command,
  expanded,
  onToggle,
}: {
  command: ConversationCommand
  expanded: boolean
  onToggle: () => void
}) {
  const isSearch = /Grep|Glob|ToolSearch|search/i.test(command.toolName ?? command.title)
  const isRead = /Read|load_layer|inspect|list_/i.test(command.toolName ?? command.title)
  const isRunning = command.status === 'running'
  const resultText = formatCommandOutput(command)
  const resultLong = resultText.length > 300
  const ToolIcon = isSearch ? Search : isRead ? FileText : Settings2

  return (
    <div className="cc-tool-row">
      <button className="cc-tool-row-head" type="button" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDown size={13} className={`cc-chevron ${expanded ? 'cc-chevron--open' : ''}`} />
        <span className={`cc-tool-row-icon ${isRunning ? 'cc-tool-row-icon--spin' : ''}`}>
          {isRunning ? <LoaderCircle size={13} /> : <ToolIcon size={13} />}
        </span>
        <span className="cc-tool-row-copy">
          <span className="cc-tool-row-title">{command.title}</span>
          {!expanded && <span className="cc-tool-row-subtitle">{formatCommandPreview(command, resultText)}</span>}
        </span>
        <span className={`cc-command-status cc-command-status--${command.status}`}>{formatCommandStatus(command.status)}</span>
      </button>
      {!expanded && command.commandText && (
        <div className="cc-tool-row-preview">
          <code>{trimMiddle(command.commandText.replace(/^>\s*/u, ''), 92)}</code>
        </div>
      )}
      <AnimatePresence initial={false}>
        {expanded && (
          <m.div className="cc-tool-detail" {...buildFadeUpMotion(false, 0, 4)}>
            {command.commandText && (
              <p className="cc-tool-args-block">
                <span>{command.toolName}</span>
                <code>{command.commandText.replace(/^>\s*/u, '')}</code>
              </p>
            )}
            {isRunning ? (
              <p className="cc-tool-detail-progress">执行中，等待工具返回…</p>
            ) : resultLong ? (
              <details>
                <summary>{resultText.slice(0, 200)}…</summary>
                <Markdown>{resultText}</Markdown>
              </details>
            ) : (
              <Markdown>{resultText}</Markdown>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function formatReferenceKind(kind: DataReferenceSummary['kind']) {
  if (kind === 'weather') return '气象'
  if (kind === 'artifact') return '结果'
  return '图层'
}

function isThoughtEntry(entry: ConversationEntry) {
  if (entry.details?._thinking) return true
  return entry.id.includes('narration:') || entry.id.includes('think-delta:')
}

function formatThoughtLabel(entry: ConversationEntry) {
  if (entry.status === 'running') return '思考中'
  const startedAt = typeof entry.details?._startedAt === 'string' ? entry.details._startedAt : null
  const endedAt = typeof entry.details?._endedAt === 'string' ? entry.details._endedAt : entry.timestamp
  if (startedAt && endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
    if (ms >= 1000) {
      return `思考了 ${fmtDuration(ms)}`
    }
  }
  return '思考过程'
}

function fmtDuration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const remain = seconds % 60
  return remain > 0 ? `${minutes}分${remain}秒` : `${minutes}分钟`
}

function formatCommandBatchTitle(entry: ConversationEntry) {
  const count = entry.commands?.length ?? 0
  if (entry.status === 'running') return `正在执行 ${count} 个工具`
  if (entry.status === 'failed') return `${count} 个工具里有失败项`
  return `已完成 ${count} 个工具`
}

function formatCommandStatus(status: string) {
  if (status === 'running') return '执行中'
  if (status === 'failed') return '失败'
  return '完成'
}

function formatCommandOutput(command: ConversationCommand) {
  if (command.status === 'running') {
    return '工具正在后台运行，完成后会在这里显示结果。'
  }
  const body = command.body.replace(/\s+/gu, ' ').trim()
  return body || formatCommandStatus(command.status)
}

function formatCommandPreview(command: ConversationCommand, resultText: string) {
  if (command.status === 'running') {
    return '执行中，等待结果返回'
  }
  return trimMiddle(resultText, 96)
}

function trimMiddle(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  const keep = Math.max(12, Math.floor((maxLength - 1) / 2))
  return `${normalized.slice(0, keep)}…${normalized.slice(-keep)}`
}

function buildTaskNotification(entry: ConversationEntry) {
  const taskId = entry.approvalId ?? entry.artifactId ?? entry.id
  return [`<task-notification>`, `<task-id>${taskId}</task-id>`, `<status>${entry.badge ?? entry.status}</status>`].join('\n')
}

function formatStatusLine(status: string | undefined, providerLabel: string, artifactCount: number, uploadedLayerName?: string) {
  const parts = [fmtStatus(status), providerLabel]
  if (artifactCount > 0) {
    parts.push(`${artifactCount} 结果`)
  }
  if (uploadedLayerName) {
    parts.push(uploadedLayerName)
  }
  return parts.join(' · ')
}

function fmtStatus(status?: string) {
  if (status === 'running') return '运行中'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '就绪'
}

function fmtElapsed(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}
