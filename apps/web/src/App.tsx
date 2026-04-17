// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 应用壳
//
//   文件:       App.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'

import type {
  AgentRuntimeConfig,
  AgentState,
  AnalysisRun,
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
  deleteToolCatalogEntry,
  getArtifactGeoJson,
  getArtifactMetadata,
  getRun,
  getRuntimeConfig,
  getSession,
  getSystemComponents,
  listBasemaps,
  listLayers,
  listProviders,
  listTools,
  listToolCatalogEntries,
  listSessionRuns,
  listQgisModels,
  openRunEventStream,
  publishArtifact,
  resolveApproval,
  runQgisModel,
  runQgisProcess,
  runTool,
  startAnalysis,
  upsertToolCatalogEntry,
  updateRuntimeConfig,
  uploadLayer,
} from './api'
import './App.css'
import { pickArtifactPublishResult, pickPreferredArtifactId } from './artifactSelection'
import { deriveRunTranscript, pickTranscriptHeadline } from './runTranscript'
import { ChatPanel } from './components/ChatPanel'
import { DetailPanel } from './components/DetailPanel'
import { AppIcon, type AppIconName } from './components/AppIcon'
import { MapCanvas } from './components/MapCanvas'
import { TopBar } from './components/TopBar'

type PrimaryNav = 'analysis' | 'layers' | 'history' | 'compute'
type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config'
type SidebarItemId = 'assistant' | 'query' | 'sources' | 'config' | 'export'

const DebugPage = lazy(() => import('./components/DebugPage').then((module) => ({ default: module.DebugPage })))

const SIDEBAR_ITEMS: Array<{ id: SidebarItemId; icon: AppIconName; label: string; shortLabel: string }> = [
  { id: 'assistant', icon: 'psychology', label: '智能指令', shortLabel: '助手' },
  { id: 'query', icon: 'explore', label: '空间查询', shortLabel: '查询' },
  { id: 'sources', icon: 'database', label: '数据源', shortLabel: '数据' },
  { id: 'config', icon: 'settings_account_box', label: '模型配置', shortLabel: '模型' },
  { id: 'export', icon: 'ios_share', label: '导出', shortLabel: '导出' },
] as const

const SAMPLE_QUERIES = [
  '查询巴黎地铁站 1 公里范围内的医院',
  '判断我上传的点是否落在柏林行政区内',
  '查询叫 Springfield 的区域',
] as const

function formatUiError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return fallback
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
  const [run, setRun] = useState<AnalysisRun>()
  const [intent, setIntent] = useState<UserIntent>()
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan>()
  const [agentState, setAgentState] = useState<AgentState>()
  const [events, setEvents] = useState<RunEvent[]>([])
  const [layers, setLayers] = useState<LayerDescriptor[]>([])
  const [basemaps, setBasemaps] = useState<BasemapDescriptor[]>([FALLBACK_BASEMAP])
  const [providers, setProviders] = useState<ModelProviderDescriptor[]>([])
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [qgisModels, setQgisModels] = useState<QgisModelsResponse>()
  const [availableTools, setAvailableTools] = useState<ToolDescriptor[]>([])
  const [toolCatalogEntries, setToolCatalogEntries] = useState<Array<Record<string, unknown>>>([])
  const [runtimeConfig, setRuntimeConfig] = useState<AgentRuntimeConfig>()
  const [sessionRuns, setSessionRuns] = useState<AnalysisRun[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([])
  const [artifactData, setArtifactData] = useState<Record<string, GeoJSON.FeatureCollection>>({})
  const [artifactMetadata, setArtifactMetadata] = useState<Record<string, Record<string, unknown>>>({})
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [uploadedLayerName, setUploadedLayerName] = useState<string>()
  const [toolRunResult, setToolRunResult] = useState<Record<string, unknown> | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isQgisSubmitting, setIsQgisSubmitting] = useState(false)
  const [isToolCatalogSubmitting, setIsToolCatalogSubmitting] = useState(false)
  const [uiError, setUiError] = useState<string>()
  const [provider, setProvider] = useState('gemini')
  const [model, setModel] = useState('')
  const [selectedBasemapKey, setSelectedBasemapKey] = useState('osm')
  const [activeNav, setActiveNav] = useState<PrimaryNav>('analysis')
  const [panelMode, setPanelMode] = useState<PanelMode>('summary')
  const [activeSidebarItem, setActiveSidebarItem] = useState<SidebarItemId>('assistant')
  const deferredEvents = useDeferredValue(events)

  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
  const publishResult = pickArtifactPublishResult(selectedArtifactId, artifacts, artifactMetadata)
  const providerLabel = providers.find((item) => item.provider === provider)?.displayName ?? provider
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    executionPlan,
    artifacts,
    events: deferredEvents,
  })
  const transcriptEntries = deriveRunTranscript({
    run,
    agentState,
    events: deferredEvents,
    artifacts,
    query,
    runtimeConfig,
  })
  const transcriptHeadline = pickTranscriptHeadline(transcriptEntries, run?.status)
  const selectedBasemap = basemaps.find((item) => item.basemapKey === selectedBasemapKey) ?? basemaps[0] ?? FALLBACK_BASEMAP
  const primaryActionLabel = selectedArtifactId ? '发布结果' : '开始分析'

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

  const hydrateRunState = useCallback(
    async (runId: string) => {
      // run 水合
      //
      // 当用户刷新页面、切换历史 run 或收到最终 SSE 事件时，
      // 都通过这一条路径把 run、intent、plan、artifacts 与历史记录重新对齐。
      const latestRun = await getRun(runId)

      startTransition(() => {
        setRun(latestRun)
        setAgentState(latestRun.state)
        setIntent(latestRun.state.parsedIntent)
        setExecutionPlan(latestRun.state.executionPlan)
        setArtifacts(latestRun.state.artifacts)
        setProvider(latestRun.modelProvider ?? 'gemini')
        setModel(latestRun.modelName ?? '')
        const preferredArtifactId = pickPreferredArtifactId(latestRun.state.artifacts)
        setSelectedArtifactId(preferredArtifactId)
      })

      if (latestRun.state.artifacts.length > 0) {
        await applyArtifactPayload(latestRun.state.artifacts)
      }

      if (latestRun.sessionId) {
        void listSessionRuns(latestRun.sessionId)
          .then((runs) => {
            startTransition(() => {
              setSessionRuns(runs)
            })
          })
          .catch(() => {})
      }

      return latestRun
    },
    [applyArtifactPayload],
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
      setQuery(value)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      focusQueryInput()
    },
    [focusQueryInput],
  )

  const handleUseTemplate = useCallback(() => {
    const currentIndex = SAMPLE_QUERIES.findIndex((item) => item === query)
    const nextQuery = SAMPLE_QUERIES[(currentIndex + 1 + SAMPLE_QUERIES.length) % SAMPLE_QUERIES.length]
    handleSampleSelect(nextQuery)
  }, [handleSampleSelect, query])

  const handleSidebarItemClick = useCallback(
    (itemId: SidebarItemId) => {
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
    // 优先恢复 URL 中的 session/run；如果没有则新建 session。
    // 同时加载 basemap 和图层目录，保证首页第一次进入就有完整工作台骨架。
    const searchParams = new URLSearchParams(window.location.search)
    const sessionId = searchParams.get('session')
    const runId = searchParams.get('run')

    void (async () => {
      try {
        const [sessionRecord, basemapList] = await Promise.all([
          sessionId ? getSession(sessionId) : createSession(),
          listBasemaps(),
        ])

        startTransition(() => {
          setSession(sessionRecord)
          const availableBasemaps = basemapList.filter((item) => item.available)
          if (availableBasemaps.length) {
            setBasemaps(availableBasemaps)
            const defaultBasemap = availableBasemaps.find((item) => item.isDefault) ?? availableBasemaps[0]
            setSelectedBasemapKey((current) =>
              availableBasemaps.some((item) => item.basemapKey === current) ? current : defaultBasemap.basemapKey,
            )
          }
        })

        void listSessionRuns(sessionRecord.id)
          .then((runs) => {
            startTransition(() => {
              setSessionRuns(runs)
            })
          })
          .catch(() => {})

        if (runId) {
          await hydrateRunState(runId)
        }
      } catch (error) {
        setUiError(formatUiError(error, '初始化页面失败。'))
      }
    })()

    void listLayers()
      .then((layerList) => {
        startTransition(() => {
          setLayers(layerList)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '图层目录加载失败。'))
      })
  }, [hydrateRunState])

  useEffect(() => {
    // 模型提供方初始化
    //
    // 独立于 session 初始化，避免 provider 列表加载失败时影响首页基础骨架。
    void listProviders()
      .then((providerList) => {
        startTransition(() => {
          setProviders(providerList)
          const preferred =
            providerList.find((item) => item.provider === 'gemini' && item.configured) ??
            providerList.find((item) => item.configured) ??
            providerList[0]

          if (preferred) {
            setProvider(preferred.provider)
            setModel(preferred.defaultModel ?? '')
          }
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void getRuntimeConfig()
      .then((loadedRuntimeConfig) => {
        startTransition(() => {
          setRuntimeConfig(loadedRuntimeConfig)
        })
      })
      .catch(() => {})
  }, [])

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
          setAvailableTools(tools)
          setToolCatalogEntries(catalogEntries)
          setRuntimeConfig(loadedRuntimeConfig)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '系统组件状态加载失败。'))
      })
  }, [location.pathname, panelMode])

  const refreshToolingState = useCallback(async () => {
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
      setAvailableTools(tools)
      setToolCatalogEntries(catalogEntries)
      setRuntimeConfig(loadedRuntimeConfig)
    })
  }, [])

  useEffect(() => {
    // SSE 事件订阅
    //
    // 只要当前存在运行中的 run，就持续监听事件流，并在断开时按需重连。
    // 这里同时负责把 intent、plan 和 artifact.created 等事件增量回灌进状态树。
    if (!run?.id) {
      return
    }

    let source: EventSource | undefined
    let reconnectTimer: number | undefined
    let disposed = false

    const connect = () => {
      if (disposed) {
        return
      }

      source = openRunEventStream(
        run.id,
        (event) => {
          startTransition(() => {
            setEvents((current) => {
              if (current.some((item) => item.eventId === event.eventId)) {
                return current
              }
              return [...current, event]
            })
          })

          if (event.type === 'intent.parsed') {
            startTransition(() => {
              setIntent(event.payload as unknown as UserIntent)
            })
          }

          if (event.type === 'plan.ready') {
            startTransition(() => {
              setExecutionPlan(event.payload as unknown as ExecutionPlan)
            })
          }

          if (event.type === 'artifact.created' && event.payload) {
            const artifact = event.payload as unknown as ArtifactRef
            if (!artifact?.artifactId) {
              return
            }

            void applyArtifactPayload([artifact]).then(() => {
              startTransition(() => {
                setArtifacts((current) =>
                  current.some((item) => item.artifactId === artifact.artifactId) ? current : [...current, artifact],
                )
                setSelectedArtifactId(artifact.artifactId)
              })
            })
          }

          if (event.type === 'warning.raised') {
            setUiError(undefined)
          }

          if (event.type === 'run.completed' || event.type === 'run.failed') {
            const payload = event.payload as Record<string, unknown> | undefined
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
            if (event.type === 'run.failed') {
              startTransition(() => {
                setUiError(String((payload?.errors as string[] | undefined)?.join('；') || event.message))
              })
            }
            void hydrateRunState(run.id)
            setIsSubmitting(false)
          }
        },
        () => {
          void getRun(run.id)
            .then((latestRun) => {
              startTransition(() => {
                setRun(latestRun)
              })
              if (!disposed && latestRun.status === 'running') {
                reconnectTimer = window.setTimeout(connect, 1500)
              }
            })
            .catch(() => {
              if (!disposed) {
                reconnectTimer = window.setTimeout(connect, 1500)
              }
            })
        },
      )
    }

    connect()

    return () => {
      disposed = true
      source?.close()
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }
    }
  }, [applyArtifactPayload, hydrateRunState, run?.id])

  const handleSubmit = useCallback(async () => {
    // 主分析提交流程
    //
    // 提交前会先清空上一个 run 的展示态，避免新旧结果叠在一起。
    if (!session || !query.trim()) {
      return
    }

    try {
      const selectedProvider = providers.find((item) => item.provider === provider)
      if (selectedProvider && !selectedProvider.configured) {
        setUiError(`${selectedProvider.displayName} 尚未配置，当前不能提交分析。`)
        return
      }
      setUiError(undefined)
      setIsSubmitting(true)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      setEvents([])
      setArtifacts([])
      setArtifactData({})
      setArtifactMetadata({})
      setSelectedArtifactId(undefined)
      setToolRunResult(null)

      const createdRun = await startAnalysis(session.id, query.trim(), provider, model || undefined)
      startTransition(() => {
        setRun(createdRun)
        setAgentState(createdRun.state)
        setIntent(createdRun.state.parsedIntent)
        setExecutionPlan(createdRun.state.executionPlan)
        setProvider(createdRun.modelProvider ?? provider)
        setModel(createdRun.modelName ?? model)
      })
      void listSessionRuns(session.id)
        .then((runs) => {
          startTransition(() => {
            setSessionRuns(runs)
          })
        })
        .catch(() => {})
      syncUrl(session.id, createdRun.id)
    } catch (error) {
      setUiError(formatUiError(error, '任务提交失败。'))
      setIsSubmitting(false)
    }
  }, [model, provider, providers, query, session])

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
        setLayers(layerList)
      } catch (error) {
        setUiError(formatUiError(error, '图层上传失败。'))
      }
    },
    [session],
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
      setUiError(formatUiError(error, '发布失败。'))
    }
  }, [runtimeConfig?.defaultPublishProjectKey])

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
        setUiError(formatUiError(error, approved ? '审批通过失败。' : '审批拒绝失败。'))
      }
    },
    [hydrateRunState, run?.id],
  )

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
        setUiError(formatUiError(error, 'QGIS 处理失败。'))
      } finally {
        setIsQgisSubmitting(false)
      }
    },
    [hydrateRunState, run?.id, selectedArtifactId],
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
        setUiError(formatUiError(error, 'QGIS 模型执行失败。'))
      } finally {
        setIsQgisSubmitting(false)
      }
    },
    [hydrateRunState, run?.id, selectedArtifactId],
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
            syncUrl(session.id, nextRunId)
          }
        }
      } catch (error) {
        setUiError(formatUiError(error, `${tool.label} 执行失败。`))
      } finally {
        setIsQgisSubmitting(false)
      }
    },
    [hydrateRunState, run?.id, session?.id],
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
    [refreshToolingState],
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
  }, [])

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
    [refreshToolingState],
  )

  const handleCopyShareLink = useCallback(async () => {
    // 分享链接只编码 session/run 两个关键上下文，
    // 这样页面恢复逻辑可以复用现有初始化路径，不需要额外的分享态协议。
    try {
      const url = new URL(window.location.href)
      if (session?.id) {
        url.searchParams.set('session', session.id)
      }
      if (run?.id) {
        url.searchParams.set('run', run.id)
      }
      await navigator.clipboard.writeText(url.toString())
    } catch {
      setUiError('复制分享链接失败，请稍后重试。')
    }
  }, [run?.id, session?.id])

  const handleProviderChange = useCallback(
    (value: string) => {
      setProvider(value)
      const selected = providers.find((item) => item.provider === value)
      setModel(selected?.defaultModel ?? '')
    },
    [providers],
  )

  const mapLayers = artifacts
    .filter((artifact) => artifactData[artifact.artifactId])
    .map((artifact) => ({
      artifact,
      data: artifactData[artifact.artifactId],
    }))

  return (
    <Suspense fallback={<div className="dc-route-loading">正在加载页面…</div>}>
      <Routes>
        <Route
          path="/"
          element={
            <div className="digital-cartographer">
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

              <div className="digital-cartographer__body">
                <aside className="dc-sidebar" aria-label="工作空间导航">
                  <div className="dc-sidebar__intro">
                    <div className="dc-sidebar__eyebrow">Agent Workspace</div>
                    <h2>工作空间</h2>
                    <p>GIS 智能助手会把查询、空间分析、发布和审批统一组织在同一个工作台里。</p>
                  </div>
                  <nav className="dc-sidebar__nav">
                    {SIDEBAR_ITEMS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={activeSidebarItem === item.id ? 'dc-sidebar__item dc-sidebar__item--active' : 'dc-sidebar__item'}
                        onClick={() => handleSidebarItemClick(item.id)}
                      >
                        <AppIcon name={item.icon} size={18} />
                        <span className="dc-sidebar__label dc-sidebar__label--full">{item.label}</span>
                        <span className="dc-sidebar__label dc-sidebar__label--compact">{item.shortLabel}</span>
                      </button>
                    ))}
                  </nav>
                  <div className="dc-sidebar__metrics" aria-label="工作空间概览">
                    <article className="dc-sidebar__metric-card">
                      <span>运行状态</span>
                      <strong>{formatTopBarRunStatus(run?.status)}</strong>
                      <p>{run?.id ? `任务 ${run.id.slice(0, 8)}…` : '等待新的分析请求'}</p>
                    </article>
                    <article className="dc-sidebar__metric-card">
                      <span>数据与底图</span>
                      <strong>
                        {artifacts.length + layers.length} 个对象
                      </strong>
                      <p>{selectedBasemap.name} · {uploadedLayerName ?? '未上传自定义数据'}</p>
                    </article>
                  </div>
                </aside>

                <main className="dc-main">
                  <section className="dc-workspace-bar" aria-label="当前工作台概览">
                    <article className="dc-workspace-bar__card">
                      <span>当前模式</span>
                      <strong>{formatPrimaryNav(activeNav)}</strong>
                      <p>{formatPanelMode(panelMode)} 已准备好承接当前任务。</p>
                    </article>
                    <article className="dc-workspace-bar__card">
                      <span>当前模型</span>
                      <strong>{providerLabel}</strong>
                      <p>{model || '使用默认模型'} · 正在处理当前分析任务</p>
                    </article>
                    <article className="dc-workspace-bar__card">
                      <span>空间结果</span>
                      <strong>{artifacts.length} 个产物</strong>
                      <p>{selectedArtifact?.name ?? '当前还没有选中的结果图层'}</p>
                    </article>
                    <article className="dc-workspace-bar__card">
                      <span>系统进度</span>
                      <strong>{transcriptHeadline.title}</strong>
                      <p>{transcriptHeadline.body}</p>
                    </article>
                  </section>
                  <div className="dc-main__workspace">
                    <div className="dc-main__assistant">
                      <ChatPanel
                        artifactCount={artifacts.length}
                        runStatus={run?.status}
                        providerLabel={providerLabel}
                        query={query}
                        currentRunId={run?.id}
                        runCreatedAt={run?.createdAt}
                        isSubmitting={isSubmitting}
                        errorMessage={uiError}
                        uploadedLayerName={uploadedLayerName}
                        intent={intent}
                        sessionRuns={sessionRuns}
                        transcriptEntries={transcriptEntries}
                        runtimeConfig={runtimeConfig}
                        onQueryChange={setQuery}
                        onSubmit={() => {
                          void handleSubmit()
                        }}
                        onFillSample={handleSampleSelect}
                        onUseTemplate={handleUseTemplate}
                        onUpload={(file) => {
                          void handleUpload(file)
                        }}
                        onSelectArtifact={setSelectedArtifactId}
                        onSelectTask={(runId) => {
                          void hydrateRunState(runId)
                          if (session?.id) {
                            syncUrl(session.id, runId)
                          }
                        }}
                        onResolveApproval={(approvalId, approved) => {
                          void handleResolveApproval(approvalId, approved)
                        }}
                      />
                    </div>

                    <div className="dc-main__map">
                      <MapCanvas
                        artifactCount={artifacts.length}
                        basemaps={basemaps}
                        runStatus={run?.status}
                        selectedBasemapKey={selectedBasemapKey}
                        onSelectBasemap={setSelectedBasemapKey}
                        layers={mapLayers}
                        selectedArtifactId={selectedArtifactId}
                        selectedArtifactName={selectedArtifact?.name}
                      />
                    </div>

                    <div className="dc-main__detail">
                      <DetailPanel
                        panelMode={panelMode}
                        currentRunId={run?.id}
                        runStatus={run?.status}
                        agentState={agentState}
                        artifacts={artifacts}
                        artifactData={artifactData}
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
                        onSelectHistoryRun={(runId) => {
                          void hydrateRunState(runId)
                          if (session?.id) {
                            syncUrl(session.id, runId)
                          }
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
                      />
                    </div>
                  </div>
                </main>
              </div>
            </div>
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

function syncUrl(sessionId: string, runId: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('session', sessionId)
  url.searchParams.set('run', runId)
  window.history.replaceState({}, '', url)
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
      title: '正在识别地点',
      description:
        intent?.clarificationRequired
          ? '系统已经识别出问题，但还需要补充确认。'
          : intent
            ? '地点、对象和目标图层已经识别完成。'
            : '等待输入问题后开始理解需求。',
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
      title: '正在加载边界',
      description:
        executionPlan?.steps.length
          ? `已经整理出 ${executionPlan.steps.length} 个分析步骤。`
          : '系统会自动加载边界、参考图层和上传数据。',
      status: executionPlan?.steps.length ? ('done' as const) : hasWorkStarted ? ('active' as const) : ('pending' as const),
    },
    {
      id: 'analyze',
      title: '正在计算范围',
      description:
        runStatus === 'running'
          ? friendlyEventMessage(latestEvent)
          : runStatus === 'waiting_approval'
            ? '分析已经完成，系统正在等待你确认发布或执行敏感操作。'
          : artifacts.length
            ? '空间分析已经完成，结果正在整理。'
            : '分析时会自动执行缓冲、相交、裁剪等操作。',
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
      title: '正在整理结果',
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
