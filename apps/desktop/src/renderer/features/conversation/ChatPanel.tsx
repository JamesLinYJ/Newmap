// +-------------------------------------------------------------------------
//
//   地理智能平台 - 智能对话面板
//
//   文件:       ChatPanel.tsx
//
//   日期:       2026年05月11日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 对话功能的壳组件：持有本地输入、历史会话弹窗和面板展开态。
// 聊天事实源只来自 ConversationItem[]，具体 item 派生和条目渲染交给
// useConversation / ConversationTimeline。

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { MapScreenshotContext, RunAttachmentInput } from '@geo-agent-platform/shared-types'
import { createPortal } from 'react-dom'
import { AnimatePresence, LayoutGroup, m, useReducedMotion } from 'framer-motion'
import { SAMPLES } from '../../shared/constants'
import { buildFadeUpMotion, buildListItemVariants, buildListVariants, motionSpring } from '../../shared/motion'
import { executionModeForComposerMode, runProfileForComposerMode } from './composerModes'
import { Composer } from './Composer'
import { DecisionSheet } from './DecisionSheet'
import { buildRunGoalInput, DEFAULT_GOAL_DRAFT } from './goalDraft'
import type { ChatPanelProps, ComposerMode, GoalComposerDraft, TaskView } from './types'
import {
  errorCardTitle,
  formatSessionDate,
  formatStatusLine,
  pickPendingDecision,
  useConversationEntries,
} from './useConversation'
import { useSpeechRecognition } from './useSpeechRecognition'
import { useDialogState } from './useDialogState'
import { deriveThreadTitleFromText, formatThreadDisplayTitle } from './threadTitles'
import { HistoryPanel } from './HistoryPanel'
import { ChatPanelHeader } from './ChatPanelHeader'
import { GlassDialog, GlassDialogActions } from '../../shared/components/GlassDialog'
import { rectToMotion, surfaceStyleToMotion, usePanelExpansionMotion } from '../../shared/usePanelExpansionMotion'
import { subscribeMapScreenshotAttachment } from '../map/composerAttachmentBridge'

const ConversationTimeline = lazy(() => import('./ConversationTimeline').then(module => ({
  default: module.ConversationTimeline,
})))

export function ChatPanel(props: ChatPanelProps) {
  const {
    artifactCount,
    artifacts,
    currentRunId,
    currentThreadId,
    currentThreadTitle,
    runCreatedAt,
    providerLabel,
    runStatus,
    query,
    isSubmitting,
    conversationReady,
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
    onAttachImage,
    onSelectArtifact,
    onSelectTask,
    onRenameTask,
    onDeleteTask,
    onForkMessage,
    onOpenWorkflow,
    dataReferences,
    trashedThreads = [],
    onLoadTrash,
    onRestoreThread,
    onPurgeThread,
    tokenBudget,
    activeSkills,
    activeMcpServers,
    compactionLevel,
    runStats,
    denialCounts,
    goal,
    agentWorkflow,
    tasks: progressTasks,
  } = props

  const [taskViewState, setTaskViewState] = useState<{ mode: TaskView; bound?: string }>({
    mode: 'chat',
    bound: currentRunId,
  })
  const [search, setSearch] = useState('')
  const { dialog, titleDraft, setTitleDraft, openRename, openDelete, closeDialog, submitRename, submitDelete } = useDialogState()
  const [composing, setComposing] = useState(false)
  const [composerMode, setComposerMode] = useState<ComposerMode>('auto')
  const [goalDraft, setGoalDraft] = useState<GoalComposerDraft>(DEFAULT_GOAL_DRAFT)
  const [goalError, setGoalError] = useState<string | null>(null)
  const [modeDecisionOpen, setModeDecisionOpen] = useState(false)
  const [dismissedDecisionId, setDismissedDecisionId] = useState<string | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [dismissedUploadIds, setDismissedUploadIds] = useState<Set<string>>(() => new Set())
  const [pendingAttachments, setPendingAttachments] = useState<RunAttachmentInput[]>([])
  const [mapAttachmentError, setMapAttachmentError] = useState<string | null>(null)
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
      setPendingAttachments([])
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

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault()
    const canSteerActiveRun = isSubmitting && runStatus === 'running'
    if (
      !conversationReady
      || submittingRef.current
      || (isSubmitting && !canSteerActiveRun)
      || composing
      || !query.trim()
    ) {
      return
    }
    let submittedGoal = null
    try {
      submittedGoal = canSteerActiveRun ? null : buildRunGoalInput(goalDraft, query)
      setGoalError(null)
    } catch (error) {
      setGoalError(error instanceof Error ? error.message : 'Goal 配置无效。')
      return
    }
    submittingRef.current = true
    setModeDecisionOpen(false)
    stopSpeechRecognition()
    try {
      const accepted = await onSubmit(
        executionModeForComposerMode(composerMode),
        runProfileForComposerMode(composerMode),
        submittedGoal,
        pendingAttachments,
      )
      if (accepted) setPendingAttachments([])
    } finally {
      submittingRef.current = false
    }
  }
  const handleAttachImage = async (
    file: Parameters<ChatPanelProps['onAttachImage']>[0],
    kind: RunAttachmentInput['kind'] = 'image',
    mapContext: MapScreenshotContext | null = null,
  ) => {
    const attachment = await onAttachImage(file, kind, mapContext)
    setPendingAttachments(current => (
      current.some(item => item.fileId === attachment.fileId)
        ? current
        : [...current, attachment].slice(-12)
    ))
  }
  useEffect(() => subscribeMapScreenshotAttachment(({ file, context }) => {
    setMapAttachmentError(null)
    return onAttachImage(file, 'map_screenshot', context).then(attachment => {
      setPendingAttachments(current => (
        current.some(item => item.fileId === attachment.fileId)
          ? current
          : [...current, attachment].slice(-12)
      ))
    }).catch(error => {
      setMapAttachmentError(error instanceof Error ? error.message : '地图截图附加失败，请重试。')
      throw error
    })
  }), [onAttachImage])
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
      void handleSubmit()
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
          <ChatPanelHeader
            title={displayCurrentThreadTitle}
            statusLine={formatStatusLine(runStatus, providerLabel, artifactCount, uploadedLayerName)}
            isHistoryView={taskView === 'history'}
            sessionCount={sessionThreads.length}
            isPanelExpanded={isPanelExpanded}
            panelExpansion={panelExpansion}
            onToggleHistory={() => setTaskView(taskView === 'chat' ? 'history' : 'chat')}
            onNewConversation={onNewConversation}
          />

          {/* 历史视图和聊天视图是互斥事实视图，使用 wait 模式保证退出动画结束后
              再挂载下一视图，避免历史列表和当前对话在同一时间线里重叠。 */}
          <AnimatePresence mode="wait" initial={false}>
            {isTaskMode ? (
              <HistoryPanel
                filteredTasks={filteredTasks}
                currentThreadId={currentThreadId}
                trashedThreads={trashedThreads}
                search={search}
                showTrash={showTrash}
                viewMotion={viewMotion}
                feedVariants={feedVariants}
                onBack={() => setTaskView('chat')}
                onSelectTask={(id) => { onSelectTask(id); setTaskView('chat'); setSearch('') }}
                onRename={openRename}
                onDelete={openDelete}
                onRestore={(id) => onRestoreThread?.(id)}
                onPurge={(id) => onPurgeThread?.(id)}
                onSearchChange={setSearch}
                onToggleTrash={(next) => { setShowTrash(next); if (next) onLoadTrash?.() }}
                onLoadTrash={onLoadTrash}
                formatDate={formatSessionDate}
              />
            ) : (
              <m.div key="chat" className="cc-chat-view" layout {...viewMotion}>
                <Suspense fallback={<div className="cc-feed cc-feed--loading" aria-hidden="true" />}>
                  <ConversationTimeline
                    key={`chat-${currentRunId ?? 'idle'}`}
                    conversation={conversation}
                    artifacts={artifacts}
                    activeDecision={activeServerDecision}
                    isSubmitting={isSubmitting}
                    errorMessage={errorMessage}
                    errorTitle={errorTitle}
                    dataReferences={dataReferences}
                    uploadedLayerName={uploadedLayerName}
                    runCreatedAt={runCreatedAt}
                    runStatus={runStatus}
                    agentWorkflow={agentWorkflow}
                    progressTasks={progressTasks}
                    onSelectArtifact={onSelectArtifact}
                    onForkMessage={onForkMessage}
                    onOpenWorkflow={onOpenWorkflow}
                    onRetry={() => onSubmit(
                      executionModeForComposerMode(composerMode),
                      runProfileForComposerMode(composerMode),
                    )}
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
            {!isTaskMode && activeDecision ? (
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

          {!isTaskMode ? (
            <>
            {mapAttachmentError ? (
              <p className="cc-attachment-error" role="alert">{mapAttachmentError}</p>
            ) : null}
            <Composer
              query={query}
              providerLabel={providerLabel}
              isSubmitting={isSubmitting}
              conversationReady={conversationReady}
              canSteerActiveRun={runStatus === 'running'}
              composerMode={composerMode}
              tokenBudget={tokenBudget}
              activeSkills={activeSkills}
              activeMcpServers={activeMcpServers}
              compactionLevel={compactionLevel}
              runStats={runStats}
              denialCounts={denialCounts}
              goal={goal}
              goalDraft={goalDraft}
              goalError={goalError}
              onGoalDraftChange={(updates) => {
                setGoalError(null)
                setGoalDraft(current => ({ ...current, ...updates }))
              }}
              composerInputRef={composerInputRef}
              onQueryChange={onQueryChange}
              onSubmit={handleSubmit}
              onInterrupt={handleInterrupt}
              onUseTemplate={onUseTemplate}
              onUploadFiles={onUploadFiles}
              pendingAttachments={pendingAttachments}
              onAttachPastedImage={handleAttachImage}
              onRemoveAttachment={(fileId) => {
                setPendingAttachments(current => current.filter(item => item.fileId !== fileId))
              }}
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
            </>
          ) : null}
        </m.section>
      </LayoutGroup>
    )
  }

  const inlinePanelNode = renderPanelNode('inline')
  const expandedPanelNode = renderPanelNode('expanded')

  return (
    <>
      {!isPanelExpanded && !panelExpansion.isMorphing ? (
        <div className="cc-wrap">
          {inlinePanelNode}
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
              </div>
            </>
          ) : null}
        </AnimatePresence>,
        document.body,
      ) : null}
      <GlassDialog open={!!dialog} onOpenChange={(open) => { if (!open) closeDialog() }}>
        {dialog?.mode === 'rename' ? (
          <>
            <div>
              <h2>重命名任务</h2>
              <p>给这个任务起个好记的名字。</p>
            </div>
            <input className="input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} autoFocus placeholder="输入新标题" />
            <GlassDialogActions>
              <button className="alert-btn" onClick={closeDialog}>取消</button>
              <button className="alert-btn primary" onClick={() => submitRename(onRenameTask)} disabled={!titleDraft.trim()}>保存</button>
            </GlassDialogActions>
          </>
        ) : dialog?.mode === 'delete' ? (
          <>
            <div>
              <h2>删除任务</h2>
              <p>「{dialog.task.title}」及其运行记录将被移除。</p>
            </div>
            <GlassDialogActions>
              <button className="alert-btn" onClick={closeDialog}>取消</button>
              <button className="alert-btn alert-btn-destructive" onClick={() => submitDelete(onDeleteTask)}>删除</button>
            </GlassDialogActions>
          </>
        ) : null}
      </GlassDialog>
    </>
  )
}
