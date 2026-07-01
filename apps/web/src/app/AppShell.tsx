// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 应用壳
//
//   文件:       AppShell.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 负责装配路由、页面容器和六类控制器的 UI 投影。

import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { domAnimation, LazyMotion, m, MotionConfig, useReducedMotion } from 'framer-motion'
import { useLocation } from 'react-router-dom'

import type {
  AgentExecutionMode,
  ConversationItem,
  MemoryFileRecord,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'

import './AppShell.css'
import './styles/glass.css'
import './styles/markdown.css'
import './styles/conversation.css'
import './styles/map.css'
import './styles/layers.css'
import './styles/layout.css'
import './styles/tools-debug.css'
import { pickPreferredArtifactId } from '../features/artifacts/artifactSelection'
import { buildListItemVariants, buildListVariants, motionSpring } from '../shared/motion'
import { pickConversationHeadline } from '../features/conversation/items'
import { ChatPanel } from '../features/conversation/ChatPanel'
import type { MemoryEntry } from '../features/conversation/types'
import { listMemories } from '../api/client'
import { TopBar } from './layout/TopBar'
import { WorkspaceLayout, type WorkspaceSidebarItem } from './layout/WorkspaceLayout'
import { WorkbenchProgressCard } from './layout/WorkbenchProgressCard'
import { AppRoutes } from './routes'
import { supportsAgentSdkLiveSupervisor } from '../shared/providerCapabilities'
import { MapErrorBoundary } from '../features/map/MapErrorBoundary'
import {
  formatUiError,
  reportNonBlockingError,
  retryAsync,
  transcriptEntriesToConversationItems,
} from './bootstrap'
import { projectTimeline } from '../features/conversation/timelineProjector'
import {
  useConnectionController,
  useNavigationController,
  useResourceController,
  useRunController,
  useSessionThreadController,
  useToolingController,
} from './controllers'
import type {
  SidebarItemId,
} from './types'
import {
  buildAgentTodoItems,
  buildDataReferences,
  buildProgressItems,
  formatPanelMode,
  formatPrimaryNav,
  formatModelRunStatus,
  formatTopBarRunStatus,
  mergeThreadRuns,
} from './derivedState'

const DebugPage = lazy(() => import('../features/debug/DebugPage').then((module) => ({ default: module.DebugPage })))
const DetailPanel = lazy(() => import('../features/artifacts/DetailPanel').then((module) => ({ default: module.DetailPanel })))
const loadMapCanvasModule = () => import('../features/map/MapCanvas')
const MapCanvas = lazy(() => loadMapCanvasModule().then((module) => ({ default: module.MapCanvas })))
const ToolManagementPage = lazy(() => import('../features/tools/ToolManagementPage').then((module) => ({ default: module.ToolManagementPage })))

const SIDEBAR_ITEMS: ReadonlyArray<WorkspaceSidebarItem & { id: SidebarItemId }> = [
  { id: 'assistant', icon: 'psychology', label: '智能指令', shortLabel: '助手' },
  { id: 'query', icon: 'explore', label: '空间查询', shortLabel: '查询' },
  { id: 'sources', icon: 'database', label: '数据源', shortLabel: '数据' },
  { id: 'tools', icon: 'build', label: '工具管理', shortLabel: '工具' },
  { id: 'config', icon: 'settings_account_box', label: '模型配置', shortLabel: '模型' },
  { id: 'export', icon: 'ios_share', label: '导出', shortLabel: '导出' },
] as const

function useStableVoid<Args extends unknown[]>(fn: (...args: Args) => Promise<void>): (...args: Args) => void {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])
  return useCallback((...args: Args) => { void ref.current(...args) }, [])
}

function DetailPanelFallback() {
  return (
    <div className="dc-detail-column" aria-label="正在准备结果摘要">
      <section className="dc-card dc-card--summary">
        <div className="dc-card__header">
          <div><div className="dc-card__eyebrow">结果摘要</div><h3>等待分析</h3></div>
        </div>
        <p className="dc-empty-copy">摘要面板正在就绪。</p>
      </section>
    </div>
  )
}

function AppShell() {
  // 主应用壳
  //
  // 装配会话、运行、资源、工具和导航控制器的页面投影。
  // 网络语义和实时订阅分别由控制器与 useRunState 所有。
  const location = useLocation()
  const [isMapActivated, setIsMapActivated] = useState(false)
  const [mapFocusRequest, setMapFocusRequest] = useState<{ artifactId?: string; nonce: number }>()
  const [canonicalThreadItems, setCanonicalThreadItems] = useState<ConversationItem[]>([])

  const {
    run, agentState, intent, executionPlan,
    events, artifacts, isSubmitting, uiError,
    placeResolution,
    clearRun,
    items,
    hydrateRun,
    acceptRun,
    startRun,
    stopSubmitting,
    setError: setUiError,
    cancelRun,
    respondDecision,
    startAnalysis,
    startThreadRun,
  } = useRunController()
  const {
    activeThreadId,
    ensureUploadThread: ensureSessionUploadThread,
    getThread,
    getThreadHistory,
    forkFromMessage,
    hasMoreRunHistory,
    isRunHistoryLoading,
    loadRunHistory,
    loadWorkspaceBootstrap,
    purgeTrashedThread,
    refreshTrash,
    refreshSessionHistory,
    removeThread,
    renameThread,
    restoreTrashedThread,
    session,
    sessionRuns,
    sessionThreads,
    setActiveThreadId,
    setSession,
    setThreadRuns,
    threadRuns,
    trashedThreads,
  } = useSessionThreadController()
  const deferredEvents = useDeferredValue(events)
  const deferredItems = useDeferredValue(items)
  // 当前 run 快照只负责实时变化；完整 thread transcript 由 canonical history 投影补齐。
  const threadConversationItems = useMemo(
    () => projectTimeline(canonicalThreadItems, deferredItems),
    [canonicalThreadItems, deferredItems],
  )
  const reducedMotion = useReducedMotion() ?? false
  const {
    applyProviders,
    changeProvider: handleProviderChange,
    model,
    provider,
    providers,
    setModel,
    setProvider,
  } = useConnectionController()
  const currentThreadId = run?.threadId ?? agentState?.threadId ?? activeThreadId
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const {
    activeNav,
    activeSidebarItem,
    changeWorkspaceMode,
    changePrimaryNav: handleNavChange,
    copyShareLink: handleCopyShareLink,
    focusQueryInput,
    panelMode,
    query,
    readWorkspacePointer,
    selectSample: handleSampleSelect,
    selectSidebarItem: handleSidebarItemClick,
    setActiveNav,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    showSources,
    syncUrl,
    useNextTemplate: handleUseTemplate,
    workspaceMode,
  } = useNavigationController({
    currentThreadId,
    runId: run?.id,
    sessionId: session?.id,
    setUiError,
  })
  const {
    availableTools,
    isToolCatalogSubmitting,
    isToolSubmitting,
    removeCatalogEntry: handleDeleteToolCatalogEntry,
    runtimeConfig,
    runTool,
    saveCatalogEntry: handleUpsertToolCatalogEntry,
    saveRuntimeConfig: handleSaveRuntimeConfig,
    setIsToolSubmitting,
    setToolRunResult,
    systemComponents,
    toolCatalogEntries,
    toolRunResult,
  } = useToolingController({
    loadDiagnostics: location.pathname === '/debug' || panelMode === 'compute' || panelMode === 'config' || panelMode === 'tools',
    setUiError,
  })

  const ensureUploadThread = useCallback(
    () => ensureSessionUploadThread(currentThreadId, syncUrl),
    [currentThreadId, ensureSessionUploadThread, syncUrl],
  )

  const {
    allFiles,
    artifactData,
    artifactMetadata,
    basemaps,
    changeArtifactOpacity: handleArtifactOpacityChange,
    clearArtifacts,
    clearUploads,
    exportLayer: handleExportLayer,
    importLayer: handleImportManagedLayer,
    isFileSubmitting,
    layerManager,
    layers,
    loadBasemaps,
    mapLayers,
    refreshLayers,
    removeFile: handleDeleteAnyFile,
    removeLayer: handleDeleteLayer,
    replaceLayer: handleReplaceManagedLayer,
    selectedArtifactId,
    selectedBasemap,
    selectedBasemapKey,
    setSelectedArtifactId,
    setSelectedBasemapKey,
    toggleArtifactVisibility: handleToggleArtifactVisibility,
    toggleLayerStatus: handleToggleLayerStatus,
    uploadedLayerName,
    uploadFile: handleUploadAnyFile,
    uploadFiles: handleUploadFiles,
    uploadReferences,
  } = useResourceController({
    artifacts,
    currentThreadId,
    ensureUploadThread,
    layerPreferenceKey: `${currentThreadId ?? 'no-thread'}:${run?.id ?? 'no-run'}`,
    onSessionRecord: setSession,
    onShowSources: showSources,
    runStatus: run?.status,
    session,
    setUiError,
  })

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId),
    [artifacts, selectedArtifactId],
  )
  const providerLabel = providers.find((item) => item.provider === provider)?.displayName ?? provider
  const currentThreadTitle = sessionThreads.find((item) => item.id === currentThreadId)?.title
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    executionPlan,
    artifacts,
    events: deferredEvents,
  })
  const transcriptHeadline = useMemo(
    () => pickConversationHeadline(threadConversationItems, run?.status),
    [threadConversationItems, run?.status],
  )

  // 从 compaction.executed 事件中提取压缩级别
  const compactionLevel = useMemo(() => {
    for (const event of deferredEvents) {
      if ((event.type as string) !== 'compaction.executed') continue
      const p = event.payload as Record<string, unknown> | undefined
      const level = String(p?.level ?? p?.compaction_level ?? '')
      if (level) return level
    }
    return null
  }, [deferredEvents])

  // 从事件流中提取 Token 预算（任意事件的 payload 中带 tokens_used 即可）
  const tokenBudget = useMemo(() => {
    for (const event of events) {
      const p = event.payload as Record<string, unknown> | undefined
      if (!p) continue
      const tokensUsed = p.tokens_used ?? (p.usage as Record<string, unknown> | undefined)?.tokens_used
      if (typeof tokensUsed !== 'number') continue
      const rawMax = p.tokens_max ?? p.budget_max ?? (p.usage as Record<string, unknown> | undefined)?.max_tokens ?? 100000
      const max = typeof rawMax === 'number' ? rawMax : Number(rawMax) || 100000
      const budgetStatus = (p.budget_status as string) ?? (tokensUsed > max ? 'exceeded' : tokensUsed > max * 0.9 ? 'critical' : tokensUsed > max * 0.7 ? 'warning' : 'normal')
      return {
        used: tokensUsed,
        max,
        status: budgetStatus as 'normal' | 'warning' | 'critical' | 'exceeded',
      }
    }
    return undefined
  }, [events])

  // 从事件和 agentState 中提取活跃技能
  const activeSkills = useMemo(() => {
    const skills = new Set<string>()
    for (const event of deferredEvents) {
      const p = event.payload as Record<string, unknown> | undefined
      const eventSkills = p?.active_skills ?? p?.skills
      if (Array.isArray(eventSkills)) {
        for (const skill of eventSkills) {
          if (typeof skill === 'string') skills.add(skill)
        }
      }
    }
    const agentSkills = (agentState as Record<string, unknown> | undefined)?.activeSkills
    if (Array.isArray(agentSkills)) {
      for (const skill of agentSkills) {
        if (typeof skill === 'string') skills.add(skill)
      }
    }
    return skills.size > 0 ? [...skills] : undefined
  }, [agentState, deferredEvents])

  // 从 run.completed 事件中提取运行统计
  const runStats = useMemo(() => {
    for (const event of events) {
      if (event.type !== 'run.completed') continue
      const p = event.payload as Record<string, unknown> | undefined
      if (!p) continue
      const attempts = p.tool_attempts ?? p.toolAttempts
      const successes = p.tool_successes ?? p.toolSuccesses
      const failures = p.tool_failures ?? p.toolFailures
      const tokensUsed = p.tokens_used ?? p.tokensUsed ?? p.total_tokens ?? p.totalTokens
      if (
        typeof attempts === 'number' ||
        typeof successes === 'number' ||
        typeof failures === 'number' ||
        typeof tokensUsed === 'number'
      ) {
        return {
          toolAttempts: Number(attempts ?? 0),
          toolSuccesses: Number(successes ?? 0),
          toolFailures: Number(failures ?? 0),
          tokensUsed: Number(tokensUsed ?? 0),
        }
      }
      const stats = p.runtime_stats as Record<string, unknown> | undefined
      if (stats) {
        return {
          toolAttempts: Number(stats.tool_attempts ?? stats.toolAttempts ?? stats.tool_success_count ?? 0) + Number(stats.tool_failure_count ?? 0),
          toolSuccesses: Number(stats.tool_success_count ?? stats.toolSuccesses ?? 0),
          toolFailures: Number(stats.tool_failure_count ?? stats.toolFailures ?? 0),
          tokensUsed: Number(stats.tokens_used ?? stats.tokensUsed ?? 0),
        }
      }
    }
    return undefined
  }, [events])

  // 从 agentState 提取拒绝计数
  const denialCounts = useMemo(() => {
    return (agentState as Record<string, unknown> | undefined)?.denialCounts as Record<string, number> | undefined
  }, [agentState])

  const progressTasks = useMemo(
    () => buildAgentTodoItems(agentState, executionPlan, run?.status),
    [agentState, executionPlan, run?.status],
  )

  const dataReferences = useMemo(
    () => buildDataReferences({ layers, uploadReferences, files: allFiles, artifacts, threadRuns, currentThreadId }),
    [allFiles, artifacts, currentThreadId, layers, threadRuns, uploadReferences],
  )
  const primaryActionLabel = selectedArtifactId ? '发布结果' : '开始分析'
  const workspaceListVariants = buildListVariants(reducedMotion, 0.04, 0.02)
  const workspaceItemVariants = buildListItemVariants(reducedMotion, 16)

  const handleLayerZoomTo = useCallback((artifactId: string) => {
    // 图层管理的定位是一个显式地图动作：先同步选中结果，再发出一次性视角请求。
    setSelectedArtifactId(artifactId)
    setIsMapActivated(true)
    setMapFocusRequest(current => ({ artifactId, nonce: (current?.nonce ?? 0) + 1 }))
  }, [setSelectedArtifactId])

  const clearActiveRunState = useCallback(() => {
    clearRun()
    clearArtifacts()
    setCanonicalThreadItems([])
    startTransition(() => {
      setThreadRuns([])
      setToolRunResult(null)
      setActiveThreadId(undefined)
    })
  }, [clearArtifacts, clearRun, setActiveThreadId, setThreadRuns, setToolRunResult])

  const hydrateRunState = useCallback(
    async (runId: string) => {
      const latestRun = await hydrateRun(runId)

      startTransition(() => {
        setActiveThreadId(latestRun.threadId ?? undefined)
        setProvider(latestRun.modelProvider ?? 'openai_compatible')
        setModel(latestRun.modelName ?? '')
        const preferredArtifactId = pickPreferredArtifactId(latestRun.state.artifacts)
        setSelectedArtifactId(preferredArtifactId)
      })

      startTransition(() => setThreadRuns(current => mergeThreadRuns(current, latestRun)))

      syncUrl(latestRun.sessionId, latestRun.id, latestRun.threadId ?? undefined)

      return latestRun
    },
    [
      hydrateRun,
      setActiveThreadId,
      setModel,
      setProvider,
      setSelectedArtifactId,
      setThreadRuns,
      syncUrl,
    ],
  )

  useEffect(() => {
    // 首屏只吸收一次 workspace bootstrap；thread 摘要足以校验本地指针。
    // 完整运行通过 run:subscribe 一次恢复，不能再展开 thread/run 请求瀑布。
    let disposed = false
    const searchParams = new URLSearchParams(window.location.search)
    const workspacePointer = readWorkspacePointer()
    const sharedSessionId = searchParams.get('session') ?? undefined
    const sharedThreadId = searchParams.get('thread') ?? undefined
    const sharedRunId = searchParams.get('run') ?? undefined
    // localStorage 仅作为 UI 选中提示，不决定会话归属。
    const hintedThreadId = sharedThreadId ?? workspacePointer.activeThreadId
    const hintedRunId = sharedRunId ?? workspacePointer.activeRunId

    void (async () => {
      try {
        const snapshot = await retryAsync(() => loadWorkspaceBootstrap(sharedSessionId), 2, 300)
        if (disposed) return
        applyProviders(snapshot.providers)
        setUiError(undefined)

        const sessionRecord = snapshot.session
        const threadToRestore = hintedThreadId || undefined
        const runToRestore = hintedRunId || undefined
        const thread = threadToRestore
          ? snapshot.threads.find(item => item.id === threadToRestore)
          : undefined

        if (threadToRestore && !thread) {
          if (sharedThreadId) throw new Error('分享链接中的对话不属于当前会话。')
          clearActiveRunState()
          syncUrl(sessionRecord.id)
          return
        }

        if (thread) startTransition(() => setActiveThreadId(thread.id))
        const preferredRunId = runToRestore ?? thread?.latestRunId ?? undefined
        if (!preferredRunId) {
          syncUrl(sessionRecord.id, undefined, thread?.id)
          return
        }

        try {
          const restoredRun = await hydrateRunState(preferredRunId)
          if (disposed) return
          const wrongSession = restoredRun.sessionId !== sessionRecord.id
          const wrongThread = Boolean(thread && restoredRun.threadId !== thread.id)
          if (wrongSession || wrongThread) throw new Error('运行记录不属于当前会话或对话。')
          if (restoredRun.threadId) {
            const history = await getThreadHistory(restoredRun.threadId, null, 200)
            if (disposed) return
            setCanonicalThreadItems(transcriptEntriesToConversationItems(history.entries))
          }
        } catch (error) {
          if (sharedRunId || sharedThreadId) throw error
          clearActiveRunState()
          syncUrl(sessionRecord.id)
        }
      } catch (error) {
        if (!disposed) setUiError(formatUiError(error, '页面加载遇到问题，请刷新重试。'))
      }
    })()

    return () => { disposed = true }
  }, [
    applyProviders,
    clearActiveRunState,
    hydrateRunState,
    getThreadHistory,
    loadWorkspaceBootstrap,
    readWorkspacePointer,
    setActiveThreadId,
    setUiError,
    syncUrl,
  ])

  useEffect(() => {
    if (!session?.id) return
    if (location.pathname !== '/debug' && panelMode !== 'history') return
    void loadRunHistory(session.id).catch(error => {
      setUiError(formatUiError(error, '运行历史加载失败。'))
    })
  }, [loadRunHistory, location.pathname, panelMode, session?.id, setUiError])

  const activateMap = useCallback(() => {
    startTransition(() => setIsMapActivated(true))
  }, [])

  const preloadMap = useCallback(() => {
    void loadMapCanvasModule().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (location.pathname !== '/' || isMapActivated) return
    let firstFrame = 0
    let secondFrame = 0
    let idleHandle: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if ('requestIdleCallback' in window) {
          idleHandle = window.requestIdleCallback(activateMap, { timeout: 1200 })
        } else {
          timer = setTimeout(activateMap, 32)
        }
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      if (idleHandle !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle)
      if (timer) clearTimeout(timer)
    }
  }, [activateMap, isMapActivated, location.pathname])

  const panelNeedsWorkspaceResources = panelMode === 'layers' || panelMode === 'sources' || panelMode === 'layerManager'
  const shouldLoadWorkspaceResources = isMapActivated || panelNeedsWorkspaceResources || location.pathname === '/debug'

  useEffect(() => {
    if (!session?.id || !shouldLoadWorkspaceResources) return
    void Promise.allSettled([
      loadBasemaps(),
      refreshLayers(session.id, currentThreadId),
    ]).then(results => {
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') reportNonBlockingError('workspaceResources', rejected.reason)
    })
  }, [currentThreadId, loadBasemaps, refreshLayers, session?.id, shouldLoadWorkspaceResources])

  const submitMessage = useCallback(
    async ({
      text,
      forceNewThread = false,
      executionMode = 'auto',
    }: {
      text?: string
      forceNewThread?: boolean
      executionMode?: AgentExecutionMode
    } = {}) => {
      // 连续对话提交入口
      //
      // 同一聊天面板里的普通输入默认复用当前 thread；
      // 只有显式新建对话或当前没有 thread 时，才让后端创建新 thread。
      if (!session) {
        return
      }
      const submittedQuery = (text ?? query).trim()
      if (!submittedQuery) {
        return
      }

      const targetThreadId = forceNewThread ? undefined : currentThreadId

      try {
        const selectedProvider = providers.find((item) => item.provider === provider)
        if (selectedProvider && !selectedProvider.configured) {
          setUiError(`${selectedProvider.displayName} 还没配置好，暂时没法提交分析。`)
          return
        }
        if (selectedProvider && !supportsAgentSdkLiveSupervisor(selectedProvider)) {
          setUiError(`${selectedProvider.displayName} 当前不是 Agent SDK 主路径，不能提交分析。`)
          return
        }
        setUiError(undefined)
        // 提交被前端接受后立即清空编辑态，行为与常见 Agent 对话一致。
        // 请求失败只显示错误状态，不把旧文本重新塞回用户编辑态。
        setQuery('')
        startRun()
        setActiveNav('analysis')
        setPanelMode('summary')
        setActiveSidebarItem('assistant')
        if (forceNewThread) {
          clearArtifacts()
          setToolRunResult(null)
          setCanonicalThreadItems([])
        } else if (targetThreadId) {
          // 新 run 的首个 snapshot 会替换当前 run items，先把已完成协议项固化到 thread 投影。
          setCanonicalThreadItems(current => projectTimeline(
            current,
            items.filter(item => item.status !== 'running' && [
              'message', 'function_call', 'function_call_output',
            ].includes(item.itemType)),
          ))
        }

        const createdRun = targetThreadId
          ? await startThreadRun(targetThreadId, submittedQuery, provider, model || undefined, executionMode)
          : await startAnalysis(session.id, submittedQuery, provider, model || undefined, executionMode)
        const nextThreadId = createdRun.threadId ?? targetThreadId
        startTransition(() => {
          acceptRun(createdRun)
          setProvider(createdRun.modelProvider ?? provider)
          setModel(createdRun.modelName ?? model)
          setActiveThreadId(nextThreadId)
          setThreadRuns((current) => (nextThreadId && !forceNewThread ? mergeThreadRuns(current, createdRun) : [createdRun]))
        })
        void refreshSessionHistory(session.id).catch((error) => reportNonBlockingError('refreshSessionHistory:submitMessage', error))
        syncUrl(session.id, createdRun.id, nextThreadId)
      } catch (error) {
        setUiError(formatUiError(error, '任务提交失败，请重试。'))
        stopSubmitting()
      }
    },
    [
      acceptRun,
      clearArtifacts,
      currentThreadId,
      model,
      provider,
      providers,
      query,
      items,
      refreshSessionHistory,
      session,
      setActiveNav,
      setActiveThreadId,
      setActiveSidebarItem,
      setModel,
      setPanelMode,
      setProvider,
      setQuery,
      setCanonicalThreadItems,
      setToolRunResult,
      setThreadRuns,
      setUiError,
      startAnalysis,
      startRun,
      startThreadRun,
      stopSubmitting,
      syncUrl,
    ],
  )

  const handleSubmit = useCallback(async (executionMode: AgentExecutionMode = 'auto') => {
    if (!query.trim()) {
      return
    }
    await submitMessage({ executionMode })
  }, [query, submitMessage])

  const handleInterruptRun = useCallback(async () => {
    if (!run?.id) {
      stopSubmitting()
      return
    }
    try {
      setUiError(undefined)
      const cancelledRun = await cancelRun(run.id)
      startTransition(() => {
        acceptRun(cancelledRun)
      })
      if (cancelledRun.sessionId) {
        void refreshSessionHistory(cancelledRun.sessionId).catch((error) => reportNonBlockingError('refreshSessionHistory:cancelRun', error))
      }
    } catch (error) {
      setUiError(formatUiError(error, '中断运行失败，请稍后再试。'))
    } finally {
      stopSubmitting()
    }
  }, [acceptRun, cancelRun, refreshSessionHistory, run?.id, setUiError, stopSubmitting])

  const handleRespondDecision = useCallback(
    async (decisionId: string, optionId?: string | null, text?: string | null) => {
      if (!run?.id) return
      try {
        setUiError(undefined)
        startRun()
        const nextRun = await respondDecision(run.id, decisionId, optionId, text)
        const nextThreadId = nextRun.threadId ?? currentThreadId
        startTransition(() => {
          acceptRun(nextRun)
          setProvider(nextRun.modelProvider ?? provider)
          setModel(nextRun.modelName ?? model)
          setActiveThreadId(nextThreadId)
          setThreadRuns((current) => (nextThreadId ? mergeThreadRuns(current, nextRun) : current))
        })
        if (nextRun.sessionId) {
          void refreshSessionHistory(nextRun.sessionId).catch((error) => reportNonBlockingError('refreshSessionHistory:respondDecision', error))
        }
        syncUrl(nextRun.sessionId, nextRun.id, nextThreadId)
        await hydrateRunState(nextRun.id)
      } catch (error) {
        setUiError(formatUiError(error, '决策提交失败，请重试。'))
        stopSubmitting()
      }
    },
    [
      acceptRun,
      currentThreadId,
      hydrateRunState,
      model,
      provider,
      refreshSessionHistory,
      respondDecision,
      run?.id,
      setActiveThreadId,
      setModel,
      setProvider,
      setThreadRuns,
      setUiError,
      startRun,
      stopSubmitting,
      syncUrl,
    ],
  )

  const handleNewConversation = useCallback(() => {
    // 显式新建对话只重置前端 active thread，不提前创建数据库记录。
    //
    // 下一次发送消息时因为没有 activeThreadId，会自然走 startAnalysis 创建新 thread。
    // 同时清理上一轮的上传数据显示，保证新 thread 看到干净的工作区。
    startTransition(() => {
      setQuery('')
      clearActiveRunState()
      clearUploads()
      setThreadRuns([])
      setCanonicalThreadItems([])
      setActiveThreadId(undefined)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
    })
    if (session?.id) {
      syncUrl(session.id)
    }
    focusQueryInput()
  }, [
    clearActiveRunState,
    clearUploads,
    focusQueryInput,
    session?.id,
    setActiveNav,
    setActiveThreadId,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    setThreadRuns,
    syncUrl,
  ])

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      // 主聊天面板按 thread 打开 canonical transcript；当前 run 项由订阅层另行合并。
      try {
        setUiError(undefined)
        const [threadPayload, historyPage] = await Promise.all([
          getThread(threadId),
          getThreadHistory(threadId, null, 200),
        ])
        const canonicalItems = transcriptEntriesToConversationItems(historyPage.entries)
        const runs = threadPayload.runs ?? []
        startTransition(() => {
          setActiveThreadId(threadPayload.thread.id)
          setThreadRuns(runs)
        })
        if (threadPayload.latestRun?.id) {
          await hydrateRunState(threadPayload.latestRun.id)
          setCanonicalThreadItems(canonicalItems)
          if (session?.id) {
            syncUrl(session.id, threadPayload.latestRun.id, threadPayload.thread.id)
          }
          return
        }

        startTransition(() => {
          clearActiveRunState()
          setThreadRuns(runs)
          setActiveThreadId(threadPayload.thread.id)
        })
        setCanonicalThreadItems(canonicalItems)
        if (session?.id) {
          syncUrl(session.id, undefined, threadPayload.thread.id)
        }
      } catch (error) {
        setUiError(formatUiError(error, '历史记录加载失败，请稍后重试。'))
      }
    },
    [clearActiveRunState, getThread, getThreadHistory, hydrateRunState, session?.id, setActiveThreadId, setThreadRuns, setUiError, syncUrl],
  )

  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      const nextTitle = title.trim()
      if (!nextTitle) {
        setUiError('任务标题不能为空。')
        return
      }

      try {
        setUiError(undefined)
        await renameThread(threadId, nextTitle)
      } catch (error) {
        setUiError(formatUiError(error, '标题更新失败，请再试一次。'))
      }
    },
    [renameThread, setUiError],
  )

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      if (!session?.id) {
        return
      }

      try {
        setUiError(undefined)
        await removeThread(threadId)

        if (currentThreadId === threadId) {
          clearActiveRunState()
          syncUrl(session.id)
        }
      } catch (error) {
        setUiError(formatUiError(error, '任务删除失败，请再试一次。'))
      }
    },
    [clearActiveRunState, currentThreadId, removeThread, session?.id, setUiError, syncUrl],
  )

  const refreshMemoryEntries = useCallback(async () => {
    const response = await listMemories()
    startTransition(() => {
      setMemoryEntries(response.records.map(memoryRecordToEntry))
    })
    return response
  }, [])

  useEffect(() => {
    if (runtimeConfig?.context.memoryEnabled === false) {
      setMemoryEntries([])
      return
    }
    void refreshMemoryEntries().catch((error) => reportNonBlockingError('refreshMemoryEntries', error))
  }, [refreshMemoryEntries, runtimeConfig?.context.memoryEnabled])

  const handleRefreshMemories = useCallback(async () => {
    try {
      setUiError(undefined)
      await refreshMemoryEntries()
    } catch (error) {
      setUiError(formatUiError(error, '记忆索引刷新失败。'))
    }
  }, [refreshMemoryEntries, setUiError])

  const handleForkMessage = useCallback(async (entryId: string) => {
    if (!currentThreadId || !session?.id) return
    try {
      setUiError(undefined)
      const forked = await forkFromMessage(currentThreadId, entryId)
      const history = await getThreadHistory(forked.id, null, 200)
      clearActiveRunState()
      startTransition(() => {
        setActiveThreadId(forked.id)
        setThreadRuns([])
      })
      setCanonicalThreadItems(transcriptEntriesToConversationItems(history.entries))
      syncUrl(session.id, undefined, forked.id)
    } catch (error) {
      setUiError(formatUiError(error, '消息分支创建失败。'))
    }
  }, [clearActiveRunState, currentThreadId, forkFromMessage, getThreadHistory, session?.id, setActiveThreadId, setThreadRuns, setUiError, syncUrl])

  const handleRestoreThread = useCallback(async (threadId: string) => {
    try {
      await restoreTrashedThread(threadId)
    } catch (error) {
      setUiError(formatUiError(error, '线程恢复失败。'))
    }
  }, [restoreTrashedThread, setUiError])

  const handlePurgeThread = useCallback(async (threadId: string) => {
    try {
      await purgeTrashedThread(threadId)
    } catch (error) {
      setUiError(formatUiError(error, '线程永久删除失败。'))
    }
  }, [purgeTrashedThread, setUiError])

  // 稳定化 ChatPanel 回调引用，避免每次渲染重建导致子树无效重渲染
  const onSubmitStable = useStableVoid(handleSubmit)
  const onRespondDecisionStable = useStableVoid(handleRespondDecision)
  const onSelectTaskStable = useStableVoid(handleSelectThread)
  const onRenameTaskStable = useStableVoid(handleRenameThread)
  const onDeleteTaskStable = useStableVoid(handleDeleteThread)
  const onForkMessageStable = useStableVoid(handleForkMessage)
  const onRefreshMemoriesStable = useStableVoid(handleRefreshMemories)
  const handleRefreshTrash = useCallback(async () => { await refreshTrash() }, [refreshTrash])
  const onRefreshTrashStable = useStableVoid(handleRefreshTrash)
  const onRestoreThreadStable = useStableVoid(handleRestoreThread)
  const onPurgeThreadStable = useStableVoid(handlePurgeThread)
  const handleLoadMoreHistory = useCallback(() => {
    if (!session?.id || !hasMoreRunHistory || isRunHistoryLoading) return
    void loadRunHistory(session.id, true).catch(error => {
      setUiError(formatUiError(error, '更多运行历史加载失败。'))
    })
  }, [hasMoreRunHistory, isRunHistoryLoading, loadRunHistory, session?.id, setUiError])

  const handleRunTool = useCallback(
    async (tool: ToolDescriptor, args: Record<string, unknown>) => {
      // 调试页工具工作台统一入口
      //
      // 工具执行统一调度，再把返回的 run 重新 hydrate 到主状态树。
      if (!session?.id) {
        return
      }

      try {
        setUiError(undefined)
        setIsToolSubmitting(true)
        const result = await runTool({
          sessionId: session.id,
          threadId: currentThreadId,
          runId: run?.id,
          toolName: tool.name,
          toolKind: tool.toolKind,
          args,
        })
        setToolRunResult(result)
        const nextRunId = typeof result.run === 'object' && result.run && 'id' in result.run ? String(result.run.id) : run?.id
        if (nextRunId) {
          await hydrateRunState(nextRunId)
          if (session.id) {
            syncUrl(session.id, nextRunId, currentThreadId)
          }
        }
      } catch (error) {
        setUiError(formatUiError(error, `${tool.label} 执行失败。`))
      } finally {
        setIsToolSubmitting(false)
      }
    },
    [currentThreadId, hydrateRunState, run?.id, runTool, session?.id, setIsToolSubmitting, setToolRunResult, setUiError, syncUrl],
  )

  return (
    <Suspense fallback={<div className="dc-route-loading">正在加载页面…</div>}>
      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">
          <AppRoutes
            workspace={
              <WorkspaceLayout
                topBar={
                  <TopBar
                    activeNav={activeNav}
                    artifactCount={artifacts.length}
                    providerLabel={providerLabel}
                    runStatusLabel={formatTopBarRunStatus(run?.status)}
                    onNavChange={handleNavChange}
                    onPrimaryAction={async () => {
                      if (selectedArtifactId) {
                        setPanelMode('export')
                        return
                      }
                      if (query.trim()) {
                        await handleSubmit()
                        return
                      }
                      focusQueryInput()
                    }}
                    primaryActionLabel={primaryActionLabel}
                  />
                }
                sidebarItems={SIDEBAR_ITEMS}
                activeSidebarItem={activeSidebarItem}
                onSidebarItemClick={(itemId) => handleSidebarItemClick(itemId as SidebarItemId)}
                runStatusLabel={formatTopBarRunStatus(run?.status)}
                hasActiveRun={Boolean(run?.id)}
                dataReferenceCount={dataReferences.length}
                selectedBasemapName={selectedBasemap.name}
                uploadedLayerName={uploadedLayerName}
                activeNavLabel={formatPrimaryNav(activeNav)}
                panelModeLabel={formatPanelMode(panelMode)}
                providerLabel={providerLabel}
                modelLabel={model || '默认'}
                modelStatusLabel={formatModelRunStatus(run?.status)}
                artifactCount={artifacts.length}
                selectedArtifactName={selectedArtifact?.name}
                transcriptTitle={transcriptHeadline.title}
                transcriptBody={transcriptHeadline.body}
                reducedMotion={reducedMotion}
                workspaceListVariants={workspaceListVariants}
                workspaceItemVariants={workspaceItemVariants}
                currentThreadId={currentThreadId}
                sessionThreads={sessionThreads}
                onNewTask={handleNewConversation}
                onSelectThread={onSelectTaskStable}
                workspaceMode={workspaceMode}
                onWorkspaceModeChange={changeWorkspaceMode}
                toolsMode={activeNav === 'tools'}
                toolsSlot={
                  <div className="tool-management-host min-w-0">
                    <ToolManagementPage
                      tools={availableTools}
                      artifacts={artifacts}
                      layers={layers}
                      valueRefs={agentState?.toolValueRefs ?? []}
                      toolRunResult={toolRunResult}
                      toolCatalogEntries={toolCatalogEntries}
                      systemComponents={systemComponents}
                      isToolSubmitting={isToolSubmitting}
                      isToolCatalogSubmitting={isToolCatalogSubmitting}
                      onRunTool={(tool, args) => {
                        void handleRunTool(tool, args)
                      }}
                      onUpsertToolCatalogEntry={(tool, payload, sortOrder) => {
                        void handleUpsertToolCatalogEntry(tool, payload, sortOrder)
                      }}
                      onDeleteToolCatalogEntry={(tool) => {
                        void handleDeleteToolCatalogEntry(tool)
                      }}
                    />
                  </div>
                }
                mainSlot={
                  <ChatPanel
                    artifactCount={artifacts.length}
                    runStatus={run?.status}
                    providerLabel={providerLabel}
                    query={query}
                    currentRunId={run?.id}
                    currentThreadId={currentThreadId}
                    currentThreadTitle={currentThreadTitle}
                    runCreatedAt={run?.createdAt}
                    isSubmitting={isSubmitting}
                    errorMessage={uiError}
                    uploadedLayerName={uploadedLayerName}
                    uploadReferences={uploadReferences}
                    decisions={agentState?.decisions ?? []}
                    sessionThreads={sessionThreads}
                    items={threadConversationItems}
                    runtimeConfig={runtimeConfig}
                    availableTools={availableTools}
                    onQueryChange={setQuery}
                    onSubmit={onSubmitStable}
                    onInterrupt={handleInterruptRun}
                    onNewConversation={handleNewConversation}
                    onFillSample={handleSampleSelect}
                    onRespondDecision={onRespondDecisionStable}
                    onUseTemplate={handleUseTemplate}
                    onUploadFiles={(files) => {
                      void handleUploadFiles(files)
                    }}
                    onSelectArtifact={setSelectedArtifactId}
                    onSelectTask={onSelectTaskStable}
                    onRenameTask={onRenameTaskStable}
                    onDeleteTask={onDeleteTaskStable}
                    onForkMessage={onForkMessageStable}
                    dataReferences={dataReferences}
                    trashedThreads={trashedThreads}
                    onLoadTrash={onRefreshTrashStable}
                    onRestoreThread={onRestoreThreadStable}
                    onPurgeThread={onPurgeThreadStable}
                    memories={memoryEntries}
                    onRefreshMemories={onRefreshMemoriesStable}
                    tokenBudget={tokenBudget}
                    activeSkills={activeSkills}
                    compactionLevel={compactionLevel}
                    runStats={runStats}
                    denialCounts={denialCounts}
                    executionPlan={executionPlan}
                    tasks={progressTasks}
                  />
                }
                mapSlot={
                  <m.section
                    className="workbench-map-shell"
                    aria-label="空间地图"
                    layout
                    transition={motionSpring.gentle}
                    onPointerEnter={preloadMap}
                  >
                    <div className="workbench-map-shell__head">
                      <strong>地图与图层</strong>
                      <button type="button" className="workbench-inspector-link" onClick={() => setPanelMode('layerManager')}>图层管理</button>
                    </div>
                    <div className="workbench-map-shell__body">
                      {isMapActivated ? (
                        <MapErrorBoundary>
                          <Suspense fallback={<div className="dc-map-stage dc-map-stage--loading">正在初始化地图…</div>}>
                            <MapCanvas
                              artifactCount={artifacts.length}
                              basemaps={basemaps}
                              runStatus={run?.status}
                              selectedBasemapKey={selectedBasemapKey}
                              onSelectBasemap={setSelectedBasemapKey}
                              layers={mapLayers}
                              selectedArtifactId={selectedArtifactId}
                              selectedArtifactName={selectedArtifact?.name}
                              focusRequest={mapFocusRequest}
                              onSelectArtifact={setSelectedArtifactId}
                              placeResolution={placeResolution}
                              agentState={agentState}
                            />
                          </Suspense>
                        </MapErrorBoundary>
                      ) : (
                        <button
                          type="button"
                          className="dc-map-stage dc-map-stage--loading dc-map-activation"
                          onClick={activateMap}
                          onFocus={preloadMap}
                        >
                          <strong>空间地图</strong>
                          <span>点击打开地图检查器</span>
                        </button>
                      )}
                    </div>
                  </m.section>
                }
                inspectorSlot={
                  <>
                    <m.div layout transition={motionSpring.gentle}>
                      <WorkbenchProgressCard
                        runStatus={run?.status}
                        progressItems={progressItems}
                        tasks={progressTasks}
                        events={deferredEvents}
                        onOpenHistory={() => setPanelMode('history')}
                      />
                    </m.div>
                    <m.div className="workbench-inspector-detail" layout transition={motionSpring.gentle}>
                      <Suspense fallback={<DetailPanelFallback />}>
                        <m.div layout transition={motionSpring.gentle}>
                          <DetailPanel
                            panelMode={panelMode}
                            currentRunId={run?.id}
                            runStatus={run?.status}
                            agentState={agentState}
                            items={deferredItems}
                            artifacts={artifacts}
                            artifactData={artifactData}
                            mapLayers={mapLayers}
                            layers={layers}
                            events={deferredEvents}
                            sessionRuns={sessionRuns}
                            hasMoreHistory={hasMoreRunHistory}
                            isHistoryLoading={isRunHistoryLoading}
                            progressItems={progressItems}
                            selectedArtifactId={selectedArtifactId}
                            uploadedLayerName={uploadedLayerName}
                            selectedBasemapName={selectedBasemap.name}
                            provider={provider}
                            model={model}
                            providers={providers}
                            systemComponents={systemComponents}
                            isToolSubmitting={isToolSubmitting}
                            onSelectArtifact={setSelectedArtifactId}
                            onToggleArtifactVisibility={handleToggleArtifactVisibility}
                            onChangeArtifactOpacity={handleArtifactOpacityChange}
                            onSelectHistoryRun={(runId) => {
                              void hydrateRunState(runId)
                              setPanelMode('history')
                              setActiveNav('history')
                            }}
                            onLoadMoreHistory={handleLoadMoreHistory}
                            onCopyShareLink={() => {
                              void handleCopyShareLink()
                            }}
                            onProviderChange={handleProviderChange}
                            onModelChange={setModel}
                            onImportManagedLayer={(file) => {
                              void handleImportManagedLayer(file)
                            }}
                            onReplaceManagedLayer={(layerKey, file) => {
                              void handleReplaceManagedLayer(layerKey, file)
                            }}
                            onToggleLayerStatus={(layerKey, nextStatus) => {
                              void handleToggleLayerStatus(layerKey, nextStatus)
                            }}
                            onDeleteLayer={(layerKey) => {
                              void handleDeleteLayer(layerKey)
                            }}
                            onRefreshManagedLayers={() => {
                              void refreshLayers(session?.id, currentThreadId)
                            }}
                            onCloseLayerManager={() => setPanelMode('summary')}
                            layerTree={layerManager.tree}
                            layerSelectedId={layerManager.selectedId}
                            layerSearchQuery={layerManager.searchQuery}
                            layerTotalCount={layerManager.totalCount}
                            layerVisibleCount={layerManager.visibleCount}
                            layerSelectedNode={layerManager.selectedNode}
                            layerActiveView={layerManager.activeView}
                            layerVisibilityFilter={layerManager.visibilityFilter}
                            onLayerSelect={layerManager.selectLayer}
                            onLayerToggleVisibility={layerManager.toggleVisibility}
                            onLayerToggleAllVisibility={layerManager.toggleAllVisibility}
                            onLayerSetOpacity={layerManager.setOpacity}
                            onLayerSetColor={layerManager.setColor}
                            onLayerRename={layerManager.renameLayer}
                            onLayerMoveUp={layerManager.moveUp}
                            onLayerMoveDown={layerManager.moveDown}
                            onLayerRemove={layerManager.removeLayer}
                            onLayerCreateGroup={layerManager.createGroup}
                            onLayerToggleGroup={layerManager.toggleGroup}
                            onLayerSetSearchQuery={layerManager.setSearchQuery}
                            onLayerZoomTo={handleLayerZoomTo}
                            onLayerExport={handleExportLayer}
                            onLayerSetActiveView={layerManager.setActiveView}
                            onLayerSetVisibilityFilter={layerManager.setVisibilityFilter}
                            onLayerSetLabelEnabled={layerManager.setLabelEnabled}
                            onLayerSetLabelField={layerManager.setLabelField}
                            allFiles={allFiles}
                            onUploadFile={(file) => { void handleUploadAnyFile(file) }}
                            onDeleteFile={(fileId) => { void handleDeleteAnyFile(fileId) }}
                            isFileSubmitting={isFileSubmitting}
                          />
                        </m.div>
                      </Suspense>
                    </m.div>
                  </>
                }
              />
            }
            debug={
              <DebugPage
                query={query}
                isSubmitting={isSubmitting}
                isToolSubmitting={isToolSubmitting}
                uploadedLayerName={uploadedLayerName}
                errorMessage={uiError}
                runStatus={run?.status}
                currentRunId={run?.id}
                currentSessionId={session?.id}
                provider={provider}
                model={model}
                providers={providers}
                currentRun={run}
                sessionRuns={sessionRuns}
                layers={layers}
                events={deferredEvents}
                items={deferredItems}
                intent={intent}
                executionPlan={executionPlan}
                agentState={agentState}
                artifacts={artifacts}
                artifactMetadata={artifactMetadata}
                selectedArtifactId={selectedArtifactId}
                toolRunResult={toolRunResult}
                toolCatalogEntries={toolCatalogEntries}
                runtimeConfig={runtimeConfig}
                systemComponents={systemComponents}
                tools={availableTools}
                isToolCatalogSubmitting={isToolCatalogSubmitting}
                onQueryChange={setQuery}
                onProviderChange={handleProviderChange}
                onModelChange={setModel}
                onSubmit={() => {
                  void handleSubmit()
                }}
                onUpload={(file) => {
                  void handleUploadFiles([file])
                }}
                onSelectArtifact={setSelectedArtifactId}
                onRunTool={(tool, args) => {
                  void handleRunTool(tool, args)
                }}
                onUpsertToolCatalogEntry={(tool, payload, sortOrder) => {
                  void handleUpsertToolCatalogEntry(tool, payload, sortOrder)
                }}
                onDeleteToolCatalogEntry={(tool) => {
                  void handleDeleteToolCatalogEntry(tool)
                }}
                onSaveRuntimeConfig={(nextConfig) => {
                  void handleSaveRuntimeConfig(nextConfig)
                }}
              />
            }
          />
        </MotionConfig>
      </LazyMotion>
    </Suspense>
  )
}

function memoryRecordToEntry(record: MemoryFileRecord): MemoryEntry {
  const updatedAt = Number.isFinite(record.mtimeMs) ? record.mtimeMs : Date.now()
  return {
    scope: record.scope === 'team' ? 'team' : 'private',
    relativePath: record.relativePath,
    name: record.name || record.relativePath,
    description: record.description || record.relativePath,
    type: record.type ?? 'project',
    age: formatRelativeAge(updatedAt),
  }
}

function formatRelativeAge(mtimeMs: number): string {
  const delta = Math.max(0, Date.now() - mtimeMs)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return new Date(mtimeMs).toLocaleDateString('zh-CN')
}

export default AppShell
