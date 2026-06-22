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
// 对话功能的壳组件：持有本地输入、历史会话弹窗和面板展开态。
// 聊天事实源只来自 ConversationItem[]，具体 item 派生和条目渲染交给
// useConversation / ConversationTimeline。

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, LayoutGroup, m, useReducedMotion } from 'framer-motion'
import { Maximize2, Minimize2, Pencil, Trash2 } from 'lucide-react'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'
import { SAMPLES } from '../../shared/constants'
import { buildFadeMotion, buildFadeUpMotion, buildListItemVariants, buildListVariants } from '../../shared/motion'
import { AppIcon } from '../../shared/components/AppIcon'
import { Composer } from './Composer'
import { COMPOSER_MODES } from './composerModes'
import type { ChatPanelProps, ComposerMode, TaskView } from './types'
import {
  buildActiveClarification,
  errorCardTitle,
  formatSessionDate,
  formatStatusLine,
  useConversationEntries,
} from './useConversation'
import { deriveThreadTitleFromText, formatThreadDisplayTitle } from './threadTitles'

type TaskDialog = { mode: 'rename' | 'delete'; task: AgentThreadRecord } | null

const ConversationTimeline = lazy(() => import('./ConversationTimeline').then(module => ({
  default: module.ConversationTimeline,
})))

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
    items,
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
  } = props

  const [taskViewState, setTaskViewState] = useState<{ mode: TaskView; bound?: string }>({
    mode: 'chat',
    bound: currentRunId,
  })
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<TaskDialog>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [composing, setComposing] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [composerMode, setComposerMode] = useState<ComposerMode>('auto')
  const [isPanelExpanded, setIsPanelExpanded] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const firstClarificationOptionRef = useRef<HTMLButtonElement | null>(null)
  const composerInputRef = useRef<HTMLInputElement | null>(null)
  const submittingRef = useRef(false)
  const reducedMotion = useReducedMotion() ?? false

  const taskView = taskViewState.bound === currentRunId ? taskViewState.mode : 'chat'
  const setTaskView = (mode: TaskView) => setTaskViewState({ mode, bound: currentRunId })
  const conversation = useConversationEntries(items, runStatus, availableTools)
  const errorTitle = useMemo(() => errorCardTitle(errorMessage), [errorMessage])
  const activeClarification = useMemo(
    () => buildActiveClarification(clarification, intent),
    [clarification, intent],
  )
  const clarificationBusy = isSubmitting && runStatus === 'running'
  const feedVariants = buildListVariants(reducedMotion, 0.02, 0.008)
  const entryVariants = buildListItemVariants(reducedMotion, 8)
  const isTaskMode = taskView === 'history'
  const showSamples = !isSubmitting && conversation.length === 0 && !isTaskMode
  const currentThread = useMemo(
    () => sessionThreads.find((task) => task.id === currentThreadId),
    [currentThreadId, sessionThreads],
  )
  const displayCurrentThreadTitle = currentThread
    ? formatThreadDisplayTitle(currentThread)
    : deriveThreadTitleFromText(currentThreadTitle)

  useEffect(() => {
    if (!isSubmitting) {
      submittingRef.current = false
    }
  }, [isSubmitting])

  useEffect(() => {
    if (!isPanelExpanded) return
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setIsPanelExpanded(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPanelExpanded])

  useEffect(() => {
    if (!activeClarification) return
    const frame = requestAnimationFrame(() => firstClarificationOptionRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [activeClarification])

  const filteredTasks = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) {
      return sessionThreads
    }
    return sessionThreads.filter((task) =>
      [formatThreadDisplayTitle(task), task.latestUserQuery, task.historyPreview, task.id]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(keyword)),
    )
  }, [search, sessionThreads])

  const openRename = (task: AgentThreadRecord) => {
    triggerRef.current = document.activeElement as HTMLElement | null
    setTitleDraft(formatThreadDisplayTitle(task))
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
  const focusClarification = () => firstClarificationOptionRef.current?.focus()
  const focusComposerForFreeText = () => requestAnimationFrame(() => composerInputRef.current?.focus())

  return (
    <div className={`cc-wrap${isPanelExpanded ? ' cc-wrap--expanded' : ''}`}>
      {isPanelExpanded && createPortal(
        <m.div
          key="backdrop"
          className="cc-expand-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
          onClick={() => setIsPanelExpanded(false)}
        />,
        document.body,
      )}
      <LayoutGroup id={currentRunId ?? currentThreadId ?? 'home'}>
        <m.section className="cc-panel" layout {...buildFadeUpMotion(reducedMotion, 0, 10)}>
          <header className="cc-panel-header">
            <div className="cc-title-block">
              <span>{displayCurrentThreadTitle}</span>
              <small>{formatStatusLine(runStatus, providerLabel, artifactCount, uploadedLayerName)}</small>
            </div>
            <div className="cc-header-actions">
              {sessionThreads.length > 0 && (
                <button
                  className="cc-icon-button"
                  aria-label="历史会话"
                  onClick={() => {
                    setTaskView(taskView === 'chat' ? 'history' : 'chat')
                  }}
                >
                  <AppIcon name="history" size={15} />
                  <span>{taskView === 'chat' ? sessionThreads.length : '返回'}</span>
                </button>
              )}
              <button className="cc-icon-button" aria-label="新建对话" onClick={onNewConversation}>
                <Pencil size={14} />
                <span>新建</span>
              </button>
              <button
                className="cc-icon-button"
                aria-label={isPanelExpanded ? '收起对话框' : '放大对话框'}
                onClick={() => setIsPanelExpanded(v => !v)}
              >
                {isPanelExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </div>
          </header>

          {/* 历史视图和聊天视图是互斥业务状态，不能由 presence 保留退出副本。
              两个面板各自保留进入动画，切换时始终只挂载当前事实视图。 */}
          <>
            {isTaskMode ? (
              <m.section key="history" className="cc-task-view" aria-label="历史会话" layout {...buildFadeUpMotion(reducedMotion, 0, 16)}>
                <div className="cc-task-top">
                  <button className="cc-back-button" onClick={() => setTaskView('chat')}>
                    <AppIcon name="arrow_back" size={15} />
                    返回
                  </button>
                  <strong>历史会话</strong>
                  <span>{sessionThreads.length} 个</span>
                </div>
                <input className="cc-task-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话..." />
                <m.div className="cc-task-list" variants={feedVariants} initial="hidden" animate="visible" layout>
                  {filteredTasks.length ? (
                    filteredTasks.map((task) => (
                      <div key={task.id} className="cc-task-row-wrap">
                        <button
                          className={`cc-task-row ${task.id === currentThreadId ? 'cc-task-row--active' : ''}`}
                          onClick={() => {
                            onSelectTask(task.id)
                            setTaskView('chat')
                            setSearch('')
                          }}
                        >
                          <span className="cc-task-row__main">
                            <strong>{formatThreadDisplayTitle(task)}</strong>
                            <small>{task.historyPreview || task.latestUserQuery || '暂无摘要'}</small>
                          </span>
                          <span className="cc-task-row__meta">
                            {formatSessionDate(task.updatedAt)}
                            <small>{task.runCount} 次运行</small>
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
                    <div className="cc-empty">没有匹配的会话</div>
                  )}
                </m.div>
              </m.section>
            ) : (
              <Suspense fallback={<div className="cc-feed cc-feed--loading" aria-hidden="true" />}>
                <ConversationTimeline
                  key={`chat-${currentRunId ?? 'idle'}`}
                  conversation={conversation}
                  activeClarification={activeClarification}
                  clarificationBusy={clarificationBusy}
                  isSubmitting={isSubmitting}
                  errorMessage={errorMessage}
                  errorTitle={errorTitle}
                  dataReferences={dataReferences}
                  uploadedLayerName={uploadedLayerName}
                  runCreatedAt={runCreatedAt}
                  runStatus={runStatus}
                  executionPlan={executionPlan}
                  progressTasks={progressTasks}
                  memories={memories}
                  onRefreshMemories={onRefreshMemories}
                  onApprovePlan={onApprovePlan}
                  onEditPlan={onEditPlan}
                  onSelectArtifact={onSelectArtifact}
                  onResolveApproval={onResolveApproval}
                  onRetry={() => onSubmit(composerMode)}
                  onFocusClarification={focusClarification}
                  feedVariants={feedVariants}
                  entryVariants={entryVariants}
                  reducedMotion={reducedMotion}
                />
              </Suspense>
            )}
          </>

          {showSamples && (
            <m.div className="cc-samples" {...buildFadeUpMotion(reducedMotion, 0.06, 8)}>
              {SAMPLES.map((sample) => (
                <button key={sample} onClick={() => onFillSample(sample)}>
                  {sample}
                </button>
              ))}
            </m.div>
          )}

          <Composer
            query={query}
            providerLabel={providerLabel}
            isSubmitting={isSubmitting}
            composerMode={composerMode}
            modeMenuOpen={modeMenuOpen}
            activeClarification={activeClarification}
            clarificationBusy={clarificationBusy}
            tokenBudget={tokenBudget}
            activeSkills={activeSkills}
            compactionLevel={compactionLevel}
            runStats={runStats}
            denialCounts={denialCounts}
            composerInputRef={composerInputRef}
            firstClarificationOptionRef={firstClarificationOptionRef}
            reducedMotion={reducedMotion}
            onQueryChange={onQueryChange}
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
            onUseTemplate={onUseTemplate}
            onUploadFiles={onUploadFiles}
            onSelectClarification={onSelectClarification}
            onClarificationFreeText={focusComposerForFreeText}
            onModeChange={setComposerMode}
            onModeMenuOpenChange={setModeMenuOpen}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onInputKeyDown={handleKey}
          />
        </m.section>
      </LayoutGroup>

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
