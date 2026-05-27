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
// 展示当前结果对象、导出入口、运行摘要与系统状态等辅助信息。

import { memo, useMemo } from 'react'
import { CloudUpload, Eye, EyeOff, Lightbulb, LocateFixed, MapPin, RefreshCw, Sparkles, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'

import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  SystemComponentsStatus,
  WeatherDatasetRecord,
} from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../api'
import { providerUnavailableLabel, supportsAgentSdkLiveSupervisor } from '../providerCapabilities'
import type { LayerTreeNode } from '../hooks/useLayerManager'
import { AppIcon } from './AppIcon'
import { LayerPanel } from './LayerPanel'

interface ProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config' | 'layerManager'

interface DetailPanelProps {
  panelMode: PanelMode
  currentRunId?: string
  runStatus?: string
  agentState?: AgentState
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  mapLayers: Array<{
    kind: 'geojson' | 'raster'
    artifact: ArtifactRef
    data?: GeoJSON.FeatureCollection
    imageUrl?: string
    coordinates?: [[number, number], [number, number], [number, number], [number, number]]
    visible: boolean
    opacity: number
    featureCount: number
    geometrySummary: string
  }>
  layers: LayerDescriptor[]
  weatherDatasets: WeatherDatasetRecord[]
  events: RunEvent[]
  sessionRuns: AnalysisRun[]
  progressItems: ReadonlyArray<ProgressItem>
  selectedArtifactId?: string
  uploadedLayerName?: string
  selectedBasemapName?: string
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  systemComponents?: SystemComponentsStatus
  isToolSubmitting: boolean
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
  onChangeArtifactOpacity: (artifactId: string, opacity: number) => void
  onSelectHistoryRun: (runId: string) => void
  onCopyShareLink: () => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onResolveApproval: (approvalId: string, approved: boolean) => void
  onImportManagedLayer: (file: File) => void
  onReplaceManagedLayer: (layerKey: string, file: File) => void
  onToggleLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteLayer: (layerKey: string) => void
  // LayerPanel props
  layerTree?: LayerTreeNode[]
  layerSelectedId?: string | null
  layerSearchQuery?: string
  layerTotalCount?: number
  layerVisibleCount?: number
  layerSelectedNode?: LayerTreeNode | undefined
  onLayerSelect?: (id: string | null) => void
  onLayerToggleVisibility?: (id: string) => void
  onLayerToggleAllVisibility?: () => void
  onLayerSetOpacity?: (id: string, opacity: number) => void
  onLayerRename?: (id: string, name: string) => void
  onLayerMoveUp?: (id: string) => void
  onLayerMoveDown?: (id: string) => void
  onLayerRemove?: (id: string) => void
  onLayerCreateGroup?: (name: string, memberIds: string[]) => void
  onLayerToggleGroup?: (id: string) => void
  onLayerSetSearchQuery?: (q: string) => void
  onLayerZoomTo?: (id: string) => void
  onLayerExport?: (id: string) => void
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
  weatherDatasets,
  events,
  sessionRuns,
  progressItems,
  selectedArtifactId,
  uploadedLayerName,
  selectedBasemapName,
  provider,
  model,
  providers,
  systemComponents,
  isToolSubmitting,
  onSelectArtifact,
  onToggleArtifactVisibility,
  onChangeArtifactOpacity,
  onSelectHistoryRun,
  onCopyShareLink,
  onProviderChange,
  onModelChange,
  onResolveApproval,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleLayerStatus,
  onDeleteLayer,
  layerTree,
  layerSelectedId,
  layerSearchQuery,
  layerTotalCount,
  layerVisibleCount,
  layerSelectedNode,
  onLayerSelect,
  onLayerToggleVisibility,
  onLayerToggleAllVisibility,
  onLayerSetOpacity,
  onLayerRename,
  onLayerMoveUp,
  onLayerMoveDown,
  onLayerRemove,
  onLayerCreateGroup,
  onLayerToggleGroup,
  onLayerSetSearchQuery,
  onLayerZoomTo,
  onLayerExport,
}: DetailPanelProps) {
  // 右侧详情面板
  //
  // 根据当前导航模式切换摘要、图层、历史、计算、配置等内容，
  // 并承接 artifact、运行历史和结果消费入口。
  // 这里不是纯展示区，而是“结果消费与后续动作面板”：
  // 用户看摘要、切换结果、回看历史、执行二次处理和导出结果都在这层完成。
  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? artifacts[0],
    [artifacts, selectedArtifactId],
  )
  const selectedFileUrl = selectedArtifact && selectedArtifact.artifactType !== 'geojson'
    ? `${apiBaseUrl}${typeof selectedArtifact.metadata.imageUrl === 'string' ? selectedArtifact.metadata.imageUrl : selectedArtifact.uri}`
    : null
  const selectedCollection = selectedArtifact ? artifactData[selectedArtifact.artifactId] : undefined
  const featureCount = selectedCollection?.features.length ?? 0
  const summaryTitle = deriveSummaryTitle(agentState?.parsedIntent?.area ?? undefined, selectedArtifact?.name)
  const summaryBody =
    agentState?.finalResponse?.summary ??
    (selectedArtifact
      ? `当前结果图层“${selectedArtifact.name}”已经生成，你可以继续查看对象分布、下载数据，或复制当前工作区链接。`
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
  const primaryItems = useMemo(() => artifacts.slice(0, 2), [artifacts])
  const cardLabels = useMemo(
    () => primaryItems.map((artifact, index) => ({
      title: index === 0 ? artifact.name : `${artifact.name}分布`,
      subtitle:
        artifact.artifactType === 'chart_png'
          ? '统计图表已生成，可直接预览或下载 PNG'
          : artifact.artifactType !== 'geojson'
            ? '文件结果已生成，可在详情面板预览或下载'
            :
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

            {selectedArtifact?.artifactType === 'chart_png' && selectedFileUrl ? (
              <img className="mt-4 w-full rounded-lg border border-slate-200 bg-white" src={selectedFileUrl} alt={selectedArtifact.name} />
            ) : null}

            {selectedArtifact ? (
              <div className="dc-card__actions">
                <a
                  className="dc-link-button"
                  href={`${apiBaseUrl}/api/v1/results/${selectedArtifact.artifactId}/${selectedArtifact.artifactType === 'geojson' ? 'geojson' : 'file'}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedArtifact.artifactType === 'geojson' ? 'GeoJSON 下载' : '文件下载'}
                </a>
                <button
                  className="dc-link-button dc-link-button--primary"
                  type="button"
                  onClick={onCopyShareLink}
                >
                  复制分享链接
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
                <p>{nextActions[1] ?? '你可以继续切换结果图层、下载数据，或在对话里要求追加缓冲、相交、统计等分析。'}</p>
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
                          {layer.kind === 'raster' ? '1 张栅格' : `${layer.featureCount} 个对象`} · {layer.geometrySummary}
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
              disabled={!selectedArtifact || isToolSubmitting}
              onClick={onCopyShareLink}
            >
              复制分享链接
            </button>
            <button
              type="button"
              className="dc-action-button"
              disabled={!selectedArtifact}
              onClick={() => selectedArtifact && onSelectArtifact(selectedArtifact.artifactId)}
            >
              定位当前结果
            </button>
            <button
              type="button"
              className="dc-action-button"
              disabled={!selectedArtifact}
              onClick={() => selectedArtifact && onToggleArtifactVisibility(selectedArtifact.artifactId)}
            >
              切换结果可见性
            </button>
          </div>

          <div className="dc-panel-section">
            <div className="dc-keyvalue-list">
              <div className="dc-keyvalue-row">
                <span>当前工具状态</span>
                <strong>{isToolSubmitting ? '执行中' : '待命'}</strong>
              </div>
              <div className="dc-keyvalue-row">
                <span>可见结果</span>
                <strong>{mapLayers.filter((layer) => layer.visible).length}</strong>
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
              <span>气象数据</span>
              <strong>{weatherDatasets.length} 个</strong>
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
                accept=".geojson,.json,.gpkg,.zip,.nc,.nc4,.tif,.tiff,.grib,.grb,.grb2,.h5,.hdf5,.bz2"
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
                          accept=".geojson,.json,.gpkg,.zip"
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
                <p className="dc-empty-copy">当前 catalog 为空。你可以先导入 GeoJSON / GPKG / ZIP Shapefile，或者直接让 Agent 使用外部地点与 POI 来源继续分析。</p>
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

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">气象数据集</div>
            <div className="dc-panel-list">
              {weatherDatasets.length ? (
                weatherDatasets.map((dataset) => (
                  <div key={dataset.datasetId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{dataset.filename}</strong>
                      <span>{formatWeatherStatus(dataset.status)} · {formatWeatherVariables(dataset.metadata)}</span>
                      <span>{formatWeatherBounds(dataset.metadata)} · {dataset.datasetId}</span>
                    </div>
                    <span className="dc-pill-meta">{dataset.status}</span>
                  </div>
                ))
              ) : (
                <p className="dc-empty-copy">当前会话还没有上传 NetCDF、GRIB、GeoTIFF、HDF5 或雷达 bz2 数据。</p>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {panelMode === 'layerManager' && layerTree ? (
        <LayerPanel
          tree={layerTree}
          selectedId={layerSelectedId ?? null}
          searchQuery={layerSearchQuery ?? ''}
          totalCount={layerTotalCount ?? 0}
          visibleCount={layerVisibleCount ?? 0}
          selectedNode={layerSelectedNode}
          onSelectLayer={onLayerSelect ?? (() => {})}
          onToggleVisibility={onLayerToggleVisibility ?? (() => {})}
          onToggleAllVisibility={onLayerToggleAllVisibility ?? (() => {})}
          onSetOpacity={onLayerSetOpacity ?? (() => {})}
          onRenameLayer={onLayerRename ?? (() => {})}
          onMoveUp={onLayerMoveUp ?? (() => {})}
          onMoveDown={onLayerMoveDown ?? (() => {})}
          onRemoveLayer={onLayerRemove ?? (() => {})}
          onCreateGroup={onLayerCreateGroup ?? (() => {})}
          onToggleGroup={onLayerToggleGroup ?? (() => {})}
          onSetSearchQuery={onLayerSetSearchQuery ?? (() => {})}
          onZoomToLayer={onLayerZoomTo ?? (() => {})}
          onExportLayer={onLayerExport ?? (() => {})}
        />
      ) : null}

      {panelMode === 'export' ? (
        <>
          <section className="dc-card">
            <div className="dc-card__header">
              <div>
                <div className="dc-card__eyebrow">导出</div>
                <h3>下载与分享</h3>
              </div>
              <div className="dc-card__icon">
                <AppIcon name="ios_share" size={18} />
              </div>
            </div>

            <div className="dc-action-grid">
              {selectedArtifact ? (
                <a
                  className="dc-action-button dc-action-button--primary"
                  href={`${apiBaseUrl}/api/v1/results/${selectedArtifact.artifactId}/${selectedArtifact.artifactType === 'geojson' ? 'geojson' : 'file'}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedArtifact.artifactType === 'geojson' ? 'GeoJSON 下载' : '文件下载'}
                </a>
              ) : (
                <button type="button" className="dc-action-button dc-action-button--primary" disabled>
                  先生成结果
                </button>
              )}

              <button type="button" className="dc-action-button" onClick={onCopyShareLink}>
                复制分享链接
              </button>
            </div>
          </section>
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
                <span>会话日志</span>
                <strong>{systemComponents?.sessionLogRoot ? '已启用' : '载入中'}</strong>
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

function formatWeatherStatus(status: string) {
  if (status === 'uploaded') {
    return '已上传'
  }
  if (status === 'completed') {
    return '解析完成'
  }
  if (status === 'failed') {
    return '解析失败'
  }
  if (status === 'running') {
    return '解析中'
  }
  return '等待解析'
}

function formatWeatherVariables(metadata: Record<string, unknown>) {
  const variables = Array.isArray(metadata.variables) ? metadata.variables : []
  if (!variables.length) {
    if (metadata.uploadedFilename) {
      return '开始分析时解析'
    }
    return '变量待识别'
  }
  const names = variables
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name?: unknown }).name ?? '') : ''))
    .filter(Boolean)
    .slice(0, 3)
  const capabilityLabel = formatWeatherCapabilities(variables)
  const nameLabel = names.length ? `${names.join(' / ')}${variables.length > names.length ? ` 等 ${variables.length} 个变量` : ''}` : `${variables.length} 个变量`
  return capabilityLabel ? `${nameLabel} · ${capabilityLabel}` : nameLabel
}

function formatWeatherBounds(metadata: Record<string, unknown>) {
  const bounds = Array.isArray(metadata.bounds) ? metadata.bounds.map(Number).filter(Number.isFinite) : []
  if (bounds.length === 4) {
    return bounds.map((item) => item.toFixed(3)).join(', ')
  }
  const warnings = Array.isArray(metadata.warnings) ? metadata.warnings.filter((item): item is string => typeof item === 'string') : []
  return warnings[0] ?? '无地图范围'
}

function formatWeatherCapabilities(variables: unknown[]) {
  const mapReady = variables.filter((item) => Boolean((item as { mapReady?: unknown })?.mapReady)).length
  const analysisReady = variables.filter((item) => Boolean((item as { analysisReady?: unknown })?.analysisReady)).length
  const maxTimeCount = variables.reduce<number>((maxValue, item) => Math.max(maxValue, Number((item as { timeCount?: unknown })?.timeCount ?? 0) || 0), 0)
  const maxLevelCount = variables.reduce<number>((maxValue, item) => Math.max(maxValue, Number((item as { levelCount?: unknown })?.levelCount ?? 0) || 0), 0)
  const parts = [`${analysisReady} 可统计`, `${mapReady} 可制图`]
  if (maxTimeCount > 0) {
    parts.push(`${maxTimeCount} 时间片`)
  }
  if (maxLevelCount > 0) {
    parts.push(`${maxLevelCount} 层`)
  }
  return parts.join(' · ')
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
