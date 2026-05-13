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
  QgisModelsResponse,
  RunEvent,
  SessionRecord,
  SystemComponentsStatus,
  ToolDescriptor,
  UserIntent,
} from '@geo-agent-platform/shared-types'

import {
  createSession,
  deleteLayer,
  deleteThread,
  deleteToolCatalogEntry,
  getArtifactGeoJson,
  getArtifactMetadata,
  getRuntimeConfig,
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
  listQgisModels,
  publishArtifact,
  replaceManagedLayer,
  resolveApproval,
  runQgisModel,
  runQgisProcess,
  runTool,
  startAnalysis,
  startThreadRun,
  updateLayer,
  updateThread,
  upsertToolCatalogEntry,
  updateRuntimeConfig,
  uploadLayer,
} from './api'
import './App.css'
import { pickArtifactPublishResult, pickPreferredArtifactId } from './artifactSelection'
import { buildFadeUpMotion, buildListItemVariants, buildListVariants, motionSpring } from './motion'
import { deriveThreadTranscript, pickTranscriptHeadline } from './runTranscript'
import { useRunState } from './hooks/useRunState'
import { ChatPanel } from './components/ChatPanel'
import { DetailPanel } from './components/DetailPanel'
import { AppIcon, type AppIconName } from './components/AppIcon'
import { TopBar } from './components/TopBar'
import { supportsAgentSdkLiveSupervisor } from './providerCapabilities'
import { buildWorkspaceShareUrl, readWorkspacePointer, syncCleanWorkspaceUrl } from './workspacePointer'

type PrimaryNav = 'analysis' | 'layers' | 'history' | 'compute'
type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config'
type SidebarItemId = 'assistant' | 'query' | 'sources' | 'config' | 'export'
type MapLayerPreference = { visible: boolean; opacity: number }

interface MapRenderLayer {
  artifact: ArtifactRef
  data: GeoJSON.FeatureCollection
  visible: boolean
  opacity: number
  featureCount: number
  geometrySummary: string
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

const SAMPLE_QUERIES = [
  '巴黎地铁站 1 公里内有哪些医院',
  '我上传的这些点，哪些在柏林市区里',
  '帮我查一下 Springfield 在哪里',
] as const

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
  // 统一维护会话、运行状态、artifact、QGIS 工具、调试页数据和主工作台导航。
  // 这里本质上是前端的状态编排中心：负责把 API、SSE、URL、地图与调试页
  // 组织成一个稳定的工作台，而不是只渲染静态页面。
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [session, setSession] = useState<SessionRecord>()
  const [layers, setLayers] = useState<LayerDescriptor[]>([])
  const [basemaps, setBasemaps] = useState<BasemapDescriptor[]>([FALLBACK_BASEMAP])
  const [providers, setProviders] = useState<ModelProviderDescriptor[]>([])
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [qgisModels, setQgisModels] = useState<QgisModelsResponse>()
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
  const [toolRunResult, setToolRunResult] = useState<Record<string, unknown> | null>(null)
  const [isQgisSubmitting, setIsQgisSubmitting] = useState(false)
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
  const publishResult = useMemo(
    () => pickArtifactPublishResult(selectedArtifactId, artifacts, artifactMetadata),
    [artifactMetadata, artifacts, selectedArtifactId],
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
  const transcriptHeadline = pickTranscriptHeadline(transcriptEntries, run?.status)
  const selectedBasemap = useMemo(
    () => basemaps.find((item) => item.basemapKey === selectedBasemapKey) ?? basemaps[0] ?? FALLBACK_BASEMAP,
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
      const bundles = await Promise.all(
        artifactList.map(async (artifact) => {
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

      startTransition(() => {
        setArtifactData((current) => {
          const next = { ...current }
          for (const bundle of bundles) {
            next[bundle.artifactId] = bundle.data
          }
          return next
        })
        setArtifactMetadata((current) => {
          const next = { ...current }
          for (const bundle of bundles) {
            next[bundle.artifactId] = bundle.metadata
          }
          return next
        })
      })
    },
    [],
  )

  const refreshLayers = useCallback(async () => {
    const layerList = await listLayers()
    startTransition(() => {
      setLayers(layerList ?? [])
    })
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
        setPanelMode('layers')
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
    const currentIndex = SAMPLE_QUERIES.findIndex((item) => item === query)
    const nextQuery = SAMPLE_QUERIES[(currentIndex + 1 + SAMPLE_QUERIES.length) % SAMPLE_QUERIES.length]
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
        setQuery(SAMPLE_QUERIES[0])
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
    // URL 参数只作为“分享链接”读取一次；普通刷新恢复走 localStorage
    // 里的 active thread 指针。读取完成后会立刻清理地址栏，避免内部
    // session/thread/run 变成用户主界面的一部分。
    const searchParams = new URLSearchParams(window.location.search)
    const workspacePointer = readWorkspacePointer()
    const sharedSessionId = searchParams.get('session') ?? undefined
    const sharedThreadId = searchParams.get('thread') ?? undefined
    const sharedRunId = searchParams.get('run') ?? undefined
    const sessionId = sharedSessionId ?? workspacePointer.sessionId
    const threadId = sharedThreadId ?? workspacePointer.activeThreadId
    const runId = sharedRunId ?? workspacePointer.activeRunId

    void (async () => {
      try {
        const sessionPromise = retryAsync(
          () => (sessionId ? getSession(sessionId).catch(() => createSession()) : createSession()),
          2,
          300,
        )
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

        const threadToRestore = threadId || undefined
        const runToRestore = runId || undefined
        if (threadToRestore) {
          try {
            const threadPayload = await getThread(threadToRestore)
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
          } catch {
            clearActiveRunState()
            syncUrl(sessionRecord.id)
          }
        } else if (runToRestore) {
          try {
            await hydrateRunState(runToRestore)
          } catch {
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
  }, [clearActiveRunState, hydrateRunState, refreshSessionHistory, setUiError])

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

    void Promise.all([getSystemComponents(), listQgisModels(), listTools(), listToolCatalogEntries(), getRuntimeConfig()])
      .then(([components, modelList, tools, catalogEntries, loadedRuntimeConfig]) => {
        startTransition(() => {
          setSystemComponents(components)
          setQgisModels(modelList)
          setAvailableTools(tools ?? [])
          setToolCatalogEntries(catalogEntries ?? [])
          setRuntimeConfig(loadedRuntimeConfig)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '系统状态加载遇到问题，请稍后重试。'))
      })
  }, [location.pathname, panelMode, setUiError])

  const refreshToolingState = useCallback(async () => {
    // 调试页和 compute 面板共用这一条刷新路径，避免各自拉一套不同快照。
    const [components, modelList, tools, catalogEntries, loadedRuntimeConfig] = await Promise.all([
      getSystemComponents(),
      listQgisModels(),
      listTools(),
      listToolCatalogEntries(),
      getRuntimeConfig(),
    ])
    startTransition(() => {
      setSystemComponents(components)
      setQgisModels(modelList)
      setAvailableTools(tools ?? [])
      setToolCatalogEntries(catalogEntries ?? [])
      setRuntimeConfig(loadedRuntimeConfig)
    })
  }, [])

  // SSE 事件流由 useRunState 内部管理。
  // artifact.created / run.completed 的副作用（GeoJSON 加载、publish metadata）
  // 通过监听 events 的最后一个事件来处理。
  useEffect(() => {
    const last = events.at(-1)
    if (!last) return

    if (last.type === 'artifact.created' && last.payload) {
      const artifact = last.payload as unknown as ArtifactRef
      if (artifact?.artifactId) {
        void applyArtifactPayload([artifact]).then(() => {
          startTransition(() => {
            setSelectedArtifactId(artifact.artifactId)
          })
        })
      }
    }

    if (last.type === 'run.completed' || last.type === 'run.failed') {
      const payload = last.payload as Record<string, unknown> | undefined
      if (payload?.published && typeof payload.published === 'object' && payload.published !== null) {
        const published = payload.published as Record<string, unknown>
        const publishedArtifactId = typeof published.artifactId === 'string' ? published.artifactId : undefined
        if (publishedArtifactId) {
          startTransition(() => {
            setArtifactMetadata((current) => ({
              ...current,
              [publishedArtifactId]: {
                ...current[publishedArtifactId],
                publishResult: published,
              },
            }))
          })
        }
      }
    }
  }, [events, applyArtifactPayload])

  const submitMessage = useCallback(
    async ({
      text,
      clarificationOptionId,
      forceNewThread = false,
      updateComposer = false,
    }: {
      text?: string
      clarificationOptionId?: string | null
      forceNewThread?: boolean
      updateComposer?: boolean
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
        setArtifactData({})
        setArtifactMetadata({})
        setSelectedArtifactId(undefined)
        setToolRunResult(null)

        const createdRun = targetThreadId
          ? await startThreadRun(targetThreadId, submittedQuery, provider, model || undefined, clarificationOptionId)
          : await startAnalysis(session.id, submittedQuery, provider, model || undefined, clarificationOptionId)
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

  const handleSubmit = useCallback(async () => {
    if (!query.trim()) {
      return
    }
    await submitMessage()
  }, [query, submitMessage])

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
    startTransition(() => {
      setQuery('')
      clearActiveRunState()
      setThreadRuns([])
      setArtifactData({})
      setArtifactMetadata({})
      setSelectedArtifactId(undefined)
      setToolRunResult(null)
      setActiveThreadId(undefined)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
    })
    if (session?.id) {
      syncUrl(session.id)
    }
    focusQueryInput()
  }, [clearActiveRunState, focusQueryInput, session?.id])

  const handleUpload = useCallback(
    async (file: File) => {
      // 上传图层后立即刷新 session 和 layer catalog，
      // 这样 latest_upload 与图层面板能立刻反映新数据。
      if (!session) {
        return
      }

      try {
        setUiError(undefined)
        const descriptor = await uploadLayer(session.id, file)
        setUploadedLayerName(descriptor.name)
        setActiveNav('layers')
        setPanelMode('sources')
        setActiveSidebarItem('sources')
        const [sessionRecord, layerList] = await Promise.all([getSession(session.id), listLayers()])
        setSession(sessionRecord)
        setLayers(layerList ?? [])
      } catch (error) {
        setUiError(formatUiError(error, '图层上传没成功，请再试一次。'))
      }
    },
    [session, setUiError],
  )

  const handleImportManagedLayer = useCallback(
    async (file: File) => {
      try {
        setUiError(undefined)
        setActiveNav('layers')
        setPanelMode('sources')
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
        setPanelMode('sources')
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

  const handlePublish = useCallback(async (artifactId: string) => {
    // 发布结果后顺手刷新 system components，
    // 让详情面板里的服务状态和链接区与最新发布结果保持一致。
    try {
      setUiError(undefined)
      const result = await publishArtifact(artifactId, { projectKey: runtimeConfig?.defaultPublishProjectKey })
      setArtifactMetadata((current) => ({
        ...current,
        [artifactId]: {
          ...current[artifactId],
          publishResult: result,
        },
      }))
      setSystemComponents(await getSystemComponents())
    } catch (error) {
      setUiError(formatUiError(error, '发布没成功，请稍后重试。'))
    }
  }, [runtimeConfig?.defaultPublishProjectKey, setUiError])

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
  const onUploadStable = useStableVoid(handleUpload)
  const onSelectTaskStable = useStableVoid(handleSelectThread)
  const onRenameTaskStable = useStableVoid(handleRenameThread)
  const onDeleteTaskStable = useStableVoid(handleDeleteThread)
  const onResolveApprovalStable = useStableVoid(handleResolveApproval)

  const handleRunQgisProcess = useCallback(
    async (algorithmId: string, distance?: number) => {
      // 轻量 QGIS algorithm 调用入口
      //
      // 目前主要服务于详情面板里的二次处理按钮，因此默认基于当前选中的 artifact 执行。
      if (!selectedArtifactId || !run?.id) {
        return
      }

      try {
        setUiError(undefined)
        setIsQgisSubmitting(true)
        const result = await runQgisProcess({
          algorithmId,
          artifactId: selectedArtifactId,
          runId: run.id,
          saveAsArtifact: true,
          resultName: algorithmId === 'native:buffer' ? 'QGIS 缓冲结果' : 'QGIS 二次分析结果',
          inputs: distance ? { DISTANCE: distance } : {},
        })
        if (result.status === 'failed') {
          throw new Error(String(result.error || 'QGIS 处理失败。'))
        }
        await hydrateRunState(run.id)
      } catch (error) {
        setUiError(formatUiError(error, 'QGIS 处理没成功，请检查参数后再试。'))
      } finally {
        setIsQgisSubmitting(false)
      }
    },
    [hydrateRunState, run?.id, selectedArtifactId, setUiError],
  )

  const handleRunQgisModel = useCallback(
    async (modelName: string, overlayArtifactId?: string) => {
      // QGIS 模型调用入口
      //
      // 与 algorithm 调用相比，模型通常需要额外输入映射，因此这里保留少量
      // 面向 UI 的输入拼装逻辑，例如 overlay 和默认 DISTANCE。
      if (!selectedArtifactId || !run?.id) {
        return
      }

      try {
        setUiError(undefined)
        setIsQgisSubmitting(true)
        const inputs: Record<string, unknown> = {}
        if (overlayArtifactId) {
          inputs.OVERLAY = `artifact:${overlayArtifactId}`
        }
        if (modelName === 'buffer_and_intersect') {
          inputs.DISTANCE = 1000
        }
        const result = await runQgisModel({
          modelName,
          artifactId: selectedArtifactId,
          runId: run.id,
          saveAsArtifact: true,
          resultName: `QGIS 模型：${modelName}`,
          outputParameterName: 'output',
          inputs,
        })
        if (result.status === 'failed') {
          throw new Error(String(result.error || 'QGIS 模型执行失败。'))
        }
        await hydrateRunState(run.id)
      } catch (error) {
        setUiError(formatUiError(error, 'QGIS 模型没跑通，请检查参数后再试。'))
      } finally {
        setIsQgisSubmitting(false)
      }
    },
    [hydrateRunState, run?.id, selectedArtifactId, setUiError],
  )

  const handleRunTool = useCallback(
    async (tool: ToolDescriptor, args: Record<string, unknown>) => {
      // 调试页工具工作台统一入口
      //
      // 无论是 registry、qgis_algorithm 还是 qgis_model，都在这里统一调度，
      // 再把返回的 run 重新 hydrate 到主状态树。
      if (!session?.id) {
        return
      }

      try {
        setUiError(undefined)
        setIsQgisSubmitting(true)
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
        setIsQgisSubmitting(false)
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
    () =>
      artifacts
        .filter((artifact) => artifactData[artifact.artifactId])
        .map((artifact) => ({
          artifact,
          data: artifactData[artifact.artifactId],
          visible: mapLayerPreferences[artifact.artifactId]?.visible ?? true,
          opacity: mapLayerPreferences[artifact.artifactId]?.opacity ?? 0.9,
          featureCount: artifactData[artifact.artifactId]?.features.length ?? 0,
          geometrySummary: describeCollectionGeometry(artifactData[artifact.artifactId]),
        })),
    [artifactData, artifacts, mapLayerPreferences],
  )

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
                    await handlePublish(selectedArtifactId)
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
                    <div className="detail-label">GeoCanvas</div>
                    <h2 className="mt-1.5 text-xl font-bold text-slate-800 font-mono">工作空间</h2>
                    <p className="mt-2 text-[13px] text-slate-500 leading-relaxed">GIS 智能助手统一组织查询、分析、发布和审批。</p>
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
                      <strong className="detail-value">{artifacts.length+layers.length}对象</strong>
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
                        sessionThreads={sessionThreads}
                        transcriptEntries={transcriptEntries}
                        runtimeConfig={runtimeConfig}
                        availableTools={availableTools}
                        onQueryChange={setQuery}
                        onSubmit={onSubmitStable}
                        onNewConversation={handleNewConversation}
                        onFillSample={handleSampleSelect}
                        onSelectClarification={onSelectClarificationStable}
                        onUseTemplate={handleUseTemplate}
                        onUpload={onUploadStable}
                        onSelectArtifact={setSelectedArtifactId}
                        onSelectTask={onSelectTaskStable}
                        onRenameTask={onRenameTaskStable}
                        onDeleteTask={onDeleteTaskStable}
                        onResolveApproval={onResolveApprovalStable}
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
                        events={deferredEvents}
                        sessionRuns={sessionRuns}
                        progressItems={progressItems}
                        selectedArtifactId={selectedArtifactId}
                        publishResult={publishResult}
                        uploadedLayerName={uploadedLayerName}
                        selectedBasemapName={selectedBasemap.name}
                        provider={provider}
                        model={model}
                        providers={providers}
                        systemComponents={systemComponents}
                        qgisModels={qgisModels}
                        isQgisSubmitting={isQgisSubmitting}
                        onSelectArtifact={setSelectedArtifactId}
                        onToggleArtifactVisibility={handleToggleArtifactVisibility}
                        onChangeArtifactOpacity={handleArtifactOpacityChange}
                        onSelectHistoryRun={(runId) => {
                          void hydrateRunState(runId)
                          setPanelMode('history')
                          setActiveNav('history')
                        }}
                        onPublish={(artifactId) => {
                          void handlePublish(artifactId)
                        }}
                        onRunQgisProcess={(algorithmId, distance) => {
                          void handleRunQgisProcess(algorithmId, distance)
                        }}
                        onRunQgisModel={(modelName, overlayArtifactId) => {
                          void handleRunQgisModel(modelName, overlayArtifactId)
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
              isQgisSubmitting={isQgisSubmitting}
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
              intent={intent}
              executionPlan={executionPlan}
              agentState={agentState}
              artifacts={artifacts}
              artifactMetadata={artifactMetadata}
              selectedArtifactId={selectedArtifactId}
              publishResult={publishResult}
              toolRunResult={toolRunResult}
              toolCatalogEntries={toolCatalogEntries}
              runtimeConfig={runtimeConfig}
              systemComponents={systemComponents}
              qgisModels={qgisModels}
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
              onPublish={(artifactId) => {
                void handlePublish(artifactId)
              }}
              onRunQgisProcess={(algorithmId, distance) => {
                void handleRunQgisProcess(algorithmId, distance)
              }}
              onRunQgisModel={(modelName, overlayArtifactId) => {
                void handleRunQgisModel(modelName, overlayArtifactId)
              }}
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

const FALLBACK_BASEMAP: BasemapDescriptor = {
  basemapKey: 'osm',
  name: 'OpenStreetMap',
  provider: 'osm',
  kind: 'vector',
  attribution: '&copy; OpenStreetMap Contributors',
  tileUrls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  labelTileUrls: [],
  available: true,
  isDefault: true,
}
