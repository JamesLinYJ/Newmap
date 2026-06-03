// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 应用壳
//
//   文件:       App.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 负责前端全局状态编排、API 调用、事件订阅、地图与 REPL 面板联动。

import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_BASEMAP, SAMPLES, type DataReferenceSummary } from './constants'
import { domAnimation, LazyMotion, m, MotionConfig, useReducedMotion } from 'framer-motion'
import { Route, Routes, useLocation } from 'react-router-dom'

import type {
  AgentRuntimeConfig,
  AnalysisRun,
  AgentThreadRecord,
  ArtifactRef,
  BasemapDescriptor,
  ExecutionPlan,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  SessionRecord,
  SystemComponentsStatus,
  ToolDescriptor,
  UserIntent,
  WeatherDatasetRecord,
  WeatherJobRecord,
} from '@geo-agent-platform/shared-types'

import {
  type AgentExecutionMode,
  cancelRun,
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
  getWeatherJob,
  importManagedLayer,
  listBasemaps,
  listLayers,
  listProviders,
  listSessionThreads,
  listTools,
  listToolCatalogEntries,
  listWeatherDatasets,
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
  uploadWeatherDataset,
  apiBaseUrl,
} from './api'
import './App.css'
import { pickPreferredArtifactId } from './artifactSelection'
import { buildFadeUpMotion, buildListItemVariants, buildListVariants, motionSpring } from './motion'
import { deriveThreadTranscript, pickTranscriptHeadline } from './runTranscript'
import { useRunState } from './hooks/useRunState'
import { useLayerManager } from './hooks/useLayerManager'
import { ChatPanel } from './components/ChatPanel'
import { DetailPanel } from './components/DetailPanel'
import { AppIcon, type AppIconName } from './components/AppIcon'
import { TopBar } from './components/TopBar'
import { supportsAgentSdkLiveSupervisor } from './providerCapabilities'
import { buildWorkspaceShareUrl, readWorkspacePointer, syncCleanWorkspaceUrl } from './workspacePointer'

type PrimaryNav = 'analysis' | 'layers' | 'history' | 'compute'
type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config' | 'layerManager'
type SidebarItemId = 'assistant' | 'query' | 'sources' | 'config' | 'export'
type MapLayerPreference = { visible: boolean; opacity: number }

interface MapRenderLayer {
  kind: 'geojson' | 'raster'
  artifact: ArtifactRef
  data?: GeoJSON.FeatureCollection
  imageUrl?: string
  coordinates?: [[number, number], [number, number], [number, number], [number, number]]
  visible: boolean
  opacity: number
  featureCount: number
  geometrySummary: string
}

interface UploadReference {
  id: string
  kind: 'layer' | 'weather'
  name: string
  relativePath?: string
  status: 'pending' | 'uploading' | 'queued' | 'running' | 'completed' | 'failed' | 'ready' | string
  detail?: string
}

const DebugPage = lazy(() => import('./components/DebugPage').then((module) => ({ default: module.DebugPage })))
const MapCanvas = lazy(() => import('./components/MapCanvas').then((module) => ({ default: module.MapCanvas })))

const SIDEBAR_ITEMS: Array<{ id: SidebarItemId; icon: AppIconName; label: string; shortLabel: string }> = [
  { id: 'assistant', icon: 'psychology', label: '智能指令', shortLabel: '助手' },
  { id: 'query', icon: 'explore', label: '空间查询', shortLabel: '查询' },
  { id: 'sources', icon: 'database', label: '数据源', shortLabel: '数据' },
  { id: 'config', icon: 'settings_account_box', label: '模型配置', shortLabel: '模型' },
  { id: 'export', icon: 'ios_share', label: '导出', shortLabel: '导出' },
] as const

const LAYER_FILE_SUFFIXES = new Set(['.geojson', '.json', '.gpkg', '.zip'])
const WEATHER_FILE_SUFFIXES = new Set(['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5', '.bz2'])

function formatUiError(error: unknown, defaultMessage: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return defaultMessage
}

function reportNonBlockingError(scope: string, error: unknown) {
  // 非阻断刷新失败不覆盖主任务状态。
  //
  // 但失败必须留下诊断线索，避免历史列表或辅助面板悄悄停更。
  console.warn(`[${scope}]`, error)
}

function useStableVoid<Args extends unknown[]>(fn: (...args: Args) => Promise<void>): (...args: Args) => void {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])
  return useCallback((...args: Args) => { void ref.current(...args) }, [])
}

function App() {
  // 主应用壳
  //
  // 统一维护会话、运行状态、artifact、工具、调试页数据和主工作台导航。
  // 这里本质上是前端的状态编排中心：负责把 API、SSE、URL、地图与调试页
  // 组织成一个稳定的工作台，而不是只渲染静态页面。
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [session, setSession] = useState<SessionRecord>()
  const [layers, setLayers] = useState<LayerDescriptor[]>([])
  const [weatherDatasets, setWeatherDatasets] = useState<WeatherDatasetRecord[]>([])
  const [weatherJobs, setWeatherJobs] = useState<Record<string, WeatherJobRecord>>({})
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
  const [memories, setMemories] = useState<Array<{ name: string; description: string; type: string; age: string }>>([])
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
    hydrateRun,
    acceptRun,
    startRun,
    stopSubmitting,
    setError: setUiError,
  } = useRunState()
  const deferredEvents = useDeferredValue(events)
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
  const transcriptEntries = useMemo(
    () => deriveThreadTranscript({
      run,
      threadRuns,
      agentState,
      events: deferredEvents,
      artifacts,
      query,
      runtimeConfig,
    }),
    [deferredEvents, run, threadRuns, agentState, artifacts, query, runtimeConfig],
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
      const max = p.tokens_max ?? p.budget_max ?? (p.usage as Record<string, unknown> | undefined)?.max_tokens ?? 100000
      const budgetStatus = (p.budget_status as string) ?? (tokensUsed > max ? 'exceeded' : tokensUsed > max * 0.9 ? 'critical' : tokensUsed > max * 0.7 ? 'warning' : 'normal')
      return {
        used: tokensUsed,
        max: Number(max),
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
      // Fallback: scan runtime_stats in run state
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
    return null
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
    () => buildDataReferences({ layers, weatherDatasets, uploadReferences, artifacts, threadRuns, currentThreadId }),
    [artifacts, layers, uploadReferences, weatherDatasets, threadRuns, currentThreadId],
  )
  const transcriptHeadline = pickTranscriptHeadline(transcriptEntries, run?.status)
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

  const refreshWeatherDatasets = useCallback(async (sessionId: string, threadId?: string | null) => {
    const datasets = await listWeatherDatasets(sessionId, threadId)
    startTransition(() => {
      setWeatherDatasets(datasets ?? [])
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
        setPanelMode('layerManager')
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
        void refreshWeatherDatasets(sessionRecord.id, currentThreadId).catch((error) => reportNonBlockingError('refreshWeatherDatasets:bootstrap', error))

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
  }, [clearActiveRunState, hydrateRunState, refreshSessionHistory, refreshWeatherDatasets, setUiError])

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
          setMemories(Array.isArray(data) ? data : [])
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
    const activeJobs = Object.values(weatherJobs).filter((job) => job.status === 'queued' || job.status === 'running')
    if (!activeJobs.length || !session?.id) {
      return
    }
    const timer = window.setInterval(() => {
      void Promise.all(activeJobs.map((job) => getWeatherJob(job.jobId)))
        .then((jobs) => {
          startTransition(() => {
            setWeatherJobs((current) => {
              const next = { ...current }
              for (const job of jobs) {
                next[job.jobId] = job
              }
              return next
            })
          })
          if (jobs.some((job) => job.status === 'completed' || job.status === 'failed')) {
            void refreshWeatherDatasets(session.id).catch((error) => reportNonBlockingError('refreshWeatherDatasets:poll', error))
          }
        })
        .catch((error) => reportNonBlockingError('weatherJobPoll', error))
    }, 2500)
    return () => window.clearInterval(timer)
  }, [refreshWeatherDatasets, session?.id, weatherJobs])

  useEffect(() => {
    const hasPendingDataset = weatherDatasets.some((dataset) => dataset.status === 'queued' || dataset.status === 'running')
    if (!hasPendingDataset || !session?.id) {
      return
    }
    const timer = window.setInterval(() => {
      void refreshWeatherDatasets(session.id).catch((error) => reportNonBlockingError('refreshWeatherDatasets:datasetPoll', error))
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refreshWeatherDatasets, session?.id, weatherDatasets])

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
    async (file: File) => {
      // 单文件上传原子操作。
      //
      // 批量/文件夹上传在调用层编排；这里只维护一个文件的引用状态，
      // 保证聊天面板能立即看到“正在引用什么数据”。
      if (!session) {
        throw new Error('当前会话还没有初始化，暂时不能上传文件。')
      }
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
        if (kind === 'weather') {
          const { dataset, job } = await uploadWeatherDataset(session.id, file, currentThreadId)
          startTransition(() => {
            setUploadedLayerName(dataset.filename)
            setWeatherDatasets((current) => mergeWeatherDataset(current, dataset))
            if (job) {
              setWeatherJobs((current) => ({ ...current, [job.jobId]: job }))
            }
            setUploadReferences((current) => upsertUploadReference(current, {
              ...baseReference,
              id: referenceId,
              status: dataset.status,
              detail: `${formatFileSize(file.size)} · ${formatWeatherUploadDetail(dataset.status)}`,
            }))
          })
          return { kind, name: dataset.filename }
        }

        const descriptor = await uploadLayer(session.id, file, currentThreadId)
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

      setUiError(undefined)
      setActiveNav('layers')
      setPanelMode('layerManager')
      setActiveSidebarItem('sources')

      let layerUploaded = false
      let weatherUploaded = false
      const failures: string[] = []
      for (const file of uploadable) {
        try {
          const result = await uploadOneFile(file)
          layerUploaded ||= result.kind === 'layer'
          weatherUploaded ||= result.kind === 'weather'
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
      if (weatherUploaded) {
        refreshes.push(refreshWeatherDatasets(session.id))
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
    [refreshWeatherDatasets, session, setUiError, uploadOneFile],
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
      // 主聊天面板按 thread 打开历史任务，保证同一轮澄清和续跑仍显示在一条对话里。
      try {
        setUiError(undefined)
        const threadPayload = await getThread(threadId)
        startTransition(() => {
          setActiveThreadId(threadPayload.thread.id)
          setThreadRuns(threadPayload.runs ?? [])
        })
        if (threadPayload.latestRun?.id) {
          await hydrateRunState(threadPayload.latestRun.id)
          if (session?.id) {
            syncUrl(session.id, threadPayload.latestRun.id, threadPayload.thread.id)
          }
          return
        }

        startTransition(() => {
          clearActiveRunState()
          setThreadRuns(threadPayload.runs ?? [])
          setActiveThreadId(threadPayload.thread.id)
        })
        if (session?.id) {
          syncUrl(session.id, undefined, threadPayload.thread.id)
        }
      } catch (error) {
        setUiError(formatUiError(error, '历史记录加载失败，请稍后重试。'))
      }
    },
    [clearActiveRunState, hydrateRunState, session?.id, setUiError],
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
          <Routes>
        <Route
          path="/"
          element={
            <m.div className="digital-cartographer" {...buildFadeUpMotion(reducedMotion, 0, 10)}>
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

              <div className="app-shell-grid grid min-h-screen grid-cols-[220px_minmax(0,1fr)] gap-0 pt-16">
                <aside className="app-sidebar sticky top-16 flex h-[calc(100vh-64px)] flex-col gap-6 self-start border-r border-white/30 bg-white/40 p-5 backdrop-blur-md" aria-label="工作空间导航">
                  <div className="app-sidebar-copy">
                    <div className="detail-label">地理智能平台</div>
                    <h2 className="mt-1.5 text-xl font-bold text-slate-800 font-mono">工作空间</h2>
                    <p className="mt-2 text-[13px] text-slate-500 leading-relaxed">自然语言驱动空间分析，从查询到发布一站式完成。</p>
                  </div>
                  <nav className="app-sidebar-nav flex flex-col gap-1.5">
                    {SIDEBAR_ITEMS.map((item) => (
                      <button key={item.id} type="button"
                        className={activeSidebarItem===item.id?'sidebar-btn sidebar-btn-active':'sidebar-btn'}
                        onClick={()=>handleSidebarItemClick(item.id)}>
                        <AppIcon name={item.icon} size={17}/>
                        <span className="hidden sm:inline">{item.label}</span>
                        <span className="sm:hidden text-[11px]">{item.shortLabel}</span>
                      </button>
                    ))}
                  </nav>
                  <div className="app-sidebar-metrics mt-auto flex flex-col gap-2.5">
                    <article className="glass-subtle p-3.5 rounded-2xl">
                      <span className="detail-label">运行</span>
                      <strong className="detail-value">{formatTopBarRunStatus(run?.status)}</strong>
                      <p className="text-[11px] text-slate-400 mt-1">{run?.id?'当前对话继续中':'等待分析请求'}</p>
                    </article>
                    <article className="glass-subtle p-3.5 rounded-2xl">
                      <span className="detail-label">数据</span>
                      <strong className="detail-value">{dataReferences.length}对象</strong>
                      <p className="text-[11px] text-slate-400 mt-1">{selectedBasemap.name}·{uploadedLayerName??'无自定义数据'}</p>
                    </article>
                  </div>
                </aside>

                <main className="app-main min-w-0 p-5" role="main">
                  <m.section className="workspace-overview mb-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5" aria-label="工作台概览"
                    variants={workspaceListVariants}
                    initial="hidden"
                    animate="visible"
                  >
                    <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
                      <span className="detail-label">模式</span>
                      <strong className="detail-value">{formatPrimaryNav(activeNav)}</strong>
                      <p className="text-[11px] text-slate-400 mt-1">{formatPanelMode(panelMode)}就绪</p>
                    </m.article>
                    <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
                      <span className="detail-label">模型</span>
                      <strong className="detail-value">{providerLabel}</strong>
                      <p className="text-[11px] text-slate-400 mt-1">{model||'默认'}·处理中</p>
                    </m.article>
                    <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
                      <span className="detail-label">结果</span>
                      <strong className="detail-value">{artifacts.length}产物</strong>
                      <p className="text-[11px] text-slate-400 mt-1">{selectedArtifact?.name??'未选中图层'}</p>
                    </m.article>
                    <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
                      <span className="detail-label">进度</span>
                      <strong className="detail-value">{transcriptHeadline.title}</strong>
                      <p className="text-[11px] text-slate-400 mt-1">{transcriptHeadline.body}</p>
                    </m.article>
                  </m.section>
                  <m.div
                    className="workspace-grid grid min-h-[calc(100vh-64px-44px)] grid-cols-[minmax(240px,0.78fr)_minmax(480px,1.82fr)_minmax(240px,0.84fr)] items-start gap-4"
                    variants={workspaceListVariants}
                    initial="hidden"
                    animate="visible"
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
                        transcriptEntries={transcriptEntries}
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
                                setMemories(Array.isArray(data) ? data : [])
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
                        sessions={sessionRuns?.map(run => ({
                          id: run.id,
                          title: run.title ?? run.userQuery ?? '',
                          created_at: run.createdAt,
                          latest_query: run.userQuery ?? '',
                          run_count: 1,
                        }))}
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
                        artifacts={artifacts}
                        artifactData={artifactData}
                        mapLayers={mapLayers}
                        layers={layers}
                        weatherDatasets={weatherDatasets}
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
                        onLayerRename={layerManager.renameLayer}
                        onLayerMoveUp={layerManager.moveUp}
                        onLayerMoveDown={layerManager.moveDown}
                        onLayerRemove={layerManager.removeLayer}
                        onLayerCreateGroup={layerManager.createGroup}
                        onLayerToggleGroup={layerManager.toggleGroup}
                        onLayerSetSearchQuery={layerManager.setSearchQuery}
                        onLayerZoomTo={handleZoomToLayer}
                        onLayerExport={handleExportLayer}
                      />
                    </m.div>
                  </m.div>
                </main>
              </div>
            </m.div>
          }
        />
        <Route
          path="/debug"
          element={
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
              weatherDatasets={weatherDatasets}
              events={deferredEvents}
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
          </Routes>
        </MotionConfig>
      </LazyMotion>
    </Suspense>
  )
}

export default App

function formatTopBarRunStatus(status?: string) {
  if (status === 'completed') {
    return '分析完成'
  }
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'running') {
    return '执行中'
  }
  if (status === 'failed') {
    return '运行失败'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'cancelled') {
    return '已取消'
  }
  return '准备就绪'
}

function formatPrimaryNav(nav: PrimaryNav) {
  if (nav === 'analysis') {
    return '分析工作台'
  }
  if (nav === 'layers') {
    return '图层视图'
  }
  if (nav === 'history') {
    return '历史追踪'
  }
  return '计算扩展'
}

function formatPanelMode(mode: PanelMode) {
  if (mode === 'summary') {
    return '结果摘要'
  }
  if (mode === 'layers') {
    return '图层明细'
  }
  if (mode === 'history') {
    return '执行历史'
  }
  if (mode === 'compute') {
    return '计算工作区'
  }
  if (mode === 'sources') {
    return '数据源面板'
  }
  if (mode === 'export') {
    return '导出面板'
  }
  return '系统配置'
}

function syncUrl(sessionId: string, runId?: string, threadId?: string) {
  syncCleanWorkspaceUrl(sessionId, runId, threadId)
}

function mergeThreadRuns(currentRuns: AnalysisRun[], incomingRun: AnalysisRun) {
  // 线程运行合并
  //
  // 新 run 启动后先把它乐观并入当前 thread 视图，
  // 这样首页在 SSE 继续推进前也能保持对话连续。
  const byId = new Map<string, AnalysisRun>()
  for (const item of currentRuns) {
    byId.set(item.id, item)
  }
  byId.set(incomingRun.id, incomingRun)
  return [...byId.values()].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return left.id.localeCompare(right.id)
    }
    return leftTime - rightTime
  })
}

function classifyUploadFile(file: File): UploadReference['kind'] | undefined {
  if (isWeatherFile(file)) {
    return 'weather'
  }
  if (isLayerFile(file)) {
    return 'layer'
  }
  return undefined
}

function isLayerFile(file: File) {
  const name = file.name.toLowerCase()
  return [...LAYER_FILE_SUFFIXES].some((suffix) => name.endsWith(suffix))
}

function isWeatherFile(file: File) {
  const name = file.name.toLowerCase()
  return [...WEATHER_FILE_SUFFIXES].some((suffix) => name.endsWith(suffix))
}

function getUploadRelativePath(file: File) {
  const relativePath = 'webkitRelativePath' in file ? String(file.webkitRelativePath || '') : ''
  return relativePath || file.name
}

function makeUploadReferenceId(kind: UploadReference['kind'], relativePath: string, file: File) {
  return `${kind}:${relativePath}:${file.size}:${file.lastModified}`
}

function upsertUploadReference(current: UploadReference[], incoming: UploadReference) {
  const next = current.filter((item) => item.id !== incoming.id)
  return [incoming, ...next].slice(0, 80)
}

function mergeWeatherDataset(current: WeatherDatasetRecord[], incoming: WeatherDatasetRecord) {
  const byId = new Map(current.map((item) => [item.datasetId, item]))
  byId.set(incoming.datasetId, incoming)
  return [...byId.values()].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
}

function buildDataReferences({
  layers,
  weatherDatasets,
  uploadReferences,
  artifacts,
  threadRuns,
  currentThreadId,
}: {
  layers: LayerDescriptor[]
  weatherDatasets: WeatherDatasetRecord[]
  uploadReferences: UploadReference[]
  artifacts: ArtifactRef[]
  threadRuns: ReadonlyArray<AnalysisRun>
  currentThreadId?: string
}): DataReferenceSummary[] {
  // 数据引用摘要
  //
  // 聊天面板只展示当前 thread 关联的数据引用：上传队列、本 thread run
  // 产出的 artifact。session 级图层/气象数据只在有活跃 thread 时才展示，
  // 避免新建对话时看到旧 thread 的上传数据。
  const result: DataReferenceSummary[] = []
  const seen = new Set<string>()
  const weatherByName = new Map(weatherDatasets.map((dataset) => [dataset.filename, dataset]))
  const layerByName = new Map(layers.map((layer) => [layer.name, layer]))
  const threadArtifactIds = new Set(
    threadRuns.flatMap((item) => item.state.artifacts.map((artifact) => artifact.artifactId)),
  )

  for (const item of uploadReferences) {
    const key = `${item.kind}:${item.relativePath ?? item.name}`
    seen.add(key)
    seen.add(`${item.kind}:${item.name}`)
    const matchedWeather = item.kind === 'weather' ? weatherByName.get(item.name) : undefined
    const matchedLayer = item.kind === 'layer' ? layerByName.get(item.name) : undefined
    result.push({
      id: `upload:${item.id}`,
      kind: item.kind,
      name: item.name,
      status: matchedWeather ? formatWeatherStatusLabel(matchedWeather.status) : matchedLayer ? (matchedLayer.status === 'active' ? '可用' : matchedLayer.status) : uploadStatusLabel(item.status),
      detail: matchedWeather ? formatWeatherReferenceDetail(matchedWeather) : matchedLayer ? `${matchedLayer.featureCount ?? 0} 个对象 · ${matchedLayer.geometryType || '图层'}` : item.detail ?? formatReferenceKind(item.kind),
      relativePath: item.relativePath,
    })
  }

  // session 级图层和气象数据只在有活跃 thread 上下文时才展示；
  // 没有 thread 上下文时跳过，避免新建对话看到旧 thread 的数据。
  if (currentThreadId) {
    for (const dataset of weatherDatasets) {
      const key = `weather:${dataset.filename}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      result.push({
        id: `weather:${dataset.datasetId}`,
        kind: 'weather',
        name: dataset.filename,
        status: formatWeatherStatusLabel(dataset.status),
        detail: formatWeatherReferenceDetail(dataset),
      })
    }

    for (const layer of layers) {
      if (!layer.sessionId && !layer.sourceType.startsWith('session_') && layer.sourceType !== 'upload') {
        continue
      }
      const key = `layer:${layer.name}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      result.push({
        id: `layer:${layer.layerKey}`,
        kind: 'layer',
        name: layer.name,
        status: layer.status === 'active' ? '可用' : layer.status,
        detail: `${layer.featureCount ?? 0} 个对象 · ${layer.geometryType || '图层'}`,
      })
    }
  }

  for (const artifact of artifacts) {
    if (!threadArtifactIds.has(artifact.artifactId)) {
      continue
    }
    const key = `artifact:${artifact.artifactId}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push({
      id: key,
      kind: 'artifact',
      name: artifact.name,
      status: '结果',
      detail: artifact.artifactType === 'raster_png' ? '栅格结果' : artifact.artifactType,
    })
  }

  return result.slice(0, 80)
}

function formatWeatherReferenceDetail(dataset: WeatherDatasetRecord) {
  const variables = Array.isArray(dataset.metadata.variables) ? dataset.metadata.variables : []
  if (!variables.length && dataset.status === 'uploaded') {
    return '开始分析时解析'
  }
  const names = variables
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name?: unknown }).name ?? '') : ''))
    .filter(Boolean)
    .slice(0, 3)
  const variableLabel = names.length ? names.join(' / ') : '变量待识别'
  const mapReady = variables.filter((item) => Boolean((item as { mapReady?: unknown })?.mapReady)).length
  const analysisReady = variables.filter((item) => Boolean((item as { analysisReady?: unknown })?.analysisReady)).length
  const capabilityLabel = variables.length ? ` · ${analysisReady} 可统计 · ${mapReady} 可制图` : ''
  return `${variableLabel}${variables.length > names.length ? ` 等 ${variables.length} 个变量` : ''}${capabilityLabel}`
}

function formatReferenceKind(kind: UploadReference['kind']) {
  return kind === 'weather' ? '气象/雷达数据' : '空间图层'
}

function uploadStatusLabel(status: string) {
  if (status === 'pending') return '等待上传'
  if (status === 'uploading') return '上传中'
  if (status === 'ready') return '可用'
  return formatWeatherStatusLabel(status)
}

function formatWeatherUploadDetail(status: string) {
  if (status === 'uploaded') {
    return '已上传，开始分析时解析'
  }
  return formatWeatherStatusLabel(status)
}

function formatWeatherStatusLabel(status: string) {
  if (status === 'uploaded') return '已上传'
  if (status === 'completed') return '解析完成'
  if (status === 'failed') return '失败'
  if (status === 'running') return '解析中'
  if (status === 'queued') return '等待解析'
  return status || '已接入'
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${size} B`
}

async function retryAsync<T>(task: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt === retries) {
        break
      }
      await new Promise((resolve) => window.setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

type ProgressTodoItem = { id: string; content: string; status: string; activeForm: string }

function buildAgentTodoItems(
  agentState: AgentState | undefined,
  executionPlan: ExecutionPlan | undefined,
  runStatus?: AnalysisRun['status'],
): ProgressTodoItem[] {
  // Todo 面板只投影后端事实源。
  //
  // 优先使用 todo_write 写回的 AgentState.todos；如果计划模式只提交了
  // executionPlan，则把计划步骤作为只读任务清单展示，不额外发明进度。
  const rawTodos = agentState?.todos ?? []
  if (rawTodos.length) {
    return rawTodos
      .map((todo, index) => {
        const record = todo as typeof todo & Record<string, unknown>
        const content = String(record.title ?? record.content ?? `待办 ${index + 1}`)
        const activeForm = String(record.activeForm ?? record.active_form ?? record.description ?? content)
        return {
          id: String(record.todoId ?? record.todo_id ?? record.id ?? `todo:${index + 1}`),
          content,
          status: normalizeTodoStatus(String(record.status ?? 'pending')),
          activeForm,
        }
      })
      .filter((item) => item.content.trim())
  }

  const steps = executionPlan?.steps ?? []
  if (!steps.length) {
    return []
  }
  const completed = runStatus === 'completed'
  return steps.map((step, index) => ({
    id: step.id || `plan-step:${index + 1}`,
    content: step.reason || step.tool || `计划步骤 ${index + 1}`,
    status: completed ? 'completed' : index === 0 && runStatus === 'running' ? 'running' : 'pending',
    activeForm: step.tool ? `准备调用 ${step.tool}` : '准备执行计划步骤',
  }))
}

function normalizeTodoStatus(status: string) {
  if (status === 'in_progress' || status === 'doing') return 'running'
  if (status === 'done') return 'completed'
  return status || 'pending'
}

function buildProgressItems({
  runStatus,
  intent,
  executionPlan,
  artifacts,
  events,
}: {
  runStatus?: AnalysisRun['status']
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  artifacts: ArtifactRef[]
  events: RunEvent[]
}) {
  const latestEvent = events.at(-1)
  const hasWorkStarted = events.length > 0 || runStatus === 'running' || runStatus === 'completed'

  return [
    {
      id: 'understand',
      title: '理解需求',
      description:
        intent?.clarificationRequired
          ? '系统已经识别出问题，但还需要补充确认。'
          : intent
            ? '已识别本轮问题里的地点、对象和空间关系。'
            : '等待输入问题后开始整理分析意图。',
      status:
        runStatus === 'clarification_needed'
          ? ('warning' as const)
          : intent
            ? ('done' as const)
            : hasWorkStarted
              ? ('active' as const)
              : ('pending' as const),
    },
    {
      id: 'prepare',
      title: '准备数据',
      description:
        executionPlan?.steps.length
          ? `已经整理出 ${executionPlan.steps.length} 个分析步骤。`
          : '会按当前目录、上传图层或外部来源准备数据。',
      status: executionPlan?.steps.length ? ('done' as const) : hasWorkStarted ? ('active' as const) : ('pending' as const),
    },
    {
      id: 'analyze',
      title: '执行分析',
      description:
        runStatus === 'running'
          ? friendlyEventMessage(latestEvent)
          : runStatus === 'waiting_approval'
            ? '分析已经完成，系统正在等待你确认发布或执行敏感操作。'
          : artifacts.length
            ? '空间分析已经完成，结果正在整理。'
            : '需要空间计算时，会基于真实工具执行。',
      status:
        runStatus === 'running' || runStatus === 'waiting_approval'
          ? ('active' as const)
          : artifacts.length || runStatus === 'completed'
            ? ('done' as const)
            : runStatus === 'failed'
              ? ('warning' as const)
              : ('pending' as const),
    },
    {
      id: 'deliver',
      title: '交付结果',
      description:
        runStatus === 'completed'
          ? '结果图层、下载入口和服务链接已经生成。'
          : runStatus === 'waiting_approval'
            ? '结果已经生成，待审批动作会在确认后继续执行。'
          : runStatus === 'failed'
            ? '本次没有成功生成最终结果。'
            : '完成后会自动把结果高亮到地图上。',
      status:
        runStatus === 'completed'
          ? ('done' as const)
          : runStatus === 'waiting_approval'
            ? ('warning' as const)
          : runStatus === 'failed'
            ? ('warning' as const)
            : runStatus === 'running'
              ? ('active' as const)
              : ('pending' as const),
    },
  ] as const
}

function friendlyEventMessage(event?: RunEvent) {
  if (!event) {
    return '系统正在自动处理你的问题。'
  }
  if (event.type === 'intent.parsed') {
    return '正在识别地点、范围和目标数据。'
  }
  if (event.type === 'plan.ready') {
    return '分析步骤已经确定，马上开始计算。'
  }
  if (event.type === 'artifact.created') {
    return '已经生成新的地图结果，正在加入地图。'
  }
  if (event.type === 'approval.required') {
    return '分析结果已生成，正在等待审批。'
  }
  if (event.type === 'clarification.required') {
    return '需要你确认一个选项后继续。'
  }
  if (event.type === 'run.failed') {
    return '分析没有顺利完成，请稍后重试。'
  }
  return event.message
}

function describeCollectionGeometry(collection?: GeoJSON.FeatureCollection) {
  if (!collection?.features.length) {
    return '空图层'
  }
  const geometryTypes = Array.from(
    new Set(
      collection.features
        .map((feature) => feature.geometry?.type)
        .filter((value): value is NonNullable<GeoJSON.Geometry['type']> => Boolean(value)),
    ),
  )
  if (!geometryTypes.length) {
    return '未知几何'
  }
  return geometryTypes.join(' / ')
}

function parseRasterCoordinates(value: unknown): [[number, number], [number, number], [number, number], [number, number]] | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined
  }
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      return undefined
    }
    const lng = Number(point[0])
    const lat = Number(point[1])
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as [number, number] : undefined
  })
  return points.every(Boolean) ? points as [[number, number], [number, number], [number, number], [number, number]] : undefined
}

function describeRasterMetadata(metadata: Record<string, unknown>) {
  const variable = typeof metadata.variable === 'string' ? metadata.variable : '气象栅格'
  const valueRange = Array.isArray(metadata.valueRange) ? metadata.valueRange.map(Number).filter(Number.isFinite) : []
  if (valueRange.length >= 2) {
    return `${variable} · ${valueRange[0].toFixed(2)} - ${valueRange[1].toFixed(2)}`
  }
  return variable
}
