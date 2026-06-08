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
// 负责前端全局状态编排、API 调用、事件订阅、地图与 REPL 面板联动。

import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_BASEMAP, SAMPLES } from '../shared/constants'
import { domAnimation, LazyMotion, m, MotionConfig, useReducedMotion } from 'framer-motion'
import { useLocation } from 'react-router-dom'

import type {
  AgentRuntimeConfig,
  AnalysisRun,
  AgentThreadRecord,
  ArtifactRef,
  BasemapDescriptor,
  LayerDescriptor,
  ModelProviderDescriptor,
  SessionRecord,
  SystemComponentsStatus,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'

import {
  type AgentExecutionMode,
  cancelRun,
  createThread,
  deleteLayer,
  deleteThread,
  deleteToolCatalogEntry,
  getArtifactGeoJson,
  getArtifactMetadata,
  getDefaultSession,
  getRuntimeConfig,
  getRun,
  getSession,
  getSystemComponents,
  getThread,
  importManagedLayer,
  listBasemaps,
  listLayers,
  listProviders,
  listSessionThreads,
  listTools,
  listToolCatalogEntries,
  listSessionRuns,
  replaceManagedLayer,
  resolveApproval,
  runTool,
  startAnalysis,
  startThreadRun,
  updateLayer,
  updateThread,
  upsertToolCatalogEntry,
  updateRuntimeConfig,
  uploadLayer,
  uploadAnyFile,
  listAllFiles,
  deleteAnyFile,
  apiBaseUrl,
} from '../api/client'
import type { FileEntry } from '../api/client'
import './AppShell.css'
import { pickPreferredArtifactId } from '../features/artifacts/artifactSelection'
import { buildListItemVariants, buildListVariants, motionSpring } from '../shared/motion'
import { pickConversationHeadline } from '../features/conversation/items'
import { useRunState } from '../features/runs/useRunState'
import { useLayerManager } from '../features/layers/useLayerManager'
import { ChatPanel } from '../features/conversation/ChatPanel'
import { DetailPanel } from '../features/artifacts/DetailPanel'
import { TopBar } from './layout/TopBar'
import { WorkspaceLayout, type WorkspaceSidebarItem } from './layout/WorkspaceLayout'
import { AppRoutes } from './routes'
import { supportsAgentSdkLiveSupervisor } from '../shared/providerCapabilities'
import { buildWorkspaceShareUrl, readWorkspacePointer } from '../shared/workspacePointer'
import { aggregateThreadItems, formatUiError, reportNonBlockingError, retryAsync, syncUrl } from './bootstrap'
import type {
  MapLayerPreference,
  MapRenderLayer,
  MemoryKind,
  PanelMode,
  PrimaryNav,
  SidebarItemId,
  UploadReference,
} from './types'
import {
  buildAgentTodoItems,
  buildDataReferences,
  buildProgressItems,
  classifyUploadFile,
  describeCollectionGeometry,
  describeRasterMetadata,
  formatFileSize,
  formatPanelMode,
  formatPrimaryNav,
  formatTopBarRunStatus,
  getUploadRelativePath,
  makeUploadReferenceId,
  mergeThreadRuns,
  parseRasterCoordinates,
  upsertUploadReference,
} from './derivedState'

const DebugPage = lazy(() => import('../features/debug/DebugPage').then((module) => ({ default: module.DebugPage })))
const MapCanvas = lazy(() => import('../features/map/MapCanvas').then((module) => ({ default: module.MapCanvas })))

const SIDEBAR_ITEMS: ReadonlyArray<WorkspaceSidebarItem & { id: SidebarItemId }> = [
  { id: 'assistant', icon: 'psychology', label: '智能指令', shortLabel: '助手' },
  { id: 'query', icon: 'explore', label: '空间查询', shortLabel: '查询' },
  { id: 'sources', icon: 'database', label: '数据源', shortLabel: '数据' },
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

function AppShell() {
  // 主应用壳
  //
  // 统一维护会话、运行状态、artifact、工具、调试页数据和主工作台导航。
  // 这里本质上是前端的状态编排中心：负责把 API、SSE、URL、地图与调试页
  // 组织成一个稳定的工作台，而不是只渲染静态页面。
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [session, setSession] = useState<SessionRecord>()
  const [layers, setLayers] = useState<LayerDescriptor[]>([])
  const [basemaps, setBasemaps] = useState<BasemapDescriptor[]>([DEFAULT_BASEMAP])
  const [providers, setProviders] = useState<ModelProviderDescriptor[]>([])
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [availableTools, setAvailableTools] = useState<ToolDescriptor[]>([])
  const [toolCatalogEntries, setToolCatalogEntries] = useState<Array<Record<string, unknown>>>([])
  const [runtimeConfig, setRuntimeConfig] = useState<AgentRuntimeConfig>()
  const [sessionRuns, setSessionRuns] = useState<AnalysisRun[]>([])
  const [sessionThreads, setSessionThreads] = useState<AgentThreadRecord[]>([])
  const [threadRuns, setThreadRuns] = useState<AnalysisRun[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string>()
  const [artifactData, setArtifactData] = useState<Record<string, GeoJSON.FeatureCollection>>({})
  const [artifactMetadata, setArtifactMetadata] = useState<Record<string, Record<string, unknown>>>({})
  const [mapLayerPreferences, setMapLayerPreferences] = useState<Record<string, MapLayerPreference>>({})
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [uploadedLayerName, setUploadedLayerName] = useState<string>()
  const [uploadReferences, setUploadReferences] = useState<UploadReference[]>([])
  const [allFiles, setAllFiles] = useState<FileEntry[]>([])
  const [isFileSubmitting, setIsFileSubmitting] = useState(false)
  const [memories, setMemories] = useState<Array<{ name: string; description: string; type: MemoryKind; age: string }>>([])
  const [toolRunResult, setToolRunResult] = useState<Record<string, unknown> | null>(null)
  const [isToolSubmitting, setIsToolSubmitting] = useState(false)
  const [isToolCatalogSubmitting, setIsToolCatalogSubmitting] = useState(false)
  const [provider, setProvider] = useState('openai_compatible')
  const [model, setModel] = useState('')
  const [selectedBasemapKey, setSelectedBasemapKey] = useState('osm')
  const [activeNav, setActiveNav] = useState<PrimaryNav>('analysis')
  const [panelMode, setPanelMode] = useState<PanelMode>('summary')
  const [activeSidebarItem, setActiveSidebarItem] = useState<SidebarItemId>('assistant')

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
    setItems,
  } = useRunState()
  const deferredEvents = useDeferredValue(events)
  const deferredItems = useDeferredValue(items)
  const reducedMotion = useReducedMotion() ?? false

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId),
    [artifacts, selectedArtifactId],
  )
  const providerLabel = providers.find((item) => item.provider === provider)?.displayName ?? provider
  const currentThreadId = run?.threadId ?? agentState?.threadId ?? activeThreadId
  const currentThreadTitle = sessionThreads.find((item) => item.id === currentThreadId)?.title
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    executionPlan,
    artifacts,
    events: deferredEvents,
  })
  const transcriptHeadline = useMemo(
    () => pickConversationHeadline(deferredItems, run?.status),
    [deferredItems, run?.status],
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
  )
  const selectedBasemap = useMemo(
    () => basemaps.find((item) => item.basemapKey === selectedBasemapKey) ?? basemaps[0] ?? DEFAULT_BASEMAP,
    [basemaps, selectedBasemapKey],
  )
  const primaryActionLabel = selectedArtifactId ? '发布结果' : '开始分析'
  const workspaceListVariants = buildListVariants(reducedMotion, 0.04, 0.02)
  const workspaceItemVariants = buildListItemVariants(reducedMotion, 16)

  const focusQueryInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = document.getElementById('analysis-query-input')
      if (input instanceof HTMLInputElement) {
        input.focus()
        input.select()
      }
    })
  }, [])

  const applyArtifactPayload = useCallback(
    async (artifactList: ArtifactRef[]) => {
      // artifact 水合
      //
      // 后端 run.state 里只有 ArtifactRef；真正地图需要的 GeoJSON 和 metadata
      // 需要在这里补拉一次，并拆成两个索引表以便地图和详情面板分别消费。
      const geojsonArtifacts = artifactList.filter((artifact) => artifact.artifactType === 'geojson')
      const rasterArtifacts = artifactList.filter((artifact) => artifact.artifactType !== 'geojson')
      const bundles = await Promise.all(
        geojsonArtifacts.map(async (artifact) => {
          const [data, metadataPayload] = await Promise.all([
            getArtifactGeoJson(artifact.artifactId),
            getArtifactMetadata(artifact.artifactId),
          ])

          return {
            artifactId: artifact.artifactId,
            data,
            metadata: (metadataPayload.metadata as Record<string, unknown>) ?? {},
          }
        }),
      )
      const rasterMetadata = await Promise.all(
        rasterArtifacts.map(async (artifact) => {
          const metadataPayload = await getArtifactMetadata(artifact.artifactId)
          return {
            artifactId: artifact.artifactId,
            metadata: (metadataPayload.metadata as Record<string, unknown>) ?? {},
          }
        }),
      )

      startTransition(() => {
        if (bundles.length) {
          setArtifactData((current) => {
            const next = { ...current }
            for (const bundle of bundles) {
              next[bundle.artifactId] = bundle.data
            }
            return next
          })
        }
        if (bundles.length || rasterMetadata.length) {
          setArtifactMetadata((current) => {
            const next = { ...current }
            for (const bundle of bundles) {
              next[bundle.artifactId] = bundle.metadata
            }
            for (const bundle of rasterMetadata) {
              next[bundle.artifactId] = bundle.metadata
            }
            return next
          })
        }
      })
    },
    [],
  )

  const refreshLayers = useCallback(async (sessionId?: string | null, threadId?: string | null) => {
    const layerList = await listLayers(sessionId, threadId)
    startTransition(() => {
      setLayers(layerList ?? [])
    })
  }, [])

    startTransition(() => {
    })
    return datasets
  }, [])

  const clearActiveRunState = useCallback(() => {
    clearRun()
    startTransition(() => {
      setThreadRuns([])
      setArtifactData({})
      setArtifactMetadata({})
      setSelectedArtifactId(undefined)
      setToolRunResult(null)
      setActiveThreadId(undefined)
    })
  }, [clearRun])

  const refreshSessionHistory = useCallback(async (sessionId: string) => {
    const [runs, threads] = await Promise.all([listSessionRuns(sessionId), listSessionThreads(sessionId)])
    startTransition(() => {
      setSessionRuns(runs ?? [])
      setSessionThreads(threads ?? [])
    })
    return { runs, threads }
  }, [])

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

      if (latestRun.threadId) {
        try {
          const threadPayload = await getThread(latestRun.threadId)
          startTransition(() => setThreadRuns(threadPayload.runs ?? []))
        } catch {
          startTransition(() => setThreadRuns([latestRun]))
        }
      } else {
        startTransition(() => setThreadRuns([latestRun]))
      }

      if (latestRun.state.artifacts.length > 0) {
        await applyArtifactPayload(latestRun.state.artifacts)
      }

      if (latestRun.sessionId) {
        void refreshSessionHistory(latestRun.sessionId).catch((error) => reportNonBlockingError('refreshSessionHistory:hydrateRunState', error))
      }

      syncUrl(latestRun.sessionId, latestRun.id, latestRun.threadId ?? undefined)

      return latestRun
    },
    [applyArtifactPayload, hydrateRun, refreshSessionHistory],
  )

  const handleNavChange = useCallback(
    (nav: PrimaryNav) => {
      setActiveNav(nav)

      if (nav === 'analysis') {
        setPanelMode('summary')
        setActiveSidebarItem('assistant')
        focusQueryInput()
        return
      }

      if (nav === 'layers') {
        setPanelMode('layerManager')
        setActiveSidebarItem('sources')
        return
      }

      if (nav === 'history') {
        setPanelMode('history')
        setActiveSidebarItem('assistant')
        return
      }

      setPanelMode('compute')
      setActiveSidebarItem('assistant')
    },
    [focusQueryInput],
  )

  const handleSampleSelect = useCallback(
    (value: string) => {
      // 模板问题会把界面重新切回主分析工作台，避免用户停留在别的侧栏上下文。
      setQuery(value)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      focusQueryInput()
    },
    [focusQueryInput],
  )

  const handleUseTemplate = useCallback(() => {
    // 用轮换而不是随机，确保演示模板在录屏和联调时可复现。
    const currentIndex = SAMPLES.findIndex((item) => item === query)
    const nextQuery = SAMPLES[(currentIndex + 1 + SAMPLES.length) % SAMPLES.length]
    handleSampleSelect(nextQuery)
  }, [handleSampleSelect, query])

  const handleSidebarItemClick = useCallback(
    (itemId: SidebarItemId) => {
      // 侧边栏是“工作模式切换”，不只是视觉 tab。
      //
      // 每个入口都会同步主导航、右侧面板和输入聚焦位置，
      // 避免页面看起来换了，但状态还停在上一种工作流里。
      setActiveSidebarItem(itemId)

      if (itemId === 'assistant') {
        setActiveNav('analysis')
        setPanelMode('summary')
        focusQueryInput()
        return
      }

      if (itemId === 'query') {
        setActiveNav('analysis')
        setPanelMode('summary')
        setQuery(SAMPLES[0])
        focusQueryInput()
        return
      }

      if (itemId === 'sources') {
        setActiveNav('layers')
        setPanelMode('sources')
        return
      }

      if (itemId === 'config') {
        setPanelMode('config')
        return
      }

      setPanelMode('export')
    },
    [focusQueryInput],
  )

  useEffect(() => {
    // 首次加载初始化
    //
    // 会话解析顺序：
    // 1. URL ?session= 参数 — 显式共享/深度链接，优先级最高。
    // 2. 后端默认工作台会话 GET /api/v1/sessions/default — 跨浏览器/设备的稳态会话，
    //    所有无共享链接的用户复用同一份服务器端历史。
    //
    // localStorage 只保存 activeThreadId / activeRunId 作为 UI 选中提示，
    // 不再是“历史属于哪个会话”的数据源。如果本地提示的 thread/run 不属于
    // 当前会话，则优雅降级到默认视图，不创建新的本地会话。
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
        // 会话解析：URL 分享链接优先；否则走服务器端默认工作台会话。
        //
        // 显式分享 session 失效时直接暴露错误，不能悄悄切到默认会话，
        // 否则用户会误以为当前页面就是分享链接指向的历史。
        const sessionPromise = sharedSessionId
          ? retryAsync(() => getSession(sharedSessionId), 2, 300)
          : retryAsync(() => getDefaultSession(), 2, 300)

        const [sessionRecord, basemapList] = await Promise.all([
          sessionPromise,
          retryAsync(() => listBasemaps(), 2, 300),
        ])

        startTransition(() => {
          setSession(sessionRecord)
          setUiError(undefined)
          const availableBasemaps = basemapList.filter((item) => item.available)
          if (availableBasemaps.length) {
            setBasemaps(availableBasemaps)
            const defaultBasemap = availableBasemaps.find((item) => item.isDefault) ?? availableBasemaps[0]
            setSelectedBasemapKey((current) =>
              availableBasemaps.some((item) => item.basemapKey === current) ? current : defaultBasemap.basemapKey,
            )
          }
        })

        void refreshSessionHistory(sessionRecord.id).catch((error) => reportNonBlockingError('refreshSessionHistory:bootstrap', error))

        // 恢复 UI 选中提示的 thread/run。
        //
        // 只有当这些 ID 属于当前 session 时才恢复；
        // 否则降级到 session 默认视图，不在服务端创建新 thread。
        const threadToRestore = hintedThreadId || undefined
        const runToRestore = hintedRunId || undefined
        if (threadToRestore) {
          try {
            const threadPayload = await getThread(threadToRestore)
            // 校验 thread 是否属于当前 session。
            if (threadPayload.thread.sessionId !== sessionRecord.id) {
              if (sharedThreadId) {
                throw new Error('分享链接中的对话不属于当前会话。')
              }
              // 本地提示的 thread 不属于当前默认会话，优雅降级。
              syncUrl(sessionRecord.id)
            } else {
              startTransition(() => {
                setActiveThreadId(threadPayload.thread.id)
                setThreadRuns(threadPayload.runs ?? [])
              })
              const preferredRunId =
                runToRestore && threadPayload.runs.some((item) => item.id === runToRestore)
                  ? runToRestore
                  : threadPayload.latestRun?.id
              if (preferredRunId) {
                await hydrateRunState(preferredRunId)
              } else {
                syncUrl(sessionRecord.id, undefined, threadPayload.thread.id)
              }
            }
          } catch (error) {
            if (sharedThreadId) {
              throw error
            }
            clearActiveRunState()
            syncUrl(sessionRecord.id)
          }
        } else if (runToRestore) {
          try {
            const hintedRun = await getRun(runToRestore)
            if (hintedRun.sessionId === sessionRecord.id) {
              await hydrateRunState(runToRestore)
            } else if (sharedRunId) {
              throw new Error('分享链接中的运行记录不属于当前会话。')
            } else {
              clearActiveRunState()
              syncUrl(sessionRecord.id)
            }
          } catch (error) {
            if (sharedRunId) {
              throw error
            }
            clearActiveRunState()
            syncUrl(sessionRecord.id)
          }
        } else {
          syncUrl(sessionRecord.id)
        }
      } catch (error) {
        setUiError(formatUiError(error, '页面加载遇到问题，请刷新重试。'))
      }
    })()

    void retryAsync(() => listLayers(), 2, 300)
      .then((layerList) => {
        startTransition(() => {
          setLayers(layerList ?? [])
          setUiError(undefined)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '图层目录暂时加载不了，请稍后重试。'))
      })

  useEffect(() => {
    // 模型提供方初始化
    //
    // 独立于 session 初始化，避免 provider 列表加载失败时影响首页基础骨架。
    void listProviders()
      .then((providerList) => {
        startTransition(() => {
          setProviders(providerList ?? [])
          const preferred =
            providerList.find((item) => item.provider === 'openai_compatible' && supportsAgentSdkLiveSupervisor(item)) ??
            providerList.find((item) => supportsAgentSdkLiveSupervisor(item)) ??
            providerList[0]

          if (preferred) {
            setProvider(preferred.provider)
            setModel(preferred.defaultModel ?? '')
          }
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '模型提供方加载失败。'))
      })
  }, [setUiError])

  useEffect(() => {
    // 记忆系统初始化
    //
    // 从后端获取记忆条目，接口不可用时静默降级为空列表。
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/memories`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : [] as unknown[]))
      .then((data) => {
        startTransition(() => {
          setMemories(Array.isArray(data) ? data as Array<{ name: string; description: string; type: MemoryKind; age: string }> : [])
        })
      })
      .catch(() => {
        // API 可能还不存在，静默降级
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    void getRuntimeConfig()
      .then((loadedRuntimeConfig) => {
        startTransition(() => {
          setRuntimeConfig(loadedRuntimeConfig)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '运行时配置加载失败。'))
      })
  }, [setUiError])

  useEffect(() => {
    // 工具目录预加载
    //
    // 首页的 REPL 摘要也需要使用工具目录元数据来生成更自然的中文文案，
    // 因此这里提前加载，而不是只在 debug 页里按需获取。
    void listTools()
      .then((tools) => {
        startTransition(() => {
          setAvailableTools(tools ?? [])
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '工具目录加载失败。'))
      })
  }, [setUiError])

  useEffect(() => {
    // 调试/计算工具预加载
    //
    // 只有在 /debug、compute 或 config 场景下才加载系统组件和工具目录，
    // 避免首页初始加载被一堆调试数据拖慢。
    if (location.pathname !== '/debug' && panelMode !== 'compute' && panelMode !== 'config') {
      return
    }

    void Promise.all([getSystemComponents(), listTools(), listToolCatalogEntries(), getRuntimeConfig()])
      .then(([components, tools, catalogEntries, loadedRuntimeConfig]) => {
        startTransition(() => {
          setSystemComponents(components)
          setAvailableTools(tools ?? [])
          setToolCatalogEntries(catalogEntries ?? [])
          setRuntimeConfig(loadedRuntimeConfig)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '系统状态加载遇到问题，请稍后重试。'))
    })
  }, [location.pathname, panelMode, setUiError])

  useEffect(() => {
    // 气象解析任务轮询
    //
    // 兼容手动创建的后台解析 job；普通上传现在只登记 uploaded，
    // 等用户开始分析或工具消费数据时再解析。
    if (!activeJobs.length || !session?.id) {
      return
    }
    const timer = window.setInterval(() => {
        .then((jobs) => {
          startTransition(() => {
              const next = { ...current }
              for (const job of jobs) {
                next[job.jobId] = job
              }
              return next
            })
          })
          if (jobs.some((job) => job.status === 'completed' || job.status === 'failed')) {
          }
        })
    }, 2500)
    return () => window.clearInterval(timer)

  useEffect(() => {
    if (!hasPendingDataset || !session?.id) {
      return
    }
    const timer = window.setInterval(() => {
    }, 5000)
    return () => window.clearInterval(timer)

  const refreshToolingState = useCallback(async () => {
    // 调试页和 compute 面板共用这一条刷新路径，避免各自拉一套不同快照。
    const [components, tools, catalogEntries, loadedRuntimeConfig] = await Promise.all([
      getSystemComponents(),
      listTools(),
      listToolCatalogEntries(),
      getRuntimeConfig(),
    ])
    startTransition(() => {
      setSystemComponents(components)
      setAvailableTools(tools ?? [])
      setToolCatalogEntries(catalogEntries ?? [])
      setRuntimeConfig(loadedRuntimeConfig)
    })
  }, [])

  // 新 artifact 到达时自动加载 GeoJSON 或 raster metadata
  useEffect(() => {
    const missing = artifacts.filter((artifact) => {
      if (artifact.artifactType === 'geojson') {
        return !artifactData[artifact.artifactId]
      }
      return !artifactMetadata[artifact.artifactId]
    })
    if (!missing.length) return
    void applyArtifactPayload(missing).then(() => {
      startTransition(() => {
        if (missing.length === 1) setSelectedArtifactId(missing[0].artifactId)
      })
    })
  }, [artifacts, artifactData, artifactMetadata, applyArtifactPayload])

  const submitMessage = useCallback(
    async ({
      text,
      clarificationOptionId,
      forceNewThread = false,
      updateComposer = false,
      executionMode = 'auto',
    }: {
      text?: string
      clarificationOptionId?: string | null
      forceNewThread?: boolean
      updateComposer?: boolean
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
        startRun()
        if (updateComposer) {
          setQuery(submittedQuery)
        }
        setActiveNav('analysis')
        setPanelMode('summary')
        setActiveSidebarItem('assistant')
        if (forceNewThread) {
          setArtifactData({})
          setArtifactMetadata({})
          setSelectedArtifactId(undefined)
          setToolRunResult(null)
        }

        const createdRun = targetThreadId
          ? await startThreadRun(targetThreadId, submittedQuery, provider, model || undefined, clarificationOptionId, executionMode)
          : await startAnalysis(session.id, submittedQuery, provider, model || undefined, clarificationOptionId, executionMode)
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
        setUiError(formatUiError(error, clarificationOptionId ? '回复提交失败，请重试。' : '任务提交失败，请重试。'))
        stopSubmitting()
      }
    },
    [acceptRun, currentThreadId, model, provider, providers, query, refreshSessionHistory, session, setUiError, startRun, stopSubmitting],
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
  }, [acceptRun, refreshSessionHistory, run?.id, setUiError, stopSubmitting])

  const handleClarificationSelect = useCallback(
    async (value: string, optionId?: string | null) => {
      await submitMessage({ text: value, clarificationOptionId: optionId, updateComposer: true })
    },
    [submitMessage],
  )

  const handleNewConversation = useCallback(() => {
    // 显式新建对话只重置前端 active thread，不提前创建数据库记录。
    //
    // 下一次发送消息时因为没有 activeThreadId，会自然走 startAnalysis 创建新 thread。
    // 同时清理上一轮的上传数据显示，保证新 thread 看到干净的工作区。
    startTransition(() => {
      setQuery('')
      clearActiveRunState()
      setThreadRuns([])
      setArtifactData({})
      setArtifactMetadata({})
      setSelectedArtifactId(undefined)
      setToolRunResult(null)
      setActiveThreadId(undefined)
      setUploadedLayerName(undefined)
      setUploadReferences([])
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
    })
    if (session?.id) {
      syncUrl(session.id)
    }
    focusQueryInput()
  }, [clearActiveRunState, focusQueryInput, session?.id])

  const uploadOneFile = useCallback(
    async (file: File, explicitThreadId?: string | null) => {
      // 单文件上传原子操作。
      //
      // 批量/文件夹上传在调用层编排；这里只维护一个文件的引用状态，
      // 保证聊天面板能立即看到”正在引用什么数据”。
      if (!session) {
        throw new Error('当前会话还没有初始化，暂时不能上传文件。')
      }
      const threadId = explicitThreadId ?? currentThreadId
      const kind = classifyUploadFile(file)
      if (!kind) {
        throw new Error(`不支持的文件类型：${file.name}`)
      }
      const relativePath = getUploadRelativePath(file)
      const referenceId = makeUploadReferenceId(kind, relativePath, file)
      const baseReference: UploadReference = {
        id: referenceId,
        kind,
        name: file.name,
        relativePath,
        status: 'uploading',
        detail: `${formatFileSize(file.size)} · 正在上传`,
      }
      setUploadReferences((current) => upsertUploadReference(current, baseReference))

      try {
          startTransition(() => {
            setUploadedLayerName(dataset.filename)
            if (job) {
            }
            setUploadReferences((current) => upsertUploadReference(current, {
              ...baseReference,
              id: referenceId,
              status: dataset.status,
            }))
          })
          return { kind, name: dataset.filename }
        }

        const descriptor = await uploadLayer(session.id, file, threadId)
        startTransition(() => {
          setUploadedLayerName(descriptor.name)
          setUploadReferences((current) => upsertUploadReference(current, {
            ...baseReference,
            id: referenceId,
            name: descriptor.name,
            status: 'ready',
            detail: `${descriptor.featureCount ?? 0} 个对象 · ${descriptor.geometryType}`,
          }))
        })
        return { kind, name: descriptor.name }
      } catch (error) {
        setUploadReferences((current) => upsertUploadReference(current, {
          ...baseReference,
          id: referenceId,
          status: 'failed',
          detail: formatUiError(error, '上传失败'),
        }))
        throw error
      }
    },
    [session, currentThreadId],
  )

  const ensureUploadThread = useCallback(async () => {
    // 上传归属边界
    //
    // 上传文件必须写入具体 thread；如果用户还没发消息，前端先创建一个
    // “文件上传”线程，再把文件、数据集和本地 UI 指针全部绑定到它。
    if (!session) {
      throw new Error('当前会话还没有初始化，暂时不能上传文件。')
    }
    if (currentThreadId) {
      return currentThreadId
    }
    const thread = await createThread(session.id, '文件上传')
    startTransition(() => {
      setActiveThreadId(thread.id)
      setSessionThreads((current) => current.some((item) => item.id === thread.id) ? current : [thread, ...current])
    })
    syncUrl(session.id, undefined, thread.id)
    return thread.id
  }, [currentThreadId, session])

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      // 多文件/文件夹上传编排。
      //
      // 浏览器文件夹选择会给出扁平 FileList；逐个走现有上传 API，
      // 既保留后端单文件事务边界，也让每个文件有独立失败状态。
      if (!session) {
        return
      }
      const uploadable = files.filter((file) => classifyUploadFile(file))
      const skippedCount = files.length - uploadable.length
      if (!uploadable.length) {
        setUiError('没有找到可上传的 GeoJSON、GPKG、ZIP Shapefile、NetCDF、GRIB、GeoTIFF、HDF5 或雷达 bz2 文件。')
        return
      }

      let resolvedThreadId: string
      try {
        resolvedThreadId = await ensureUploadThread()
      } catch (error) {
        setUiError(formatUiError(error, '上传前创建对话线程失败。'))
        return
      }

      setUiError(undefined)
      setActiveNav('layers')
      setPanelMode('layerManager')
      setActiveSidebarItem('sources')

      let layerUploaded = false
      const failures: string[] = []
      for (const file of uploadable) {
        try {
          const result = await uploadOneFile(file, resolvedThreadId)
          layerUploaded ||= result.kind === 'layer'
        } catch (error) {
          failures.push(`${getUploadRelativePath(file)}：${formatUiError(error, '上传失败')}`)
        }
      }

      const refreshes: Array<Promise<unknown>> = []
      if (layerUploaded) {
        refreshes.push(
          Promise.all([getSession(session.id), listLayers(session.id)]).then(([sessionRecord, layerList]) => {
            startTransition(() => {
              setSession(sessionRecord)
              setLayers(layerList ?? [])
            })
          }),
        )
      }
      }
      try {
        await Promise.all(refreshes)
      } catch (error) {
        setUiError(formatUiError(error, '文件已上传，但数据源列表刷新失败，请手动刷新页面确认。'))
        return
      }

      if (failures.length) {
        setUiError(`部分文件上传失败：${failures.slice(0, 3).join('；')}${failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : ''}`)
      } else if (skippedCount > 0) {
        setUiError(`已上传 ${uploadable.length} 个文件，跳过 ${skippedCount} 个不支持的文件。`)
      }
    },
  )

  const handleUpload = useCallback(
    async (file: File) => {
      await handleUploadFiles([file])
    },
    [handleUploadFiles],
  )

  const handleImportManagedLayer = useCallback(
    async (file: File) => {
      try {
        setUiError(undefined)
        setActiveNav('layers')
        setPanelMode('layerManager')
        setActiveSidebarItem('sources')
        await importManagedLayer(file)
        await refreshLayers()
      } catch (error) {
        setUiError(formatUiError(error, '图层导入没成功，请再试一次。'))
      }
    },
    [refreshLayers, setUiError],
  )

  const handleToggleLayerStatus = useCallback(
    async (layerKey: string, nextStatus: string) => {
      try {
        setUiError(undefined)
        await updateLayer(layerKey, { status: nextStatus })
        await refreshLayers()
      } catch (error) {
        setUiError(formatUiError(error, '图层状态更新失败，请再试一次。'))
      }
    },
    [refreshLayers, setUiError],
  )

  const handleReplaceManagedLayer = useCallback(
    async (layerKey: string, file: File) => {
      try {
        setUiError(undefined)
        setActiveNav('layers')
        setPanelMode('layerManager')
        setActiveSidebarItem('sources')
        await replaceManagedLayer(layerKey, file)
        await refreshLayers()
      } catch (error) {
        setUiError(formatUiError(error, '图层数据替换失败，请再试一次。'))
      }
    },
    [refreshLayers, setUiError],
  )

  const handleDeleteLayer = useCallback(
    async (layerKey: string) => {
      try {
        setUiError(undefined)
        await deleteLayer(layerKey)
        await refreshLayers()
      } catch (error) {
        setUiError(formatUiError(error, '图层删除失败，请再试一次。'))
      }
    },
    [refreshLayers, setUiError],
  )

  // 统一文件管理
  const refreshAllFiles = useCallback(async (threadId?: string | null) => {
    try {
      const data = await listAllFiles(threadId || currentThreadId)
      setAllFiles(data.files ?? [])
    } catch (error) {
      reportNonBlockingError('refreshAllFiles', error)
    }
  }, [currentThreadId])

  const handleUploadAnyFile = useCallback(async (file: File) => {
    setIsFileSubmitting(true)
    try {
      const resolvedThreadId = await ensureUploadThread()
      await uploadAnyFile(file, resolvedThreadId)
      await refreshAllFiles(resolvedThreadId)
    } catch (error) {
      setUiError(formatUiError(error, `上传 ${file.name} 失败`))
    } finally {
      setIsFileSubmitting(false)
    }
  }, [ensureUploadThread, refreshAllFiles, setUiError])

  const handleDeleteAnyFile = useCallback(async (fileId: string) => {
    try {
      setUiError(undefined)
      await deleteAnyFile(fileId, currentThreadId)
      // 也从 layers 状态中移除
      setLayers(prev => prev.filter(l => l.layerKey !== fileId))
      await refreshAllFiles(currentThreadId)
    } catch (error) {
      setUiError(formatUiError(error, '删除文件失败'))
    }
  }, [currentThreadId, refreshAllFiles, setUiError])

  // 切换到 sources 面板时自动刷新文件列表
  useEffect(() => {
    if (panelMode === 'sources') {
      refreshAllFiles(currentThreadId)
    }
  }, [panelMode, currentThreadId, refreshAllFiles])

  const handleResolveApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      if (!run?.id) {
        return
      }

      try {
        setUiError(undefined)
        await resolveApproval(run.id, approvalId, approved)
        await hydrateRunState(run.id)
      } catch (error) {
        setUiError(formatUiError(error, approved ? '审批操作没成功，请重试。' : '拒绝操作没成功，请重试。'))
      }
    },
    [hydrateRunState, run?.id, setUiError],
  )

  const handleSelectThread = useCallback(
    async (threadId: string) => {
      // 主聊天面板按 thread 打开历史任务，聚合所有 run 的 item 以保证连续对话。
      try {
        setUiError(undefined)
        const threadPayload = await getThread(threadId)
        const runs = threadPayload.runs ?? []
        startTransition(() => {
          setActiveThreadId(threadPayload.thread.id)
          setThreadRuns(runs)
        })
        if (threadPayload.latestRun?.id) {
          await hydrateRunState(threadPayload.latestRun.id)
          // 聚合 thread 内所有已完成 run 的 item
          const completedRuns = runs.filter(r => r.status !== 'running')
          if (completedRuns.length > 1) {
            const allItems = await aggregateThreadItems(completedRuns)
            setItems(allItems)
          }
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
        if (session?.id) {
          syncUrl(session.id, undefined, threadPayload.thread.id)
        }
      } catch (error) {
        setUiError(formatUiError(error, '历史记录加载失败，请稍后重试。'))
      }
    },
    [clearActiveRunState, hydrateRunState, session?.id, setItems, setUiError],
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
        const updated = await updateThread(threadId, nextTitle)
        startTransition(() => {
          setSessionThreads((current) => current.map((item) => (item.id === threadId ? updated : item)))
        })
      } catch (error) {
        setUiError(formatUiError(error, '标题更新失败，请再试一次。'))
      }
    },
    [setUiError],
  )

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      if (!session?.id) {
        return
      }

      try {
        setUiError(undefined)
        await deleteThread(threadId)
        const sessionRecord = await getSession(session.id)
        await refreshSessionHistory(session.id)
        startTransition(() => {
          setSession(sessionRecord)
        })

        if (currentThreadId === threadId) {
          clearActiveRunState()
          syncUrl(session.id)
        }
      } catch (error) {
        setUiError(formatUiError(error, '任务删除失败，请再试一次。'))
      }
    },
    [clearActiveRunState, currentThreadId, refreshSessionHistory, session?.id, setUiError],
  )

  // 稳定化 ChatPanel 回调引用，避免每次渲染重建导致子树无效重渲染
  const onSubmitStable = useStableVoid(handleSubmit)
  const onSelectClarificationStable = useStableVoid(handleClarificationSelect)
  const onSelectTaskStable = useStableVoid(handleSelectThread)
  const onRenameTaskStable = useStableVoid(handleRenameThread)
  const onDeleteTaskStable = useStableVoid(handleDeleteThread)
  const onResolveApprovalStable = useStableVoid(handleResolveApproval)

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
    [currentThreadId, hydrateRunState, run?.id, session?.id, setUiError],
  )

  const handleUpsertToolCatalogEntry = useCallback(
    async (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => {
      try {
        setUiError(undefined)
        setIsToolCatalogSubmitting(true)
        await upsertToolCatalogEntry(tool.toolKind, tool.name, payload, sortOrder)
        await refreshToolingState()
      } catch (error) {
        setUiError(formatUiError(error, `${tool.label} 目录配置保存失败。`))
      } finally {
        setIsToolCatalogSubmitting(false)
      }
    },
    [refreshToolingState, setUiError],
  )

  const handleSaveRuntimeConfig = useCallback(async (nextConfig: AgentRuntimeConfig) => {
    try {
      setUiError(undefined)
      const saved = await updateRuntimeConfig(nextConfig)
      startTransition(() => {
        setRuntimeConfig(saved)
      })
    } catch (error) {
      setUiError(formatUiError(error, '运行时配置保存失败。'))
    }
  }, [setUiError])

  const handleDeleteToolCatalogEntry = useCallback(
    async (tool: ToolDescriptor) => {
      try {
        setUiError(undefined)
        setIsToolCatalogSubmitting(true)
        await deleteToolCatalogEntry(tool.toolKind, tool.name)
        await refreshToolingState()
      } catch (error) {
        setUiError(formatUiError(error, `${tool.label} 目录配置删除失败。`))
      } finally {
        setIsToolCatalogSubmitting(false)
      }
    },
    [refreshToolingState, setUiError],
  )

  const handleCopyShareLink = useCallback(async () => {
    // 分享链接是唯一显式编码 session/thread/run 的入口。
    //
    // 普通地址栏保持干净；只有用户主动复制时，才生成可恢复上下文的链接。
    try {
      const url = buildWorkspaceShareUrl(window.location.origin, session?.id, run?.id, currentThreadId)
      await navigator.clipboard.writeText(url)
    } catch {
      setUiError('复制分享链接失败，请稍后重试。')
    }
  }, [currentThreadId, run?.id, session?.id, setUiError])

  const handleProviderChange = useCallback(
    (value: string) => {
      setProvider(value)
      const selected = providers.find((item) => item.provider === value)
      setModel(selected?.defaultModel ?? '')
    },
    [providers],
  )

  const handleToggleArtifactVisibility = useCallback((artifactId: string) => {
    setMapLayerPreferences((current) => {
      const existing = current[artifactId]
      return {
        ...current,
        [artifactId]: {
          visible: existing ? !existing.visible : false,
          opacity: existing?.opacity ?? 0.9,
        },
      }
    })
  }, [])

  const handleArtifactOpacityChange = useCallback((artifactId: string, opacity: number) => {
    setMapLayerPreferences((current) => ({
      ...current,
      [artifactId]: {
        visible: current[artifactId]?.visible ?? true,
        opacity,
      },
    }))
  }, [])

  const mapLayers: MapRenderLayer[] = useMemo(
    () => {
      const isRunning = run?.status === 'running'
      return artifacts
        .filter((artifact) => isRunning || !artifact.isIntermediate)
        .flatMap<MapRenderLayer>((artifact) => {
        const visible = mapLayerPreferences[artifact.artifactId]?.visible ?? true
        const opacity = mapLayerPreferences[artifact.artifactId]?.opacity ?? 0.9
        if (artifact.artifactType === 'geojson' && artifactData[artifact.artifactId]) {
          return [{
            kind: 'geojson' as const,
            artifact,
            data: artifactData[artifact.artifactId],
            visible,
            opacity,
            featureCount: artifactData[artifact.artifactId]?.features.length ?? 0,
            geometrySummary: describeCollectionGeometry(artifactData[artifact.artifactId]),
          }]
        }
        const metadata = artifactMetadata[artifact.artifactId] ?? artifact.metadata
        const coordinates = parseRasterCoordinates(metadata.coordinates)
        const imageUrl = typeof metadata.imageUrl === 'string' ? `${apiBaseUrl}${metadata.imageUrl}` : `${apiBaseUrl}${artifact.uri}`
        if (artifact.artifactType === 'raster_png' && coordinates) {
          return [{
            kind: 'raster' as const,
            artifact,
            imageUrl,
            coordinates,
            visible,
            opacity,
            featureCount: 1,
            geometrySummary: describeRasterMetadata(metadata),
          }]
        }
        return []
      })
    },
    [artifactData, artifactMetadata, artifacts, mapLayerPreferences, run?.status],
  )

  const layerManager = useLayerManager({
    mapLayers,
    onToggleVisibility: handleToggleArtifactVisibility,
    onChangeOpacity: handleArtifactOpacityChange,
  })

  const handleZoomToLayer = useCallback((id: string) => {
    setSelectedArtifactId(id)
  }, [])

  const handleExportLayer = useCallback((id: string) => {
    const artifact = artifacts.find((a) => a.artifactId === id)
    if (artifact) {
      window.open(`${apiBaseUrl}${artifact.uri}`, '_blank')
    }
  }, [artifacts])

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
                artifactCount={artifacts.length}
                selectedArtifactName={selectedArtifact?.name}
                transcriptTitle={transcriptHeadline.title}
                transcriptBody={transcriptHeadline.body}
                reducedMotion={reducedMotion}
                workspaceListVariants={workspaceListVariants}
                workspaceItemVariants={workspaceItemVariants}
              >
                <m.div className="min-w-0" layout variants={workspaceItemVariants}>
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
                    intent={intent}
                    clarification={agentState?.clarification}
                    sessionThreads={sessionThreads}
                    items={deferredItems}
                    runtimeConfig={runtimeConfig}
                    availableTools={availableTools}
                    onQueryChange={setQuery}
                    onSubmit={onSubmitStable}
                    onInterrupt={handleInterruptRun}
                    onNewConversation={handleNewConversation}
                    onFillSample={handleSampleSelect}
                    onSelectClarification={onSelectClarificationStable}
                    onUseTemplate={handleUseTemplate}
                    onUploadFiles={(files) => {
                      void handleUploadFiles(files)
                    }}
                    onSelectArtifact={setSelectedArtifactId}
                    onSelectTask={onSelectTaskStable}
                    onRenameTask={onRenameTaskStable}
                    onDeleteTask={onDeleteTaskStable}
                    onResolveApproval={onResolveApprovalStable}
                    dataReferences={dataReferences}
                    memories={memories}
                    onRefreshMemories={() => {
                      const c = new AbortController()
                      fetch(`${apiBaseUrl}/api/memories`, { signal: c.signal })
                        .then((res) => (res.ok ? res.json() : [] as unknown[]))
                        .then((data) => {
                          startTransition(() => {
                            setMemories(Array.isArray(data) ? data as Array<{ name: string; description: string; type: MemoryKind; age: string }> : [])
                          })
                        })
                        .catch(() => {})
                    }}
                    tokenBudget={tokenBudget}
                    activeSkills={activeSkills}
                    compactionLevel={compactionLevel}
                    runStats={runStats}
                    denialCounts={denialCounts}
                    executionPlan={executionPlan}
                    tasks={progressTasks}
                  />
                </m.div>

                <m.div className="min-w-0" layout variants={workspaceItemVariants}>
                  <Suspense fallback={<div className="dc-map-stage dc-map-stage--loading">正在加载地图…</div>}>
                    <MapCanvas
                      artifactCount={artifacts.length}
                      basemaps={basemaps}
                      runStatus={run?.status}
                      selectedBasemapKey={selectedBasemapKey}
                      onSelectBasemap={setSelectedBasemapKey}
                      layers={mapLayers}
                      selectedArtifactId={selectedArtifactId}
                      selectedArtifactName={selectedArtifact?.name}
                      onSelectArtifact={setSelectedArtifactId}
                      placeResolution={placeResolution}
                      agentState={agentState}
                    />
                  </Suspense>
                </m.div>

                <m.div className="min-w-0" layout variants={workspaceItemVariants} transition={motionSpring.gentle}>
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
                    onCopyShareLink={() => {
                      void handleCopyShareLink()
                    }}
                    onProviderChange={handleProviderChange}
                    onModelChange={setModel}
                    onResolveApproval={(approvalId, approved) => {
                      void handleResolveApproval(approvalId, approved)
                    }}
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
                    layerTree={layerManager.tree}
                    layerSelectedId={layerManager.selectedId}
                    layerSearchQuery={layerManager.searchQuery}
                    layerTotalCount={layerManager.totalCount}
                    layerVisibleCount={layerManager.visibleCount}
                    layerSelectedNode={layerManager.selectedNode}
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
                    onLayerZoomTo={handleZoomToLayer}
                    onLayerExport={handleExportLayer}
                    allFiles={allFiles}
                    onUploadFile={(file) => { void handleUploadAnyFile(file) }}
                    onDeleteFile={(fileId) => { void handleDeleteAnyFile(fileId) }}
                    isFileSubmitting={isFileSubmitting}
                  />
                </m.div>
              </WorkspaceLayout>
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
                  void handleUpload(file)
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

export default AppShell
