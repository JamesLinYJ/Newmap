// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情面板组件
//
//   文件:       DetailPanel.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 展示当前结果对象、发布入口、运行摘要与系统状态等辅助信息。

import { memo, useMemo } from 'react'
import { CloudUpload, ExternalLink, Eye, EyeOff, Lightbulb, LoaderCircle, LocateFixed, MapPin, RefreshCw, Sparkles, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'

import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  LayerDescriptor,
  ModelProviderDescriptor,
  QgisModelsResponse,
  RunEvent,
  SystemComponentsStatus,
} from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../api'
import { providerUnavailableLabel, supportsAgentSdkLiveSupervisor } from '../providerCapabilities'
import { AppIcon } from './AppIcon'

interface ProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config'

interface DetailPanelProps {
  panelMode: PanelMode
  currentRunId?: string
  runStatus?: string
  agentState?: AgentState
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  mapLayers: Array<{
    artifact: ArtifactRef
    data: GeoJSON.FeatureCollection
    visible: boolean
    opacity: number
    featureCount: number
    geometrySummary: string
  }>
  layers: LayerDescriptor[]
  events: RunEvent[]
  sessionRuns: AnalysisRun[]
  progressItems: ReadonlyArray<ProgressItem>
  selectedArtifactId?: string
  publishResult?: Record<string, unknown> | null
  uploadedLayerName?: string
  selectedBasemapName?: string
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  systemComponents?: SystemComponentsStatus
  qgisModels?: QgisModelsResponse
  isQgisSubmitting: boolean
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
  onChangeArtifactOpacity: (artifactId: string, opacity: number) => void
  onSelectHistoryRun: (runId: string) => void
  onPublish: (artifactId: string) => void
  onRunQgisProcess: (algorithmId: string, distance?: number) => void
  onRunQgisModel: (modelName: string, overlayArtifactId?: string) => void
  onCopyShareLink: () => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onResolveApproval: (approvalId: string, approved: boolean) => void
  onImportManagedLayer: (file: File) => void
  onReplaceManagedLayer: (layerKey: string, file: File) => void
  onToggleLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteLayer: (layerKey: string) => void
}

export const DetailPanel = memo(function DetailPanel({
  panelMode,
  currentRunId,
  runStatus,
  agentState,
  artifacts,
  artifactData,
  mapLayers,
  layers,
  events,
  sessionRuns,
  progressItems,
  selectedArtifactId,
  publishResult,
  uploadedLayerName,
  selectedBasemapName,
  provider,
  model,
  providers,
  systemComponents,
  qgisModels,
  isQgisSubmitting,
  onSelectArtifact,
  onToggleArtifactVisibility,
  onChangeArtifactOpacity,
  onSelectHistoryRun,
  onPublish,
  onRunQgisProcess,
  onRunQgisModel,
  onCopyShareLink,
  onProviderChange,
  onModelChange,
  onResolveApproval,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleLayerStatus,
  onDeleteLayer,
}: DetailPanelProps) {
  // 右侧详情面板
  //
  // 根据当前导航模式切换摘要、图层、历史、计算、配置等内容，
  // 并承接 artifact、运行历史和 QGIS 二次处理入口。
  // 这里不是纯展示区，而是“结果消费与后续动作面板”：
  // 用户看摘要、切换结果、回看历史、执行二次处理和发布结果都在这层完成。
  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? artifacts[0],
    [artifacts, selectedArtifactId],
  )
  const selectedCollection = selectedArtifact ? artifactData[selectedArtifact.artifactId] : undefined
  const featureCount = selectedCollection?.features.length ?? 0
  const publishLinks = useMemo(() => buildPublishLinks(publishResult), [publishResult])
  const summaryTitle = deriveSummaryTitle(agentState?.parsedIntent?.area ?? undefined, selectedArtifact?.name)
  const summaryBody =
    agentState?.finalResponse?.summary ??
    (selectedArtifact
      ? `当前结果图层“${selectedArtifact.name}”已经生成，你可以继续查看对象分布、下载 GeoJSON，或发布为在线地图服务。`
      : '分析完成后，这里会用更容易理解的语言总结地图结果和可执行建议。')
  const nextActions = agentState?.finalResponse?.nextActions?.slice(0, 2) ?? []
  const metricScore = featureCount ? (92 + Math.min(featureCount, 8) * 0.55).toFixed(1) : '--'
  const growthLabel = runStatus === 'completed' ? `+${Math.max(featureCount, 1) * 6.25}%` : '等待结果'
  const todoItems = agentState?.todos ?? []
  const subAgents = agentState?.subAgents ?? []
  const approvals = agentState?.approvals ?? []
  const managedLayers = useMemo(
    () => layers.filter((layer) => !layer.sourceType.startsWith('session_') && layer.sourceType !== 'upload'),
    [layers],
  )
  const sessionUploadLayers = useMemo(
    () => layers.filter((layer) => layer.sourceType.startsWith('session_') || layer.sourceType === 'upload'),
    [layers],
  )
  const layerSummary = useMemo(() => buildLayerSummary(layers), [layers])
  const qgisRuntimeReady = systemComponents?.qgisRuntimeAvailable === true || qgisModels?.available === true
  const availableModelName =
    qgisModels?.models.find((item) => item === 'buffer_and_intersect') ?? qgisModels?.models[0] ?? null
  const overlayCandidates = useMemo(
    () => artifacts.filter((artifact) => artifact.artifactId !== selectedArtifact?.artifactId),
    [artifacts, selectedArtifact?.artifactId],
  )
  const primaryItems = useMemo(() => artifacts.slice(0, 2), [artifacts])
  const cardLabels = useMemo(
    () => primaryItems.map((artifact, index) => ({
      title: index === 0 ? artifact.name : `${artifact.name}分布`,
      subtitle:
        index === 0
          ? `${artifactData[artifact.artifactId]?.features.length ?? 0} 个对象已生成，可继续查看位置与范围`
          : `当前结果已覆盖 ${Math.max(1.2, (artifactData[artifact.artifactId]?.features.length ?? 1) * 0.8).toFixed(1)}km² 可视区域`,
    })),
    [primaryItems, artifactData],
  )

  return (
    <div className="dc-detail-column">
      {panelMode === 'summary' ? (
        <>
          <section className="dc-card dc-card--summary">
            <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">结果摘要</div>
                <h3>{summaryTitle}</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="analytics" size={18} />
              </div>
            </div>

            <div className="dc-metric-grid">
              <div className="dc-metric">
                <span>活跃指数</span>
                <strong>{metricScore}</strong>
              </div>
              <div className="dc-metric">
                <span>增长率</span>
                <strong className="dc-metric__accent">{growthLabel}</strong>
              </div>
            </div>

            <div className="dc-result-list">
              {primaryItems.length ? (
                primaryItems.map((artifact, index) => (
                  <button
                    key={artifact.artifactId}
                    className={`dc-result-item${artifact.artifactId === selectedArtifact?.artifactId ? ' dc-result-item--active' : ''}`}
                    type="button"
                    onClick={() => onSelectArtifact(artifact.artifactId)}
                  >
                    <div className={`dc-result-thumb dc-result-thumb--${index % 2 === 0 ? 'graphite' : 'orange'}`} />
                    <div className="dc-result-item__copy">
                      <strong>{cardLabels[index]?.title ?? artifact.name}</strong>
                      <span>{cardLabels[index]?.subtitle ?? `${artifactData[artifact.artifactId]?.features.length ?? 0} 个对象已就绪`}</span>
                    </div>
                  </button>
                ))
              ) : (
                <p className="dc-empty-copy">分析完成后，结果图层和摘要会出现在这里。</p>
              )}
            </div>

            {selectedArtifact ? (
              <div className="dc-card__actions">
                <a
                  className="dc-link-button"
                  href={`${apiBaseUrl}/api/v1/results/${selectedArtifact.artifactId}/geojson`}
                  target="_blank"
                  rel="noreferrer"
                >
                  GeoJSON 下载
                </a>
                <button className="dc-link-button dc-link-button--primary" type="button" onClick={() => onPublish(selectedArtifact.artifactId)}>
                  在线地图服务
                </button>
              </div>
            ) : null}
          </section>

          <section className="dc-card dc-card--suggestions">
            <div className="dc-card__eyebrow">智能建议</div>
            <div className="dc-advice-list">
              <article className="dc-advice">
                <div className="dc-advice__title">
                  <Lightbulb size={16} aria-hidden="true" />
                  <strong>结果解读</strong>
                </div>
                <p>{summaryBody}</p>
              </article>

              <article className="dc-advice">
                <div className="dc-advice__title">
                  <MapPin size={16} aria-hidden="true" />
                  <strong>{nextActions[0] ?? '下一步建议'}</strong>
                </div>
                <p>{nextActions[1] ?? '你可以继续切换结果图层、下载数据，或者把当前结果发布成在线地图服务。'}</p>
              </article>
            </div>
          </section>

          {todoItems.length || subAgents.length || approvals.length ? (
            <section className="dc-card">
              <div className="dc-card__header">
                <div>
                  <div className="dc-card__eyebrow">运行状态</div>
                  <h3>Agent SDK 状态</h3>
                </div>
                <div className="dc-card__icon">
                  <Sparkles size={18} aria-hidden="true" />
                </div>
              </div>

              {todoItems.length ? (
                <div className="dc-panel-section">
                  <div className="dc-panel-section__title">待办清单</div>
                  <div className="dc-panel-list">
                    {todoItems.slice(0, 4).map((todo) => (
                      <div key={todo.todoId} className="dc-panel-item dc-panel-item--static">
                        <div>
                          <strong>{todo.title}</strong>
                          <span>{todo.description ?? '系统正在持续更新这个待办的执行状态。'}</span>
                        </div>
                        <span className="dc-pill-meta">{todo.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {subAgents.length ? (
                <div className="dc-panel-section">
                  <div className="dc-panel-section__title">子智能体</div>
                  <div className="dc-panel-list">
                    {subAgents.map((agent) => (
                      <div key={agent.agentId} className="dc-panel-item dc-panel-item--static">
                        <div>
                          <strong>{agent.name}</strong>
                          <span>{agent.latestMessage ?? agent.summary}</span>
                        </div>
                        <span className="dc-pill-meta">{agent.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {approvals.length ? (
                <div className="dc-panel-section">
                  <div className="dc-panel-section__title">审批</div>
                  <div className="dc-panel-list">
                    {approvals.map((approval) => (
                      <div key={approval.approvalId} className="dc-panel-item dc-panel-item--static">
                        <div>
                          <strong>{approval.title}</strong>
                          <span>{approval.description}</span>
                        </div>
                        <div className="dc-card__actions">
                          <span className="dc-pill-meta">{approval.status}</span>
                          {approval.status === 'pending' ? (
                            <>
                              <button type="button" className="dc-link-button dc-link-button--primary" onClick={() => onResolveApproval(approval.approvalId, true)}>
                                批准
                              </button>
                              <button type="button" className="dc-link-button" onClick={() => onResolveApproval(approval.approvalId, false)}>
                                拒绝
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {publishLinks.length ? (
            <section className="dc-card dc-card--links">
              <div className="dc-card__eyebrow">发布链接</div>
              <div className="dc-service-list">
                {publishLinks.map((item) => (
                  <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className="dc-service-item">
                    <div>
                      <strong>{item.label}</strong>
                      <span>{item.description}</span>
                    </div>
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {panelMode === 'layers' ? (
        <section className="dc-card">
          <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">图层</div>
                <h3>结果与参考图层</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="layers" size={18} />
              </div>
            </div>

          <div className="dc-panel-section">
            <div className="dc-keyvalue-list dc-keyvalue-list--compact">
              <div className="dc-keyvalue-row">
                <span>图层总数</span>
                <strong>{layerSummary.total}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>活跃 / 停用</span>
                <strong>{layerSummary.active} / {layerSummary.inactive}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>目录 / 会话</span>
                <strong>{layerSummary.managed} / {layerSummary.session}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>要素总量</span>
                <strong>{layerSummary.features}</strong>
              </div>
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">分析结果</div>
            <div className="dc-layer-manager">
              {mapLayers.length ? (
                mapLayers.map((layer) => (
                  <article
                    key={layer.artifact.artifactId}
                    className={`dc-layer-manager__item${
                      layer.artifact.artifactId === selectedArtifact?.artifactId ? ' dc-layer-manager__item--active' : ''
                    }`}
                  >
                    <div className="dc-layer-manager__top">
                      <button type="button" className="dc-layer-manager__main" onClick={() => onSelectArtifact(layer.artifact.artifactId)}>
                        <strong>{layer.artifact.name}</strong>
                        <span>
                          {layer.featureCount} 个对象 · {layer.geometrySummary}
                        </span>
                      </button>
                      <div className="dc-layer-manager__actions">
                        <button
                          type="button"
                          className="dc-layer-manager__icon"
                          aria-label={layer.visible ? '隐藏图层' : '显示图层'}
                          onClick={() => onToggleArtifactVisibility(layer.artifact.artifactId)}
                        >
                          {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                        </button>
                        <button
                          type="button"
                          className="dc-layer-manager__icon"
                          aria-label="定位到图层"
                          onClick={() => onSelectArtifact(layer.artifact.artifactId)}
                        >
                          <LocateFixed size={15} />
                        </button>
                      </div>
                    </div>
                    <div className="dc-layer-manager__meta">
                      <span className="dc-pill-meta">{layer.artifact.artifactType}</span>
                      <span className="dc-pill-meta">{layer.visible ? '显示中' : '已隐藏'}</span>
                      <span className="dc-pill-meta">透明度 {Math.round(layer.opacity * 100)}%</span>
                    </div>
                    <label className="dc-layer-manager__slider">
                      <span>图层透明度</span>
                      <input
                        type="range"
                        min={20}
                        max={100}
                        step={5}
                        value={Math.round(layer.opacity * 100)}
                        onChange={(event) => onChangeArtifactOpacity(layer.artifact.artifactId, Number(event.target.value) / 100)}
                      />
                    </label>
                  </article>
                ))
              ) : (
                <p className="dc-empty-copy">还没有生成结果图层，提交一次分析后这里会自动更新。</p>
              )}
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">参考图层</div>
            <div className="dc-layer-reference-list">
              {layers.length ? (
                layers.map((layer) => (
                  <div key={layer.layerKey} className="dc-layer-reference">
                    <div className="dc-layer-reference__top">
                      <strong>{layer.name}</strong>
                      <span>
                        {layer.geometryType} · {layer.featureCount ?? 0} 要素 · {layerStatusLabel(layer.status)}
                      </span>
                    </div>
                    <div className="dc-layer-reference__meta">
                      <span className="dc-pill-meta">{layer.sourceType}</span>
                      <span className="dc-pill-meta">{layer.category || 'general'}</span>
                      <span className="dc-pill-meta">SRID {layer.srid}</span>
                      {(layer.tags ?? []).slice(0, 3).map((tag) => (
                        <span key={tag} className="dc-pill-meta">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="dc-layer-reference__meta">
                      <span className="dc-pill-meta">{formatLayerBounds(layer.bounds)}</span>
                      <span className="dc-pill-meta">更新 {formatLayerUpdated(layer.updatedAt)}</span>
                    </div>
                    {layer.analysisCapabilities.length ? (
                      <div className="dc-layer-reference__meta">
                        {layer.analysisCapabilities.slice(0, 4).map((capability) => (
                          <span key={capability} className="dc-pill-meta">
                            {capability}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {(layer.propertySchema ?? []).length ? (
                      <div className="dc-layer-fields">
                        {(layer.propertySchema ?? []).slice(0, 4).map((field) => (
                          <span key={field.name}>
                            {field.name} · {field.dataType} · {field.populatedCount}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <p>{layer.description}</p>
                    {layer.sourceConfigSummary ? <p>{layer.sourceConfigSummary}</p> : null}
                  </div>
                ))
              ) : (
                <p className="dc-empty-copy">当前没有可展示的参考图层。</p>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {panelMode === 'history' ? (
        <section className="dc-card">
          <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">历史</div>
                <h3>执行过程</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="history" size={18} />
              </div>
            </div>

          <div className="dc-timeline">
            {progressItems.map((item) => (
              <article key={item.id} className={`dc-timeline__item dc-timeline__item--${item.status}`}>
                <strong>{item.title}</strong>
                <p>{item.description}</p>
              </article>
            ))}
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">历史任务</div>
            <div className="dc-panel-list">
              {sessionRuns.length ? (
                sessionRuns.slice(0, 6).map((sessionRun) => (
                  <button
                    key={sessionRun.id}
                    type="button"
                    className={`dc-panel-item${sessionRun.id === currentRunId ? ' dc-panel-item--active' : ''}`}
                    onClick={() => onSelectHistoryRun(sessionRun.id)}
                  >
                    <div>
                      <strong>{sessionRun.userQuery}</strong>
                      <span>{formatRunMeta(sessionRun)}</span>
                    </div>
                    <span className="dc-pill-meta">{formatRunStatus(sessionRun.status)}</span>
                  </button>
                ))
              ) : (
                <p className="dc-empty-copy">当前会话还没有可回看的任务记录。</p>
              )}
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">运行事件</div>
            <div className="dc-panel-list">
              {events.length ? (
                [...events].reverse().slice(0, 8).map((event) => (
                  <div key={event.eventId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{event.message}</strong>
                      <span>{formatEventTime(event.timestamp)}</span>
                    </div>
                    <span className="dc-pill-meta">{event.type}</span>
                  </div>
                ))
              ) : (
                <p className="dc-empty-copy">开始分析后，这里会记录每一步的执行情况。</p>
              )}
            </div>
          </div>

          {todoItems.length ? (
            <div className="dc-panel-section">
              <div className="dc-panel-section__title">待办状态</div>
              <div className="dc-panel-list">
                {todoItems.map((todo) => (
                  <div key={todo.todoId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{todo.title}</strong>
                      <span>{todo.description ?? '系统会持续回写这个待办的执行信息。'}</span>
                    </div>
                    <span className="dc-pill-meta">{todo.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {subAgents.length ? (
            <div className="dc-panel-section">
              <div className="dc-panel-section__title">子智能体状态</div>
              <div className="dc-panel-list">
                {subAgents.map((agent) => (
                  <div key={agent.agentId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{agent.name}</strong>
                      <span>{agent.latestMessage ?? agent.summary}</span>
                    </div>
                    <span className="dc-pill-meta">{agent.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {panelMode === 'compute' ? (
        <section className="dc-card">
          <div className="dc-card__header">
            <div>
              <div className="dc-card__eyebrow">计算</div>
              <h3>继续处理当前结果</h3>
            </div>
            <div className="dc-card__icon">
              <Sparkles size={18} aria-hidden="true" />
            </div>
          </div>

          <div className="dc-action-grid">
            <button
              type="button"
              className="dc-action-button dc-action-button--primary"
              disabled={!selectedArtifact || isQgisSubmitting || !qgisRuntimeReady}
              onClick={() => onRunQgisProcess('native:buffer', agentState?.parsedIntent?.distanceM ?? 1000)}
            >
              {isQgisSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
              生成缓冲区
            </button>
            <button
              type="button"
              className="dc-action-button"
              disabled={!selectedArtifact || isQgisSubmitting || !availableModelName || !qgisRuntimeReady}
              onClick={() => availableModelName && onRunQgisModel(availableModelName, overlayCandidates[0]?.artifactId)}
            >
              运行 QGIS 模型
            </button>
            <button
              type="button"
              className="dc-action-button"
              disabled={!selectedArtifact || isQgisSubmitting || !qgisRuntimeReady}
              onClick={() => onRunQgisProcess('native:centroids')}
            >
              生成中心点
            </button>
          </div>

          <div className="dc-panel-section">
            <div className="dc-keyvalue-list">
              <div className="dc-keyvalue-row">
                <span>QGIS Runtime</span>
                <strong>{qgisRuntimeReady ? '可用' : '未就绪'}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>模型数量</span>
                <strong>{qgisModels?.models.length ?? 0}</strong>
              </div>
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">当前选择</div>
            <div className="dc-panel-list">
              {selectedArtifact ? (
                <div className="dc-panel-item dc-panel-item--static">
                  <div>
                    <strong>{selectedArtifact.name}</strong>
                    <span>{selectedCollection?.features.length ?? 0} 个对象可继续分析</span>
                  </div>
                  <span className="dc-pill-meta">当前结果</span>
                </div>
              ) : (
                <p className="dc-empty-copy">请先在“图层”或“结果摘要”中选择一个结果图层。</p>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {panelMode === 'sources' ? (
        <section className="dc-card">
          <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">数据源</div>
                <h3>当前数据概览</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="database" size={18} />
              </div>
            </div>

          <div className="dc-keyvalue-list">
            <div className="dc-keyvalue-row">
              <span>上传数据</span>
              <strong>{uploadedLayerName ?? '暂未上传'}</strong>
            </div>
            <div className="dc-keyvalue-row">
              <span>后台 catalog</span>
              <strong>{managedLayers.length} 个</strong>
            </div>
            <div className="dc-keyvalue-row">
              <span>当前底图</span>
              <strong>{selectedBasemapName ?? '标准地图'}</strong>
            </div>
            <div className="dc-keyvalue-row">
              <span>分析结果</span>
              <strong>{artifacts.length} 个</strong>
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">后台图层目录</div>
            <label className="dc-link-button dc-link-button--primary dc-layer-import">
              <CloudUpload size={14} aria-hidden="true" />
              导入后台图层
              <input
                type="file"
                accept=".geojson,.json,.gpkg"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    onImportManagedLayer(file)
                  }
                  event.currentTarget.value = ''
                }}
              />
            </label>
            <div className="dc-panel-list">
              {managedLayers.length ? (
                managedLayers.map((layer) => (
                  <div key={layer.layerKey} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{layer.name}</strong>
                      <span>{layer.description || `${layer.geometryType} 图层`} · {layer.category} · {layer.status}</span>
                      <span>{formatLayerBounds(layer.bounds)} · 更新 {formatLayerUpdated(layer.updatedAt)}</span>
                    </div>
                    <div className="dc-panel-item__actions">
                      <span className="dc-pill-meta">{layer.layerKey}</span>
                      <label className="dc-icon-button" title="替换数据" aria-label="替换数据">
                        <RefreshCw size={16} aria-hidden="true" />
                        <input
                          type="file"
                          accept=".geojson,.json,.gpkg"
                          hidden
                          onChange={(event) => {
                            const file = event.target.files?.[0]
                            if (file) {
                              onReplaceManagedLayer(layer.layerKey, file)
                            }
                            event.currentTarget.value = ''
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="dc-icon-button"
                        title={layer.status === 'active' ? '停用图层' : '启用图层'}
                        onClick={() => onToggleLayerStatus(layer.layerKey, layer.status === 'active' ? 'inactive' : 'active')}
                      >
                        {layer.status === 'active' ? <ToggleRight size={16} aria-hidden="true" /> : <ToggleLeft size={16} aria-hidden="true" />}
                      </button>
                      <button type="button" className="dc-icon-button dc-icon-button--danger" title="删除图层" onClick={() => onDeleteLayer(layer.layerKey)}>
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="dc-empty-copy">当前 catalog 为空。你可以先导入 GeoJSON / GPKG，或者直接让 Agent 使用外部地点与 POI 来源继续分析。</p>
              )}
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">会话上传</div>
            <div className="dc-panel-list">
              {sessionUploadLayers.length ? (
                sessionUploadLayers.map((layer) => (
                  <div key={layer.layerKey} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{layer.name}</strong>
                      <span>{layer.description || `${layer.geometryType} 图层`} · 当前会话</span>
                      <span>{formatLayerBounds(layer.bounds)} · {(layer.propertySchema ?? []).length} 个字段</span>
                    </div>
                    <span className="dc-pill-meta">{layer.layerKey}</span>
                  </div>
                ))
              ) : (
                <p className="dc-empty-copy">当前会话还没有临时上传图层。</p>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {panelMode === 'export' ? (
        <>
          <section className="dc-card">
            <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">导出</div>
                <h3>下载与发布</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="ios_share" size={18} />
              </div>
            </div>

            <div className="dc-action-grid">
              {selectedArtifact ? (
                <a
                  className="dc-action-button dc-action-button--primary"
                  href={`${apiBaseUrl}/api/v1/results/${selectedArtifact.artifactId}/geojson`}
                  target="_blank"
                  rel="noreferrer"
                >
                  GeoJSON 下载
                </a>
              ) : (
                <button type="button" className="dc-action-button dc-action-button--primary" disabled>
                  先生成结果
                </button>
              )}

              <button type="button" className="dc-action-button" disabled={!selectedArtifact} onClick={() => selectedArtifact && onPublish(selectedArtifact.artifactId)}>
                发布在线地图
              </button>

              <button type="button" className="dc-action-button" onClick={onCopyShareLink}>
                复制分享链接
              </button>
            </div>
          </section>

          {publishLinks.length ? (
            <section className="dc-card dc-card--links">
              <div className="dc-card__eyebrow">服务地址</div>
              <div className="dc-service-list">
                {publishLinks.map((item) => (
                  <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className="dc-service-item">
                    <div>
                      <strong>{item.label}</strong>
                      <span>{item.description}</span>
                    </div>
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {panelMode === 'config' ? (
        <>
          <section className="dc-card">
            <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">模型配置</div>
                <h3>当前分析引擎</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="tune" size={18} />
              </div>
            </div>

            <div className="dc-form-grid">
              <label className="dc-field">
                <span>模型 Provider</span>
                <select value={provider} onChange={(event) => onProviderChange(event.target.value)}>
                  {providers.map((item) => (
                    <option key={item.provider} value={item.provider} disabled={!supportsAgentSdkLiveSupervisor(item)}>
                      {item.displayName}
                      {providerUnavailableLabel(item)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="dc-field">
                <span>模型名称</span>
                <input value={model} placeholder="留空使用默认模型" onChange={(event) => onModelChange(event.target.value)} />
              </label>
            </div>
          </section>

          <section className="dc-card">
            <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">运行组件</div>
                <h3>系统状态</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="deployed_code" size={18} />
              </div>
            </div>

            <div className="dc-keyvalue-list">
              <div className="dc-keyvalue-row">
                <span>图层目录</span>
                <strong>{systemComponents?.catalogBackend ?? '载入中'}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>PostGIS</span>
                <strong>{systemComponents?.postgisEnabled ? '已接入' : '未接入'}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>QGIS Runtime</span>
                <strong>{systemComponents?.qgisRuntimeAvailable ? '可用' : '不可用'}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>QGIS Server</span>
                <strong>{systemComponents?.qgisServerAvailable ? '在线' : '未连接'}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>发布能力</span>
                <strong>{systemComponents?.publishCapabilities.join(' / ') || '载入中'}</strong>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {runStatus === 'failed' ? <div className="dc-error-banner">这次分析没有完成，请调整问题后重新尝试。</div> : null}
    </div>
  )
})

function deriveSummaryTitle(area?: string, artifactName?: string) {
  if (area) {
    return `${area}分析`
  }
  if (artifactName) {
    return artifactName
  }
  return '空间分析结果'
}

function buildPublishLinks(publishResult?: Record<string, unknown> | null) {
  if (!publishResult) {
    return [] as Array<{ label: string; description: string; href: string }>
  }

  const mapping = [
    ['geojsonUrl', 'GeoJSON 下载', '继续在 GIS 软件或脚本中使用'],
    ['wmsCapabilitiesUrl', 'WMS 服务', '适合地图叠加与展示'],
    ['wfsCapabilitiesUrl', 'WFS 服务', '适合继续获取矢量要素'],
    ['ogcApiCollectionsUrl', 'OGC API 集合', '查看发布的数据集合'],
  ] as const

  return mapping.flatMap(([key, label, description]) => {
    const value = publishResult[key]
    if (typeof value === 'string' && value.startsWith('http')) {
      return [{ label, description, href: value }]
    }
    return []
  })
}

function buildLayerSummary(layers: LayerDescriptor[]) {
  return layers.reduce(
    (summary, layer) => {
      const isSessionLayer = layer.sourceType.startsWith('session_') || layer.sourceType === 'upload'
      return {
        total: summary.total + 1,
        active: summary.active + (layer.status === 'active' ? 1 : 0),
        inactive: summary.inactive + (layer.status === 'active' ? 0 : 1),
        managed: summary.managed + (isSessionLayer ? 0 : 1),
        session: summary.session + (isSessionLayer ? 1 : 0),
        features: summary.features + (layer.featureCount ?? 0),
      }
    },
    { total: 0, active: 0, inactive: 0, managed: 0, session: 0, features: 0 },
  )
}

function layerStatusLabel(status: string) {
  if (status === 'active') {
    return '活跃'
  }
  if (status === 'inactive') {
    return '停用'
  }
  return status || '未知'
}

function formatLayerBounds(bounds?: [number, number, number, number] | null) {
  if (!bounds) {
    return '无边界'
  }
  return bounds.map((item) => item.toFixed(4)).join(', ')
}

function formatLayerUpdated(timestamp?: string | null) {
  if (!timestamp) {
    return '--'
  }
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatEventTime(timestamp: string) {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  })
}

function formatRunStatus(status: string) {
  if (status === 'completed') {
    return '已完成'
  }
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'failed') {
    return '失败'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'running') {
    return '执行中'
  }
  return '排队中'
}

function formatRunMeta(run: AnalysisRun) {
  const parsed = new Date(run.updatedAt)
  const stamp = Number.isNaN(parsed.getTime())
    ? run.updatedAt
    : parsed.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
  return `${stamp} · ${run.state.artifacts.length} 个结果`
}
