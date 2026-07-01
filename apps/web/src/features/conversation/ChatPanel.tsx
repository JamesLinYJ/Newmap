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
import { Maximize2, Minimize2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'
import { SAMPLES } from '../../shared/constants'
import { buildFadeMotion, buildFadeUpMotion, buildListItemVariants, buildListVariants, motionSpring } from '../../shared/motion'
import { AppIcon } from '../../shared/components/AppIcon'
import { Composer } from './Composer'
import { DecisionSheet } from './DecisionSheet'
import type { ChatPanelProps, ComposerMode, TaskView } from './types'
import {
  errorCardTitle,
  formatSessionDate,
  formatStatusLine,
  pickPendingDecision,
  useConversationEntries,
} from './useConversation'
import { useSpeechRecognition } from './useSpeechRecognition'
import { deriveThreadTitleFromText, formatThreadDisplayTitle } from './threadTitles'
import { rectToMotion, surfaceStyleToMotion, usePanelExpansionMotion } from '../../shared/usePanelExpansionMotion'

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
    uploadReferences = [],
    decisions = [],
    sessionThreads,
    items,
    availableTools = [],
    onQueryChange,
    onSubmit,
    onInterrupt,
    onNewConversation,
    onFillSample,
    onRespondDecision,
    onUseTemplate,
    onUploadFiles,
    onSelectArtifact,
    onSelectTask,
    onRenameTask,
    onDeleteTask,
    onForkMessage,
    dataReferences,
    trashedThreads = [],
    onLoadTrash,
    onRestoreThread,
    onPurgeThread,
    memories,
    onRefreshMemories,
    tokenBudget,
    activeSkills,
    compactionLevel,
    runStats,
    denialCounts,
    executionPlan,
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
  const [composerMode, setComposerMode] = useState<ComposerMode>('auto')
  const [modeDecisionOpen, setModeDecisionOpen] = useState(false)
  const [dismissedDecisionId, setDismissedDecisionId] = useState<string | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [dismissedUploadIds, setDismissedUploadIds] = useState<Set<string>>(() => new Set())
  const triggerRef = useRef<HTMLElement | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const submittingRef = useRef(false)
  const previousThreadRef = useRef<string | undefined>(currentThreadId)
  const reducedMotion = useReducedMotion() ?? false
  const panelExpansion = usePanelExpansionMotion({ reducedMotion })
  const isPanelExpanded = panelExpansion.isExpanded
  const speech = useSpeechRecognition({
    query,
    inputRef: composerInputRef,
    onQueryChange,
  })
  const stopSpeechRecognition = speech.stopRecognition

  const taskView = taskViewState.bound === currentRunId ? taskViewState.mode : 'chat'
  const setTaskView = (mode: TaskView) => setTaskViewState({ mode, bound: currentRunId })
  const conversation = useConversationEntries(items, runStatus, availableTools)
  const errorTitle = useMemo(() => errorCardTitle(errorMessage), [errorMessage])
  const activeServerDecision = useMemo(() => pickPendingDecision(decisions), [decisions])
  const visibleServerDecision = activeServerDecision && activeServerDecision.decisionId !== dismissedDecisionId
    ? activeServerDecision
    : null
  const activeDecision = visibleServerDecision
  const decisionBusy = isSubmitting
  const feedVariants = buildListVariants(reducedMotion, 0.02, 0.008)
  const entryVariants = buildListItemVariants(reducedMotion, 8)
  const viewTransition = reducedMotion ? { duration: 0 } : motionSpring.gentle
  const viewMotion = reducedMotion
    ? {
        initial: false,
        animate: { opacity: 1 },
        exit: { opacity: 1 },
        transition: viewTransition,
      }
    : {
        initial: { opacity: 0, y: 10, scale: 0.996 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -8, scale: 0.998 },
        transition: viewTransition,
      }
  const isTaskMode = taskView === 'history'
  const showSamples = !isSubmitting && !query.trim() && conversation.length === 0 && !isTaskMode
  const visibleUploadReferences = useMemo(
    () => uploadReferences.filter(item => !dismissedUploadIds.has(item.id)),
    [dismissedUploadIds, uploadReferences],
  )
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
    if (previousThreadRef.current !== currentThreadId) {
      stopSpeechRecognition()
      previousThreadRef.current = currentThreadId
    }
  }, [currentThreadId, stopSpeechRecognition])

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
    setModeDecisionOpen(false)
    stopSpeechRecognition()
    onSubmit(composerMode)
  }
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      if (activeServerDecision) {
        setDismissedDecisionId(null)
        return
      }
      setModeDecisionOpen(true)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing) {
      event.preventDefault()
      handleSubmit()
    }
  }
  const handleInterrupt = () => {
    setModeDecisionOpen(false)
    stopSpeechRecognition()
    onInterrupt?.()
  }
  const handleDecisionSubmit = (decisionId: string, optionId?: string | null, text?: string | null) => {
    onRespondDecision(decisionId, optionId, text)
    setDismissedDecisionId(decisionId)
  }
  const openServerDecision = () => {
    if (activeServerDecision) setDismissedDecisionId(null)
  }
  const expandedPanelMotion = {
    initial: {
      ...rectToMotion(panelExpansion.geometry.origin),
      ...surfaceStyleToMotion(panelExpansion.geometry.originStyle),
      opacity: 1,
    },
    animate: {
      ...rectToMotion(panelExpansion.geometry.target),
      ...surfaceStyleToMotion(panelExpansion.geometry.targetStyle),
      opacity: 1,
    },
    exit: {
      ...rectToMotion(panelExpansion.geometry.origin),
      ...surfaceStyleToMotion(panelExpansion.geometry.originStyle),
      opacity: 1,
    },
    transition: panelExpansion.spring,
    onAnimationComplete: panelExpansion.markSettled,
  }

  const renderPanelNode = (surface: 'inline' | 'expanded') => {
    const expandedSurface = surface === 'expanded'
    return (
      <LayoutGroup id={currentRunId ?? currentThreadId ?? 'home'}>
        <m.section
          ref={expandedSurface ? undefined : panelExpansion.sourceRef}
          className={expandedSurface ? 'cc-panel cc-panel--expanded' : 'cc-panel'}
          layout={!expandedSurface}
          {...(expandedSurface ? expandedPanelMotion : buildFadeUpMotion(reducedMotion, 0, 10))}
        >
          <header className="cc-panel-header">
            <div className="cc-title-block">
              <span>{displayCurrentThreadTitle}</span>
              <small>{formatStatusLine(runStatus, providerLabel, artifactCount, uploadedLayerName)}</small>
            </div>
            <div className="cc-header-actions">
              {sessionThreads.length > 0 && (
                <button
                  className="cc-icon-button"
                  aria-label="历史对话"
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
                disabled={panelExpansion.isMorphing}
                onClick={isPanelExpanded ? panelExpansion.collapse : panelExpansion.expand}
              >
                {isPanelExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </div>
          </header>

          {/* 历史视图和聊天视图是互斥事实视图，使用 wait 模式保证退出动画结束后
              再挂载下一视图，避免历史列表和当前对话在同一时间线里重叠。 */}
          <AnimatePresence mode="wait" initial={false}>
            {isTaskMode ? (
              <m.section key="history" className="cc-task-view" aria-label="历史对话" layout {...viewMotion}>
                <div className="cc-task-top">
                  <button className="cc-back-button" onClick={() => setTaskView('chat')}>
                    <AppIcon name="arrow_back" size={15} />
                    返回
                  </button>
                  <strong>历史对话</strong>
                  <button
                    className="cc-trash-toggle"
                    type="button"
                    onClick={() => {
                      const next = !showTrash
                      setShowTrash(next)
                      if (next) onLoadTrash?.()
                    }}
                  >
                    {showTrash ? '返回会话' : `回收站 ${trashedThreads.length || ''}`}
                  </button>
                </div>
                {!showTrash && <input className="cc-task-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话..." />}
                <m.div className="cc-task-list" variants={feedVariants} initial="hidden" animate="visible" layout>
                  {showTrash ? (
                    trashedThreads.length ? trashedThreads.map(({ thread, deletedAt, purgeAfter }) => (
                      <div key={thread.id} className="cc-task-row-wrap cc-task-row-wrap--trash">
                        <div className="cc-task-row cc-task-row--trash">
                          <span className="cc-task-row__main"><strong>{formatThreadDisplayTitle(thread)}</strong><small>删除于 {formatSessionDate(deletedAt)} · 保留至 {formatSessionDate(purgeAfter)}</small></span>
                        </div>
                        <div className="cc-task-actions">
                          <button aria-label="恢复" onClick={() => onRestoreThread?.(thread.id)}><RefreshCw size={13} /></button>
                          <button aria-label="永久删除" onClick={() => onPurgeThread?.(thread.id)}><Trash2 size={13} /></button>
                        </div>
                      </div>
                    )) : <div className="cc-empty">回收站为空</div>
                  ) : filteredTasks.length ? (
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
              <m.div key="chat" className="cc-chat-view" layout {...viewMotion}>
                <Suspense fallback={<div className="cc-feed cc-feed--loading" aria-hidden="true" />}>
                  <ConversationTimeline
                    key={`chat-${currentRunId ?? 'idle'}`}
                    conversation={conversation}
                    activeDecision={activeServerDecision}
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
                    onSelectArtifact={onSelectArtifact}
                    onForkMessage={onForkMessage}
                    onRetry={() => onSubmit(composerMode)}
                    onFocusDecision={openServerDecision}
                    feedVariants={feedVariants}
                    entryVariants={entryVariants}
                    reducedMotion={reducedMotion}
                  />
                </Suspense>
              </m.div>
            )}
          </AnimatePresence>

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
            {activeDecision ? (
              <DecisionSheet
                key={activeDecision.decisionId}
                decision={activeDecision}
                busy={decisionBusy}
                reducedMotion={reducedMotion}
                onSubmit={handleDecisionSubmit}
                onClose={() => {
                  if (visibleServerDecision) setDismissedDecisionId(visibleServerDecision.decisionId)
                  else setModeDecisionOpen(false)
                }}
              />
            ) : null}
          </AnimatePresence>

          <Composer
            query={query}
            providerLabel={providerLabel}
            isSubmitting={isSubmitting}
            composerMode={composerMode}
            tokenBudget={tokenBudget}
            activeSkills={activeSkills}
            compactionLevel={compactionLevel}
            runStats={runStats}
            denialCounts={denialCounts}
            composerInputRef={composerInputRef}
            onQueryChange={onQueryChange}
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
            onUseTemplate={onUseTemplate}
            onUploadFiles={onUploadFiles}
            uploadReferences={visibleUploadReferences}
            onDismissUploadReference={(id) => {
              setDismissedUploadIds(current => new Set(current).add(id))
            }}
            speechStatus={speech.status}
            speechError={speech.error}
            speechInterimText={speech.interimText}
            speechLanguage={speech.language}
            speechLanguages={speech.languages}
            onSpeechLanguageChange={speech.setLanguage}
            onStartSpeechRecognition={speech.startRecognition}
            onStopSpeechRecognition={stopSpeechRecognition}
            onClearSpeechError={speech.clearSpeechError}
            modeMenuOpen={modeDecisionOpen}
            onModeMenuOpenChange={(open) => {
              if (open && activeServerDecision) {
                setDismissedDecisionId(null)
                return
              }
              setModeDecisionOpen(open)
            }}
            onComposerModeChange={setComposerMode}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onInputKeyDown={handleKey}
          />
        </m.section>
      </LayoutGroup>
    )
  }

  const dialogNode = (
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
  )

  const inlinePanelNode = renderPanelNode('inline')
  const expandedPanelNode = renderPanelNode('expanded')

  return (
    <>
      {!isPanelExpanded && !panelExpansion.isMorphing ? (
        <div className="cc-wrap">
          {inlinePanelNode}
          {dialogNode}
        </div>
      ) : null}
      {panelExpansion.canUsePortal ? createPortal(
        <AnimatePresence initial={false} onExitComplete={panelExpansion.markSettled}>
          {isPanelExpanded ? (
            <>
              <m.div
                key="backdrop"
                className="cc-expand-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={panelExpansion.backdropTransition}
                onClick={panelExpansion.collapse}
              />
              <div
                key="expanded-panel"
                className="cc-wrap cc-wrap--expanded"
                role="dialog"
                aria-modal="true"
                aria-label="对话框全屏视图"
              >
                {expandedPanelNode}
                {dialogNode}
              </div>
            </>
          ) : null}
        </AnimatePresence>,
        document.body,
      ) : null}
    </>
  )
}
