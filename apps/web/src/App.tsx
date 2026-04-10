import { Suspense, lazy, startTransition, useDeferredValue, useEffect, useEffectEvent, useState } from 'react'
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
  apiBaseUrl,
  createSession,
  getArtifactGeoJson,
  getArtifactMetadata,
  getRun,
  getSession,
  getSystemComponents,
  listBasemaps,
  listLayers,
  listProviders,
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
import { DebugPage } from './components/DebugPage'
import { DetailPanel } from './components/DetailPanel'
import { TopBar } from './components/TopBar'

const MapCanvas = lazy(async () => {
  const module = await import('./components/MapCanvas')
  return { default: module.MapCanvas }
})

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
  const deferredEvents = useDeferredValue(events)

  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
  const publishStateLabel = publishResult ? '已生成' : '未发布'
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    executionPlan,
    artifacts,
    events: deferredEvents,
  })
  const heroTitle =
    run?.status === 'completed'
      ? '结果已经准备好，可以直接查看、下载或发布。'
      : run?.status === 'clarification_needed'
        ? '还差一步确认，地图分析就能继续。'
        : run?.status === 'running'
          ? '系统正在读取地图数据并完成空间分析。'
          : run?.status === 'failed'
            ? '这次分析没有完成，调整问题后可以重新试一次。'
            : '把你的空间问题直接说出来，地图会帮你回答。'
  const heroBody =
    run?.status === 'completed'
      ? '地图已经自动聚焦到结果区域，右侧可以继续下载结果或发布在线服务。'
      : '你可以直接输入问题、上传自己的数据，或者从左侧样例问题开始。'
  const selectedArtifactGeoJsonUrl = selectedArtifactId
    ? `${apiBaseUrl}/api/v1/results/${selectedArtifactId}/geojson`
    : undefined

  const hydrateRunState = useEffectEvent(async (runId: string) => {
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

    await Promise.all(
      latestRun.state.artifacts.map(async (artifact) => {
        const [data, metadataPayload] = await Promise.all([
          getArtifactGeoJson(artifact.artifactId),
          getArtifactMetadata(artifact.artifactId),
        ])
        startTransition(() => {
          setArtifactData((current) => ({ ...current, [artifact.artifactId]: data }))
          setArtifactMetadata((current) => ({
            ...current,
            [artifact.artifactId]: (metadataPayload.metadata as Record<string, unknown>) ?? {},
          }))
        })
      }),
    )
  })

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
            setSelectedBasemapKey(defaultBasemap.basemapKey)
          }
        })

        if (runId) {
          await hydrateRunState(runId)
        }
      } catch (error) {
        setUiError(error instanceof Error ? error.message : '初始化页面失败。')
      }
    })()

    void listLayers()
      .then((layerList) => {
        startTransition(() => {
          setLayers(layerList)
        })
      })
      .catch(() => {})
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
    if (location.pathname !== '/debug') {
      return
    }

    void Promise.all([getSystemComponents(), listQgisModels()])
      .then(([components, modelList]) => {
        startTransition(() => {
          setSystemComponents(components)
          setQgisModels(modelList)
        })
      })
      .catch(() => {})
  }, [location.pathname])

  useEffect(() => {
    if (!run?.id) {
      return
    }

    let source: EventSource | undefined
    let reconnectTimer: number | undefined

    const connect = () => {
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
            void Promise.all([getArtifactGeoJson(artifact.artifactId), getArtifactMetadata(artifact.artifactId)]).then(
              ([data, metadataPayload]) => {
                startTransition(() => {
                  setArtifacts((current) =>
                    current.some((item) => item.artifactId === artifact.artifactId) ? current : [...current, artifact],
                  )
                  setArtifactData((current) => ({ ...current, [artifact.artifactId]: data }))
                  setArtifactMetadata((current) => ({
                    ...current,
                    [artifact.artifactId]: (metadataPayload.metadata as Record<string, unknown>) ?? {},
                  }))
                  setSelectedArtifactId((current) => current ?? artifact.artifactId)
                })
              },
            )
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
              if (latestRun.status === 'running') {
                reconnectTimer = window.setTimeout(connect, 1500)
              }
            })
            .catch(() => {
              reconnectTimer = window.setTimeout(connect, 1500)
            })
        },
      )
    }

    connect()

    return () => {
      source?.close()
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }
    }
  }, [hydrateRunState, run?.id])

  async function handleSubmit() {
    if (!session || !query.trim()) {
      return
    }

    try {
      setUiError(undefined)
      setIsSubmitting(true)
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
      syncUrl(session.id, createdRun.id)
    } catch (error) {
      setUiError(error instanceof Error ? error.message : '任务提交失败。')
      setIsSubmitting(false)
    }
  }

  async function handleUpload(file: File) {
    if (!session) {
      return
    }

    try {
      setUiError(undefined)
      const descriptor = await uploadLayer(session.id, file)
      setUploadedLayerName(descriptor.name)
      const [sessionRecord, layerList] = await Promise.all([getSession(session.id), listLayers()])
      setSession(sessionRecord)
      setLayers(layerList)
    } catch (error) {
      setUiError(error instanceof Error ? error.message : '图层上传失败。')
    }
  }

  async function handlePublish(artifactId: string) {
    try {
      setUiError(undefined)
      const result = await publishArtifact(artifactId, { projectKey: 'demo-workspace' })
      setPublishResult(result)
      setSystemComponents(await getSystemComponents())
    } catch (error) {
      setUiError(error instanceof Error ? error.message : '发布失败。')
    }
  }

  async function handleRunQgisProcess(algorithmId: string, distance?: number) {
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
      setUiError(error instanceof Error ? error.message : 'QGIS 处理失败。')
    } finally {
      setIsQgisSubmitting(false)
    }
  }

  async function handleRunQgisModel(modelName: string, overlayArtifactId?: string) {
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
      setUiError(error instanceof Error ? error.message : 'QGIS 模型执行失败。')
    } finally {
      setIsQgisSubmitting(false)
    }
  }

  async function handleCopyShareLink() {
    const url = new URL(window.location.href)
    if (session?.id) {
      url.searchParams.set('session', session.id)
    }
    if (run?.id) {
      url.searchParams.set('run', run.id)
    }
    await navigator.clipboard.writeText(url.toString())
  }

  const mapLayers = artifacts
    .filter((artifact) => artifactData[artifact.artifactId])
    .map((artifact) => ({
      artifact,
      data: artifactData[artifact.artifactId],
    }))

  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="app-shell">
            <div className="app-shell__frame">
              <TopBar
                runStatus={run?.status}
                selectedArtifactId={selectedArtifactId}
                selectedArtifactName={selectedArtifact?.name}
                publishStateLabel={publishStateLabel}
                selectedArtifactGeoJsonUrl={selectedArtifactGeoJsonUrl}
                onCopyShareLink={() => {
                  void handleCopyShareLink()
                }}
                onPublishSelected={
                  selectedArtifactId
                    ? () => {
                        void handlePublish(selectedArtifactId)
                      }
                    : undefined
                }
              />

              <section className="overview-strip" aria-label="分析引导">
                <div className="overview-strip__intro">
                  <h2>{heroTitle}</h2>
                  <p>{heroBody}</p>
                </div>
                <div className="overview-strip__metrics">
                  <div className="overview-metric">
                    <span>当前状态</span>
                    <strong>{formatRunLabel(run?.status)}</strong>
                  </div>
                  <div className="overview-metric">
                    <span>结果数量</span>
                    <strong>{artifacts.length}</strong>
                  </div>
                  <div className="overview-metric">
                    <span>提醒事项</span>
                    <strong>{agentState?.warnings.length ?? 0}</strong>
                  </div>
                  <div className="overview-metric">
                    <span>发布状态</span>
                    <strong>{publishStateLabel}</strong>
                  </div>
                </div>
              </section>

              <main className="workspace">
                <ChatPanel
                  query={query}
                  isSubmitting={isSubmitting}
                  errorMessage={uiError}
                  uploadedLayerName={uploadedLayerName}
                  intent={intent}
                  progressItems={progressItems}
                  layers={layers}
                  onQueryChange={setQuery}
                  onSubmit={() => {
                    void handleSubmit()
                  }}
                  onFillSample={setQuery}
                  onUpload={(file) => {
                    void handleUpload(file)
                  }}
                />

                <section className="workspace-stage" aria-label="地图结果">
                  <div className="workspace-stage__header">
                    <div>
                      <h3>{selectedArtifact?.name ?? '结果会在地图上自动呈现'}</h3>
                      <p>
                        {selectedArtifact
                          ? `当前正在查看 ${selectedArtifact.name}。你可以切换底图、检查结果位置，并在右侧继续下载或发布。`
                          : '分析完成后，系统会自动把结果加到地图上，并聚焦到相关区域。'}
                      </p>
                    </div>
                    <div className="workspace-stage__tags">
                      <span>自动加图层</span>
                      <span>自动缩放到结果</span>
                      <span>支持下载与发布</span>
                    </div>
                  </div>

                  <Suspense fallback={<section className="map-shell map-shell--loading">地图组件加载中…</section>}>
                    <MapCanvas
                      basemaps={basemaps}
                      selectedBasemapKey={selectedBasemapKey}
                      onSelectBasemap={setSelectedBasemapKey}
                      layers={mapLayers}
                      selectedArtifactId={selectedArtifactId}
                      selectedArtifactName={selectedArtifact?.name}
                      layerCount={artifacts.length}
                      runStatus={run?.status}
                    />
                  </Suspense>
                </section>

                <DetailPanel
                  runStatus={run?.status}
                  agentState={agentState}
                  artifacts={artifacts}
                  artifactData={artifactData}
                  selectedArtifactId={selectedArtifactId}
                  publishResult={publishResult}
                  onSelectArtifact={setSelectedArtifactId}
                  onPublish={(artifactId) => {
                    void handlePublish(artifactId)
                  }}
                />
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
            onProviderChange={(value) => {
              setProvider(value)
              const selected = providers.find((item) => item.provider === value)
              setModel(selected?.defaultModel ?? '')
            }}
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
  )
}

export default App

function syncUrl(sessionId: string, runId: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('session', sessionId)
  url.searchParams.set('run', runId)
  window.history.replaceState({}, '', url)
}

function formatRunLabel(runStatus?: string) {
  if (runStatus === 'completed') {
    return '已完成'
  }
  if (runStatus === 'clarification_needed') {
    return '待确认'
  }
  if (runStatus === 'running') {
    return '分析中'
  }
  if (runStatus === 'failed') {
    return '未完成'
  }
  return '等待开始'
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
      title: '理解你的问题',
      description:
        intent?.clarificationRequired
          ? '系统已经识别出问题，但还需要你补充确认地点或范围。'
          : intent
            ? '系统已经识别出地点、目标数据和分析意图。'
            : '等待你输入问题后开始理解需求。',
      status:
        runStatus === 'clarification_needed'
          ? 'warning'
          : intent
            ? 'done'
            : hasWorkStarted
              ? 'active'
              : 'pending',
    },
    {
      id: 'prepare',
      title: '准备地图数据',
      description:
        executionPlan?.steps.length
          ? `已经准备好 ${executionPlan.steps.length} 个分析步骤。`
          : '系统会自动加载区域边界、参考图层或你上传的数据。',
      status: executionPlan?.steps.length ? 'done' : hasWorkStarted ? 'active' : 'pending',
    },
    {
      id: 'analyze',
      title: '执行空间分析',
      description:
        runStatus === 'running'
          ? friendlyEventMessage(latestEvent)
          : artifacts.length
            ? '空间分析已经完成，结果已开始整理。'
            : '系统会自动完成缓冲、相交、裁剪或点落区等分析。',
      status:
        runStatus === 'running'
          ? 'active'
          : artifacts.length || runStatus === 'completed'
            ? 'done'
            : runStatus === 'failed'
              ? 'warning'
              : 'pending',
    },
    {
      id: 'deliver',
      title: '整理结果并展示',
      description:
        runStatus === 'completed'
          ? '地图结果、下载入口和服务链接已经准备好。'
          : runStatus === 'failed'
            ? '本次没有成功生成最终结果。'
            : '完成后会自动在地图上高亮结果，并提供下载与发布入口。',
      status:
        runStatus === 'completed'
          ? 'done'
          : runStatus === 'failed'
            ? 'warning'
            : runStatus === 'running'
              ? 'active'
              : 'pending',
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
    return '已经生成新的地图结果，正在整理展示。'
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
