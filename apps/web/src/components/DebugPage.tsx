import { ArrowLeft, ExternalLink, LoaderCircle, Play, Upload } from 'lucide-react'
import { Link } from 'react-router-dom'

import type {
  AgentState,
  ArtifactRef,
  ExecutionPlan,
  LayerDescriptor,
  ModelProviderDescriptor,
  QgisModelsResponse,
  RunEvent,
  SystemComponentsStatus,
  UserIntent,
} from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../api'
import { StatusPill } from './StatusPill'

interface DebugPageProps {
  query: string
  isSubmitting: boolean
  isQgisSubmitting: boolean
  uploadedLayerName?: string
  errorMessage?: string
  runStatus?: string
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  layers: LayerDescriptor[]
  events: RunEvent[]
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  agentState?: AgentState
  artifacts: ArtifactRef[]
  artifactMetadata: Record<string, Record<string, unknown>>
  selectedArtifactId?: string
  publishResult?: Record<string, unknown> | null
  systemComponents?: SystemComponentsStatus
  qgisModels?: QgisModelsResponse
  onQueryChange: (value: string) => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onSubmit: () => void
  onUpload: (file: File) => void
  onSelectArtifact: (artifactId: string) => void
  onPublish: (artifactId: string) => void
  onRunQgisProcess: (algorithmId: string, distance?: number) => void
  onRunQgisModel: (modelName: string, overlayArtifactId?: string) => void
}

export function DebugPage({
  query,
  isSubmitting,
  isQgisSubmitting,
  uploadedLayerName,
  errorMessage,
  runStatus,
  provider,
  model,
  providers,
  layers,
  events,
  intent,
  executionPlan,
  agentState,
  artifacts,
  artifactMetadata,
  selectedArtifactId,
  publishResult,
  systemComponents,
  qgisModels,
  onQueryChange,
  onProviderChange,
  onModelChange,
  onSubmit,
  onUpload,
  onSelectArtifact,
  onPublish,
  onRunQgisProcess,
  onRunQgisModel,
}: DebugPageProps) {
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
  const selectedMetadata = selectedArtifactId ? artifactMetadata[selectedArtifactId] : undefined
  const overlayCandidates = artifacts.filter((artifact) => artifact.artifactId !== selectedArtifactId)

  return (
    <div className="debug-shell">
      <header className="debug-shell__header">
        <div>
          <div className="panel__eyebrow">内部调试页</div>
          <h1>运行诊断与技术信息</h1>
          <p>这里保留模型、组件状态、原始计划、参数与 QGIS 二次分析入口。</p>
        </div>
        <div className="debug-shell__actions">
          <StatusPill
            label={
              runStatus === 'completed'
                ? '分析完成'
                : runStatus === 'clarification_needed'
                  ? '待澄清'
                  : runStatus === 'failed'
                    ? '失败'
                    : runStatus === 'running'
                      ? '执行中'
                      : '待命'
            }
            tone={
              runStatus === 'completed'
                ? 'success'
                : runStatus === 'clarification_needed'
                  ? 'warning'
                  : runStatus === 'failed'
                    ? 'danger'
                    : runStatus === 'running'
                      ? 'accent'
                      : 'neutral'
            }
          />
          <Link to="/" className="toolbar-button toolbar-button--ghost">
            <ArrowLeft size={16} aria-hidden="true" />
            返回用户页面
          </Link>
        </div>
      </header>

      <main className="debug-grid">
        <section className="panel">
          <div className="panel__header">
            <div>
              <div className="panel__eyebrow">调试输入</div>
              <h2>模型与分析提交</h2>
            </div>
          </div>
          <div className="panel__section">
            {errorMessage ? <div className="clarification-box clarification-box--error">{errorMessage}</div> : null}
            <div className="provider-grid">
              <div>
                <label className="composer__label" htmlFor="debug-provider-select">
                  模型 Provider
                </label>
                <select
                  id="debug-provider-select"
                  className="composer__select"
                  value={provider}
                  onChange={(event) => onProviderChange(event.target.value)}
                >
                  {providers.map((item) => (
                    <option key={item.provider} value={item.provider} disabled={!item.configured && item.provider !== 'demo'}>
                      {item.displayName}
                      {!item.configured && item.provider !== 'demo' ? '（未配置）' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="composer__label" htmlFor="debug-model-input">
                  模型名称
                </label>
                <input
                  id="debug-model-input"
                  className="composer__input"
                  value={model}
                  placeholder="留空则使用默认模型"
                  onChange={(event) => onModelChange(event.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="panel__section">
            <label className="composer__label" htmlFor="debug-query-input">
              空间问题
            </label>
            <textarea
              id="debug-query-input"
              className="composer__textarea"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <div className="composer__actions">
              <label className="toolbar-button toolbar-button--ghost upload-button" htmlFor="debug-layer-upload">
                <Upload size={16} aria-hidden="true" />
                上传图层
              </label>
              <input
                id="debug-layer-upload"
                type="file"
                accept=".geojson,.json,.gpkg"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    onUpload(file)
                  }
                  event.target.value = ''
                }}
              />
              <button className="toolbar-button toolbar-button--primary" type="button" onClick={onSubmit}>
                {isSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                提交分析
              </button>
            </div>
            {uploadedLayerName ? <p className="panel__muted">最近上传图层：{uploadedLayerName}</p> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel__header">
            <div>
              <div className="panel__eyebrow">系统状态</div>
              <h2>组件与图层</h2>
            </div>
          </div>
          {systemComponents ? (
            <div className="panel__section">
              <div className="intent-block">
                <div className="intent-row">
                  <span>Catalog</span>
                  <strong>{systemComponents.catalogBackend}</strong>
                </div>
                <div className="intent-row">
                  <span>PostGIS</span>
                  <strong>{systemComponents.postgisEnabled ? '已接入' : '未接入'}</strong>
                </div>
                <div className="intent-row">
                  <span>QGIS Runtime</span>
                  <strong>{systemComponents.qgisRuntimeAvailable ? '可用' : '不可用'}</strong>
                </div>
                <div className="intent-row">
                  <span>QGIS Server</span>
                  <strong>{systemComponents.qgisServerAvailable ? '在线' : '离线'}</strong>
                </div>
                <div className="intent-row">
                  <span>OGC API</span>
                  <strong>{systemComponents.ogcApiAvailable ? '可用' : '不可用'}</strong>
                </div>
              </div>
            </div>
          ) : null}
          <div className="panel__section">
            <div className="panel__subheader">
              <span>可用图层</span>
              <span className="panel__muted">{layers.length} 个</span>
            </div>
            <div className="layer-list">
              {layers.map((layer) => (
                <div key={layer.layerKey} className="layer-list__item">
                  <strong>{layer.name}</strong>
                  <p>
                    {layer.layerKey} · {layer.geometryType} · {layer.featureCount ?? 0} 要素
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel__header">
            <div>
              <div className="panel__eyebrow">原始状态</div>
              <h2>意图、计划与事件</h2>
            </div>
          </div>
          <div className="panel__section">
            <div className="panel__subheader">
              <span>解析意图</span>
            </div>
            <pre className="debug-pre">{intent ? JSON.stringify(intent, null, 2) : '暂无数据'}</pre>
          </div>
          <div className="panel__section">
            <div className="panel__subheader">
              <span>执行计划</span>
            </div>
            <pre className="debug-pre">{executionPlan ? JSON.stringify(executionPlan, null, 2) : '暂无数据'}</pre>
          </div>
          <div className="panel__section panel__section--grow">
            <div className="panel__subheader">
              <span>事件流</span>
              <span className="panel__muted">{events.length} 条</span>
            </div>
            <ol className="timeline">
              {events.length ? (
                events.map((event) => (
                  <li key={event.eventId} className="timeline__item">
                    <div className="timeline__marker" aria-hidden="true" />
                    <div className="timeline__content">
                      <div className="timeline__meta">
                        <span>{event.type}</span>
                        <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time>
                      </div>
                      <p>{event.message}</p>
                    </div>
                  </li>
                ))
              ) : (
                <li className="panel__empty">暂无事件。</li>
              )}
            </ol>
          </div>
        </section>

        <section className="panel">
          <div className="panel__header">
            <div>
              <div className="panel__eyebrow">产物与发布</div>
              <h2>Artifacts、元数据与 QGIS</h2>
            </div>
          </div>
          <div className="panel__section">
            <div className="artifact-list">
              {artifacts.map((artifact) => (
                <button
                  key={artifact.artifactId}
                  className={`artifact-list__item${
                    artifact.artifactId === selectedArtifactId ? ' artifact-list__item--active' : ''
                  }`}
                  type="button"
                  onClick={() => onSelectArtifact(artifact.artifactId)}
                >
                  <div>
                    <strong>{artifact.name}</strong>
                    <p>{artifact.artifactId}</p>
                  </div>
                </button>
              ))}
            </div>
            {selectedArtifact ? (
              <div className="artifact-actions">
                <a
                  className="toolbar-button toolbar-button--ghost"
                  href={`${apiBaseUrl}/api/v1/results/${selectedArtifact.artifactId}/geojson`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  打开 GeoJSON
                </a>
                <button className="toolbar-button toolbar-button--primary" type="button" onClick={() => onPublish(selectedArtifact.artifactId)}>
                  <ExternalLink size={16} aria-hidden="true" />
                  发布到 QGIS Server
                </button>
              </div>
            ) : null}
          </div>
          <div className="panel__section">
            <div className="panel__subheader">
              <span>artifact metadata</span>
            </div>
            <pre className="debug-pre">{selectedMetadata ? JSON.stringify(selectedMetadata, null, 2) : '暂无数据'}</pre>
          </div>
          <div className="panel__section">
            <div className="panel__subheader">
              <span>QGIS 二次分析</span>
              <span className="panel__muted">{qgisModels?.available ? '可用' : '不可用'}</span>
            </div>
            {systemComponents?.qgisRuntimeAvailable ? (
              <div className="debug-actions">
                <button
                  className="toolbar-button toolbar-button--ghost"
                  type="button"
                  disabled={!selectedArtifactId || isQgisSubmitting}
                  onClick={() => onRunQgisProcess('native:buffer', 1000)}
                >
                  {isQgisSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
                  运行 native:buffer
                </button>
                {(qgisModels?.models ?? []).map((modelName) => (
                  <button
                    key={modelName}
                    className="toolbar-button toolbar-button--ghost"
                    type="button"
                    disabled={!selectedArtifactId || isQgisSubmitting}
                    onClick={() => onRunQgisModel(modelName, overlayCandidates[0]?.artifactId)}
                  >
                    {isQgisSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
                    运行模型：{modelName}
                  </button>
                ))}
              </div>
            ) : (
              <p className="panel__empty">qgis-runtime 当前不可用。</p>
            )}
          </div>
          <div className="panel__section">
            <div className="panel__subheader">
              <span>发布返回值</span>
            </div>
            <pre className="debug-pre">{publishResult ? JSON.stringify(publishResult, null, 2) : '暂无数据'}</pre>
          </div>
          <div className="panel__section">
            <div className="panel__subheader">
              <span>完整 Agent 状态</span>
            </div>
            <pre className="debug-pre">{agentState ? JSON.stringify(agentState, null, 2) : '暂无数据'}</pre>
          </div>
        </section>
      </main>
    </div>
  )
}
