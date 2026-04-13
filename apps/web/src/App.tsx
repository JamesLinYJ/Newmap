import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'

import type {
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
  UserIntent,
} from '@geo-agent-platform/shared-types'

import {
  createSession,
  getArtifactGeoJson,
  getArtifactMetadata,
  getRun,
  getSession,
  getSystemComponents,
  listBasemaps,
  listLayers,
  listProviders,
  listSessionRuns,
  listQgisModels,
  openRunEventStream,
  publishArtifact,
  runQgisModel,
  runQgisProcess,
  startAnalysis,
  uploadLayer,
} from './api'
import './App.css'
import { ChatPanel } from './components/ChatPanel'
import { DetailPanel } from './components/DetailPanel'
import { MapCanvas } from './components/MapCanvas'
import { TopBar } from './components/TopBar'

type PrimaryNav = 'analysis' | 'layers' | 'history' | 'compute'
type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config'
type SidebarItemId = 'assistant' | 'query' | 'sources' | 'config' | 'export'

const DebugPage = lazy(() => import('./components/DebugPage').then((module) => ({ default: module.DebugPage })))

const SIDEBAR_ITEMS: Array<{ id: SidebarItemId; icon: string; label: string }> = [
  { id: 'assistant', icon: 'psychology', label: '智能指令' },
  { id: 'query', icon: 'explore', label: '空间查询' },
  { id: 'sources', icon: 'database', label: '数据源' },
  { id: 'config', icon: 'settings_account_box', label: '模型配置' },
  { id: 'export', icon: 'ios_share', label: '导出' },
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
  const location = useLocation()
  const [query, setQuery] = useState('查询巴黎地铁站 1 公里范围内的医院')
  const [session, setSession] = useState<SessionRecord>()
  const [run, setRun] = useState<AnalysisRun>()
  const [intent, setIntent] = useState<UserIntent>()
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan>()
  const [agentState, setAgentState] = useState<AgentState>()
  const [events, setEvents] = useState<RunEvent[]>([])
  const [layers, setLayers] = useState<LayerDescriptor[]>([])
  const [basemaps, setBasemaps] = useState<BasemapDescriptor[]>([FALLBACK_BASEMAP])
  const [providers, setProviders] = useState<ModelProviderDescriptor[]>([
    {
      provider: 'demo',
      displayName: 'Demo Heuristics',
      configured: true,
      defaultModel: null,
      capabilities: ['chat', 'structured', 'stream', 'repair_tool_json'],
    },
  ])
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [qgisModels, setQgisModels] = useState<QgisModelsResponse>()
  const [sessionRuns, setSessionRuns] = useState<AnalysisRun[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([])
  const [artifactData, setArtifactData] = useState<Record<string, GeoJSON.FeatureCollection>>({})
  const [artifactMetadata, setArtifactMetadata] = useState<Record<string, Record<string, unknown>>>({})
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [uploadedLayerName, setUploadedLayerName] = useState<string>()
  const [publishResult, setPublishResult] = useState<Record<string, unknown> | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isQgisSubmitting, setIsQgisSubmitting] = useState(false)
  const [uiError, setUiError] = useState<string>()
  const [provider, setProvider] = useState('demo')
  const [model, setModel] = useState('')
  const [selectedBasemapKey, setSelectedBasemapKey] = useState('osm')
  const [activeNav, setActiveNav] = useState<PrimaryNav>('analysis')
  const [panelMode, setPanelMode] = useState<PanelMode>('summary')
  const [activeSidebarItem, setActiveSidebarItem] = useState<SidebarItemId>('assistant')
  const deferredEvents = useDeferredValue(events)

  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    executionPlan,
    artifacts,
    events: deferredEvents,
  })
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
      const latestRun = await getRun(runId)

      startTransition(() => {
        setRun(latestRun)
        setAgentState(latestRun.state)
        setIntent(latestRun.state.parsedIntent)
        setExecutionPlan(latestRun.state.executionPlan)
        setArtifacts(latestRun.state.artifacts)
        setProvider(latestRun.modelProvider ?? 'demo')
        setModel(latestRun.modelName ?? '')
        const firstArtifact = latestRun.state.artifacts[0]?.artifactId
        if (firstArtifact) {
          setSelectedArtifactId((current) => current ?? firstArtifact)
        }
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
    void listProviders()
      .then((providerList) => {
        startTransition(() => {
          setProviders(providerList)
          const preferred =
            providerList.find((item) => item.provider === 'gemini' && item.configured) ??
            providerList.find((item) => item.provider === 'demo') ??
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
    if (location.pathname !== '/debug' && panelMode !== 'compute' && panelMode !== 'config') {
      return
    }

    void Promise.all([getSystemComponents(), listQgisModels()])
      .then(([components, modelList]) => {
        startTransition(() => {
          setSystemComponents(components)
          setQgisModels(modelList)
        })
      })
      .catch((error) => {
        setUiError(formatUiError(error, '系统组件状态加载失败。'))
      })
  }, [location.pathname, panelMode])

  useEffect(() => {
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
                setSelectedArtifactId((current) => current ?? artifact.artifactId)
              })
            })
          }

          if (event.type === 'warning.raised') {
            setUiError(undefined)
          }

          if (event.type === 'run.completed' || event.type === 'run.failed') {
            const payload = event.payload as Record<string, unknown> | undefined
            if (payload?.published) {
              startTransition(() => {
                setPublishResult(payload.published as Record<string, unknown>)
              })
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
    if (!session || !query.trim()) {
      return
    }

    try {
      setUiError(undefined)
      setIsSubmitting(true)
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      setPublishResult(null)
      setEvents([])
      setArtifacts([])
      setArtifactData({})
      setArtifactMetadata({})

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
  }, [model, provider, query, session])

  const handleUpload = useCallback(
    async (file: File) => {
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
    try {
      setUiError(undefined)
      const result = await publishArtifact(artifactId, { projectKey: 'demo-workspace' })
      setPublishResult(result)
      setSystemComponents(await getSystemComponents())
    } catch (error) {
      setUiError(formatUiError(error, '发布失败。'))
    }
  }, [])

  const handleRunQgisProcess = useCallback(
    async (algorithmId: string, distance?: number) => {
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

  const handleCopyShareLink = useCallback(async () => {
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
              <TopBar activeNav={activeNav} onNavChange={handleNavChange} onPrimaryAction={async () => {
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
              }} primaryActionLabel={primaryActionLabel} />

              <div className="digital-cartographer__body">
                <aside className="dc-sidebar" aria-label="工作空间导航">
                  <div className="dc-sidebar__intro">
                    <h2>工作空间</h2>
                    <p>GIS 智能助手</p>
                  </div>
                  <nav className="dc-sidebar__nav">
                    {SIDEBAR_ITEMS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={activeSidebarItem === item.id ? 'dc-sidebar__item dc-sidebar__item--active' : 'dc-sidebar__item'}
                        onClick={() => handleSidebarItemClick(item.id)}
                      >
                        <span className="material-symbols-outlined">{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </nav>
                </aside>

                <main className="dc-main">
                  <MapCanvas
                    basemaps={basemaps}
                    selectedBasemapKey={selectedBasemapKey}
                    onSelectBasemap={setSelectedBasemapKey}
                    layers={mapLayers}
                    selectedArtifactId={selectedArtifactId}
                    selectedArtifactName={selectedArtifact?.name}
                  >
                    <div className="dc-overlay-layout">
                      <ChatPanel
                        query={query}
                        isSubmitting={isSubmitting}
                        errorMessage={uiError}
                        uploadedLayerName={uploadedLayerName}
                        intent={intent}
                        progressItems={progressItems}
                        onQueryChange={setQuery}
                        onSubmit={() => {
                          void handleSubmit()
                        }}
                        onFillSample={handleSampleSelect}
                        onUseTemplate={handleUseTemplate}
                        onUpload={(file) => {
                          void handleUpload(file)
                        }}
                      />

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
                      />
                    </div>
                  </MapCanvas>
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
              provider={provider}
              model={model}
              providers={providers}
              layers={layers}
              events={deferredEvents}
              intent={intent}
              executionPlan={executionPlan}
              agentState={agentState}
              artifacts={artifacts}
              artifactMetadata={artifactMetadata}
              selectedArtifactId={selectedArtifactId}
              publishResult={publishResult}
              systemComponents={systemComponents}
              qgisModels={qgisModels}
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
            />
          }
        />
      </Routes>
    </Suspense>
  )
}

export default App

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
          : artifacts.length
            ? '空间分析已经完成，结果正在整理。'
            : '分析时会自动执行缓冲、相交、裁剪等操作。',
      status:
        runStatus === 'running'
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
          : runStatus === 'failed'
            ? '本次没有成功生成最终结果。'
            : '完成后会自动把结果高亮到地图上。',
      status:
        runStatus === 'completed'
          ? ('done' as const)
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
