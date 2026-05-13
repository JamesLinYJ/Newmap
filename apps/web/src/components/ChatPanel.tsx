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
import { AnimatePresence, LayoutGroup, m, useReducedMotion } from 'framer-motion'
import { ArrowUp, ChevronDown, LoaderCircle, Pencil, Plus, Settings2, Square, Trash2 } from 'lucide-react'
import type { AgentRuntimeConfig, AgentThreadRecord, ToolDescriptor, UserIntent } from '@geo-agent-platform/shared-types'
import { buildFadeMotion, buildFadeUpMotion, buildListItemVariants, buildListVariants } from '../motion'
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
  sessionThreads: AgentThreadRecord[]
  transcriptEntries: ReadonlyArray<TranscriptEntry>
  runtimeConfig?: AgentRuntimeConfig
  availableTools?: ToolDescriptor[]
  onQueryChange: (value: string) => void
  onSubmit: () => void
  onNewConversation: () => void
  onFillSample: (value: string) => void
  onSelectClarification: (value: string, id?: string | null) => void
  onUseTemplate: () => void
  onUpload: (file: File) => void
  onSelectArtifact: (id: string) => void
  onSelectTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onDeleteTask: (id: string) => void
  onResolveApproval: (id: string, approved: boolean) => void
}

type TaskView = 'chat' | 'summary' | 'all'
type TaskDialog = { mode: 'rename' | 'delete'; task: AgentThreadRecord } | null

const SAMPLES = [
  '查询巴黎地铁站 1 公里范围内的医院',
  '判断我上传的点是否落在柏林行政区内',
  '查询叫 Springfield 的区域',
] as const

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
    sessionThreads,
    transcriptEntries,
    availableTools = [],
    onQueryChange,
    onSubmit,
    onNewConversation,
    onFillSample,
    onSelectClarification,
    onUseTemplate,
    onUpload,
    onSelectArtifact,
    onSelectTask,
    onRenameTask,
    onDeleteTask,
    onResolveApproval,
  } = props
  const [taskViewState, setTaskViewState] = useState<{ mode: TaskView; bound?: string }>({
    mode: 'chat',
    bound: currentRunId,
  })
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<TaskDialog>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [composing, setComposing] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const submittingRef = useRef(false)
  const reducedMotion = useReducedMotion() ?? false
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const manualCollapse = useRef<Set<string>>(new Set())
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

  const toggleExpanded = (id: string, manual = false) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        if (manual) manualCollapse.current.add(id)
      } else {
        next.add(id)
        if (manual) manualCollapse.current.delete(id)
      }
      return next
    })
  }

  const taskView = taskViewState.bound === currentRunId ? taskViewState.mode : 'chat'
  const setTaskView = (mode: TaskView) => setTaskViewState({ mode, bound: currentRunId })
  const conversation = useMemo(
    () => deriveConversationEntries(transcriptEntries, runStatus, availableTools),
    [availableTools, runStatus, transcriptEntries],
  )
  const errorTitle = useMemo(() => errorCardTitle(errorMessage), [errorMessage])

  // 新消息到达时自动滚到底部，除非用户手动上滚
  useEffect(() => {
    const el = timelineRef.current
    if (!el || !nearBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [conversation])

  // 新出现的 running thought 自动展开（除非用户手动折叠过）
  useEffect(() => {
    const idsToExpand: string[] = []
    for (const entry of conversation) {
      if (entry.kind === 'message' && entry.role === 'assistant' && entry.status === 'running' && isThoughtEntry(entry)) {
        if (!manualCollapse.current.has(entry.id)) {
          idsToExpand.push(entry.id)
        }
      }
    }
    // 清理完成状态 — 下次同 ID 重新 running 时允许再自动展开
    for (const id of manualCollapse.current) {
      if (!conversation.some(e => e.id === id && e.status === 'running')) {
        manualCollapse.current.delete(id)
      }
    }

    if (!idsToExpand.length) return
    const frame = window.requestAnimationFrame(() => {
      setExpandedIds((prev) => {
        if (idsToExpand.every((id) => prev.has(id))) return prev
        const next = new Set(prev)
        for (const id of idsToExpand) next.add(id)
        return next
      })
    })
    return () => window.cancelAnimationFrame(frame)
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
    onSubmit()
  }
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing) {
      event.preventDefault()
      handleSubmit()
    }
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
              <button className="cc-thought-toggle" type="button" onClick={() => toggleExpanded(entry.id, true)}>
                <ChevronDown size={14} className={`cc-chevron ${thoughtExpanded ? 'cc-chevron--open' : ''}`} />
                <span>{formatThoughtLabel(entry)}</span>
                {entry.status === 'running' && <span className="cc-thinking-pulse" />}
              </button>
            ) : null}
            <AnimatePresence initial={false}>
              {(!isThought || thoughtExpanded) && (
                <m.div className={`cc-assistant-copy ${isThought ? 'cc-assistant-copy--thought' : ''}`} {...(isThought ? buildFadeUpMotion(reducedMotion, 0, 6) : {})}>
                  <Markdown>{entry.body}</Markdown>
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
      const isExpanded = expandedIds.has(entry.id)
      const commands = entry.commands ?? []
      return (
        <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--tool" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <button className="cc-command-summary" type="button" aria-expanded={isExpanded} onClick={() => toggleExpanded(entry.id, true)}>
              <ChevronDown size={14} className={`cc-chevron ${isExpanded ? 'cc-chevron--open' : ''}`} />
              <span>{formatCommandBatchTitle(entry)}</span>
            </button>
            <AnimatePresence initial={false}>
              {isExpanded && (
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
              )}
            </AnimatePresence>
          </div>
        </m.div>
      )
    }

    if (entry.kind === 'approval') {
      return (
        <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <pre className="cc-task-notice">{buildTaskNotification(entry)}</pre>
            <div className="cc-approval-copy">
              <strong>{entry.title}</strong>
              <span>{entry.body}</span>
            </div>
            {entry.approvalId && (
              <div className="cc-approval-actions">
                <button className="cc-mini-button cc-mini-button--primary" onClick={() => onResolveApproval(entry.approvalId!, true)}>
                  批准发布
                </button>
                <button className="cc-mini-button" onClick={() => onResolveApproval(entry.approvalId!, false)}>
                  暂不发布
                </button>
              </div>
            )}
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

    const isExpanded = expandedIds.has(entry.id)
    return (
      <m.div key={entry.id} className={`cc-timeline-item cc-timeline-item--${entry.status === 'running' ? 'running' : 'thought'}`} layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          <button className="cc-thought-toggle" type="button" onClick={() => toggleExpanded(entry.id, true)}>
            <ChevronDown size={14} className={`cc-chevron ${isExpanded ? 'cc-chevron--open' : ''}`} />
            <span>{formatThoughtLabel(entry)}</span>
          </button>
          <AnimatePresence initial={false}>
            {isExpanded && (
              <m.div className="cc-assistant-copy" {...buildFadeUpMotion(reducedMotion, 0, 6)}>
                <Markdown>{entry.body}</Markdown>
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
              <button className="cc-icon-button" aria-label="新建对话" onClick={onNewConversation}>
                <Pencil size={14} />
                <span>新建</span>
              </button>
            </div>
          </header>

          <AnimatePresence mode="wait" initial={false}>
            {isTaskMode ? (
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
                  {intent?.clarificationRequired && (
                    <m.div className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
                      <span className="cc-timeline-dot" />
                      <div className="cc-timeline-body">
                        <div className="cc-approval-copy">
                          <strong>需要确认</strong>
                          <span>{intent.clarificationQuestion}</span>
                        </div>
                        <div className="cc-approval-actions">
                          {intent.clarificationOptions?.map((option) => (
                            <button
                              key={option.optionId ?? option.label}
                              className="cc-mini-button"
                              disabled={isSubmitting}
                              onClick={() => onSelectClarification(option.label, option.optionId)}
                            >
                              {option.label}
                            </button>
                          ))}
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
                          <button className="cc-mini-button" onClick={onSubmit}>
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
                      <strong>有什么可以帮你分析？</strong>
                      <span>输入一个地点、范围、图层或空间关系，我会把过程放在这条时间线上。</span>
                    </m.div>
                  )}
                </m.div>

                <div className="cc-run-footer">
                  <span>{runCreatedAt && runStatus === 'running' ? `运行中 ${fmtElapsed(runCreatedAt)}` : '输入空间问题，按回车开始分析'}</span>
                  {uploadedLayerName && <span>已接入 {uploadedLayerName}</span>}
                </div>
              </m.div>
            )}
          </AnimatePresence>

          <m.form className="cc-composer" layout onSubmit={handleSubmit} {...buildFadeUpMotion(reducedMotion, 0.02, 10)}>
            <input
              className="cc-composer-input"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={handleKey}
              placeholder="描述你的空间分析需求…"
              autoComplete="off"
            />
            <div className="cc-composer-toolbar">
              <label className="cc-composer-tool" htmlFor="chat-file-upload" aria-label="上传图层">
                <Plus size={19} />
              </label>
              <input
                id="chat-file-upload"
                type="file"
                hidden
                accept=".geojson,.json,.gpkg"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    onUpload(file)
                  }
                  event.target.value = ''
                }}
              />
              <button className="cc-composer-tool" type="button" aria-label="使用模板" onClick={onUseTemplate}>
                <Square size={17} />
              </button>
              <span className="cc-composer-spacer" />
              <span className="cc-permission">
                <Settings2 size={14} />
                {providerLabel}
              </span>
              <button className="cc-send" type="submit" disabled={isSubmitting || !query.trim()} aria-label="发送">
                {isSubmitting ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={18} />}
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
    </div>
  )
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
  return (
    <div className="cc-tool-row">
      <button className="cc-tool-row-head" type="button" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDown size={13} className={`cc-chevron ${expanded ? 'cc-chevron--open' : ''}`} />
        <span className="cc-tool-row-title">{command.title}</span>
        <span className={`cc-command-status cc-command-status--${command.status}`}>{formatCommandStatus(command.status)}</span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <m.div className="cc-tool-detail" {...buildFadeUpMotion(false, 0, 4)}>
            {command.commandText && (
              <p>
                <span>输入</span>
                <code>{command.commandText.replace(/^>\s*/u, '')}</code>
              </p>
            )}
            <Markdown>{command.status === 'running' ? '等待工具返回...' : formatCommandOutput(command)}</Markdown>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function isThoughtEntry(entry: ConversationEntry) {
  if (entry.details?._thinking) return true
  return entry.id.includes('narration:') || entry.id.includes('think-delta:')
}

function formatThoughtLabel(entry: ConversationEntry) {
  if (entry.status === 'running') return '思考中…'
  const startedAt = typeof entry.details?._startedAt === 'string' ? entry.details._startedAt : null
  const endedAt = typeof entry.details?._endedAt === 'string' ? entry.details._endedAt : entry.timestamp
  if (startedAt && endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
    if (ms >= 1000) {
      return `思考过程（${fmtDuration(ms)}）`
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
