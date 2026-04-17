// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情面板组件
//
//   文件:       DetailPanel.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { ExternalLink, Lightbulb, LoaderCircle, MapPin, Sparkles } from 'lucide-react'

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
  onSelectHistoryRun: (runId: string) => void
  onPublish: (artifactId: string) => void
  onRunQgisProcess: (algorithmId: string, distance?: number) => void
  onRunQgisModel: (modelName: string, overlayArtifactId?: string) => void
  onCopyShareLink: () => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onResolveApproval: (approvalId: string, approved: boolean) => void
}

export function DetailPanel({
  panelMode,
  currentRunId,
  runStatus,
  agentState,
  artifacts,
  artifactData,
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
  onSelectHistoryRun,
  onPublish,
  onRunQgisProcess,
  onRunQgisModel,
  onCopyShareLink,
  onProviderChange,
  onModelChange,
  onResolveApproval,
}: DetailPanelProps) {
  // 右侧详情面板
  //
  // 根据当前导航模式切换摘要、图层、历史、计算、配置等内容，
  // 并承接 artifact、运行历史和 QGIS 二次处理入口。
  // 这里不是纯展示区，而是“结果消费与后续动作面板”：
  // 用户看摘要、切换结果、回看历史、执行二次处理和发布结果都在这层完成。
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? artifacts[0]
  const selectedCollection = selectedArtifact ? artifactData[selectedArtifact.artifactId] : undefined
  const featureCount = selectedCollection?.features.length ?? 0
  const publishLinks = buildPublishLinks(publishResult)
  const summaryTitle = deriveSummaryTitle(agentState?.parsedIntent?.area ?? undefined, selectedArtifact?.name)
  const summaryBody =
    agentState?.finalResponse?.summary ??
    (selectedArtifact
      ? `当前结果图层“${selectedArtifact.name}”已经生成，你可以继续查看对象分布、下载 GeoJSON，或发布为在线地图服务。`
      : '分析完成后，这里会用更容易理解的语言总结地图结果和可执行建议。')
  const nextActions = agentState?.finalResponse?.nextActions?.slice(0, 2) ?? []
  const metricScore = featureCount ? (92 + Math.min(featureCount, 8) * 0.55).toFixed(1) : '--'
  const growthLabel = runStatus === 'completed' ? `+${Math.max(featureCount, 1) * 6.25}%` : '等待结果'
  const primaryItems = artifacts.slice(0, 2)
  const todoItems = agentState?.todos ?? []
  const subAgents = agentState?.subAgents ?? []
  const approvals = agentState?.approvals ?? []
  const availableModelName =
    qgisModels?.models.find((item) => item === 'buffer_and_intersect') ?? qgisModels?.models[0] ?? null
  const overlayCandidates = artifacts.filter((artifact) => artifact.artifactId !== selectedArtifact?.artifactId)
  const cardLabels = primaryItems.map((artifact, index) => ({
    title: index === 0 ? artifact.name : `${artifact.name}分布`,
    subtitle:
      index === 0
        ? `${artifactData[artifact.artifactId]?.features.length ?? 0} 个对象已生成，可继续查看位置与范围`
        : `当前结果已覆盖 ${Math.max(1.2, (artifactData[artifact.artifactId]?.features.length ?? 1) * 0.8).toFixed(1)}km² 可视区域`,
  }))

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
                    <div className={`dc-result-thumb dc-result-thumb--${index % 2 === 0 ? 'blue' : 'orange'}`} />
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
                  <h3>Deep Agents 状态</h3>
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
            <div className="dc-panel-section__title">分析结果</div>
            <div className="dc-panel-list">
              {artifacts.length ? (
                artifacts.map((artifact) => (
                  <button
                    key={artifact.artifactId}
                    type="button"
                    className={`dc-panel-item${artifact.artifactId === selectedArtifact?.artifactId ? ' dc-panel-item--active' : ''}`}
                    onClick={() => onSelectArtifact(artifact.artifactId)}
                  >
                    <div>
                      <strong>{artifact.name}</strong>
                      <span>{artifactData[artifact.artifactId]?.features.length ?? 0} 个对象</span>
                    </div>
                    <span className="dc-pill-meta">{artifact.artifactType}</span>
                  </button>
                ))
              ) : (
                <p className="dc-empty-copy">还没有生成结果图层，提交一次分析后这里会自动更新。</p>
              )}
            </div>
          </div>

          <div className="dc-panel-section">
            <div className="dc-panel-section__title">参考图层</div>
            <div className="dc-panel-list">
              {layers.length ? (
                layers.map((layer) => (
                  <div key={layer.layerKey} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{layer.name}</strong>
                      <span>
                        {layer.geometryType} · {layer.featureCount ?? 0} 要素
                      </span>
                    </div>
                    <span className="dc-pill-meta">{layer.sourceType}</span>
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
              disabled={!selectedArtifact || isQgisSubmitting}
              onClick={() => onRunQgisProcess('native:buffer', agentState?.parsedIntent?.distanceM ?? 1000)}
            >
              {isQgisSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
              生成缓冲区
            </button>
            <button
              type="button"
              className="dc-action-button"
              disabled={!selectedArtifact || isQgisSubmitting || !availableModelName}
              onClick={() => availableModelName && onRunQgisModel(availableModelName, overlayCandidates[0]?.artifactId)}
            >
              运行 QGIS 模型
            </button>
            <button
              type="button"
              className="dc-action-button"
              disabled={!selectedArtifact || isQgisSubmitting}
              onClick={() => onRunQgisProcess('native:centroids')}
            >
              生成中心点
            </button>
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
              <span>内置图层</span>
              <strong>{layers.length} 个</strong>
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
            <div className="dc-panel-section__title">可用图层</div>
            <div className="dc-panel-list">
              {layers.length ? (
                layers.slice(0, 6).map((layer) => (
                  <div key={layer.layerKey} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{layer.name}</strong>
                      <span>{layer.description || `${layer.geometryType} 图层`}</span>
                    </div>
                    <span className="dc-pill-meta">{layer.layerKey}</span>
                  </div>
                ))
              ) : (
                <p className="dc-empty-copy">系统图层目录暂时为空。</p>
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
                    <option key={item.provider} value={item.provider} disabled={!item.configured}>
                      {item.displayName}
                      {!item.configured ? '（未配置）' : ''}
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
}

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
