// +-------------------------------------------------------------------------
//
//   地理智能平台 - 调试工作台页面
//
//   文件:       DebugPage.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, LoaderCircle, Play, Save, Trash2, Upload, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'

import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ExecutionPlan,
  LayerDescriptor,
  ModelProviderDescriptor,
  QgisModelsResponse,
  RunEvent,
  SystemComponentsStatus,
  ToolDescriptor,
  ToolParameterDescriptor,
  UserIntent,
} from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../api'
import { StatusPill } from './StatusPill'

// DebugPageProps
//
// 汇总调试台所需的运行态、数据资产、工具清单与管理动作。
interface DebugPageProps {
  query: string
  isSubmitting: boolean
  isQgisSubmitting: boolean
  uploadedLayerName?: string
  errorMessage?: string
  runStatus?: string
  currentRunId?: string
  currentSessionId?: string
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  sessionRuns: AnalysisRun[]
  layers: LayerDescriptor[]
  events: RunEvent[]
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  agentState?: AgentState
  artifacts: ArtifactRef[]
  artifactMetadata: Record<string, Record<string, unknown>>
  selectedArtifactId?: string
  publishResult?: Record<string, unknown> | null
  toolRunResult?: Record<string, unknown> | null
  toolCatalogEntries: Array<Record<string, unknown>>
  systemComponents?: SystemComponentsStatus
  qgisModels?: QgisModelsResponse
  tools: ToolDescriptor[]
  isToolCatalogSubmitting?: boolean
  onQueryChange: (value: string) => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onSubmit: () => void
  onUpload: (file: File) => void
  onSelectArtifact: (artifactId: string) => void
  onPublish: (artifactId: string) => void
  onRunQgisProcess: (algorithmId: string, distance?: number) => void
  onRunQgisModel: (modelName: string, overlayArtifactId?: string) => void
  onRunTool: (tool: ToolDescriptor, args: Record<string, unknown>) => void
  onUpsertToolCatalogEntry: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDeleteToolCatalogEntry: (tool: ToolDescriptor) => void
}

export function DebugPage({
  query,
  isSubmitting,
  isQgisSubmitting,
  uploadedLayerName,
  errorMessage,
  runStatus,
  currentRunId,
  currentSessionId,
  provider,
  model,
  providers,
  sessionRuns,
  layers,
  events,
  intent,
  executionPlan,
  agentState,
  artifacts,
  artifactMetadata,
  selectedArtifactId,
  publishResult,
  toolRunResult,
  toolCatalogEntries,
  systemComponents,
  qgisModels,
  tools,
  isToolCatalogSubmitting,
  onQueryChange,
  onProviderChange,
  onModelChange,
  onSubmit,
  onUpload,
  onSelectArtifact,
  onPublish,
  onRunQgisProcess,
  onRunQgisModel,
  onRunTool,
  onUpsertToolCatalogEntry,
  onDeleteToolCatalogEntry,
}: DebugPageProps) {
  // 页面级派生状态
  //
  // 将 artifact 选择、工具表单默认值、概览指标、快速链接和 catalog 编辑态
  // 集中在组件顶部整理，避免 JSX 区域混入过多条件推导逻辑。
  // 调试页的目标不是做漂亮摘要，而是把一次运行里最关键的对象
  // 统一摆在同一页上：输入、状态、事件、数据资产、工具和目录配置。
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? artifacts[0]
  const selectedMetadata = selectedArtifact ? artifactMetadata[selectedArtifact.artifactId] : undefined
  const overlayCandidates = artifacts.filter((artifact) => artifact.artifactId !== selectedArtifact?.artifactId)
  const latestRuns = sessionRuns.slice(0, 5)
  const latestEvent = events.at(-1)
  const [selectedToolName, setSelectedToolName] = useState('')
  const [toolFormsByName, setToolFormsByName] = useState<Record<string, Record<string, string>>>({})
  const publishLinks = buildQuickLinks({
    currentSessionId,
    currentRunId,
    selectedArtifactId: selectedArtifact?.artifactId,
  })
  const collectionOptions = useMemo(() => buildCollectionOptions({ artifacts, layers }), [artifacts, layers])
  const groupedTools = useMemo(() => groupTools(tools), [tools])
  const selectedTool =
    tools.find((tool) => tool.name === selectedToolName) ??
    tools.find((tool) => tool.group === 'qgis' && tool.available) ??
    tools[0]
  const selectedToolCatalogEntry = selectedTool
    ? toolCatalogEntries.find(
        (entry) => String(entry.toolName ?? '') === selectedTool.name && String(entry.toolKind ?? '') === selectedTool.toolKind,
      )
    : undefined
  const toolFormValues = selectedTool ? toolFormsByName[selectedTool.name] ?? resolveToolDefaults(selectedTool) : {}
  const missingToolParameters = selectedTool ? getMissingRequiredParameters(selectedTool, toolFormValues) : []
  const qgisToolCount = tools.filter((tool) => tool.group === 'qgis').length
  const overviewItems: Array<{
    label: string
    value: string
    meta: string
    tone: 'neutral' | 'success' | 'warning' | 'accent' | 'danger'
  }> = [
    {
      label: '当前运行',
      value: formatRunStatus(runStatus),
      meta: currentRunId ? `Run ${shortId(currentRunId)}` : '等待提交',
      tone: deriveTone(runStatus),
    },
    {
      label: '数据资产',
      value: `${layers.length + artifacts.length}`,
      meta: `${layers.length} 个图层 · ${artifacts.length} 个结果`,
      tone: 'accent' as const,
    },
    {
      label: '模型路由',
      value: providers.find((item) => item.provider === provider)?.displayName ?? provider,
      meta: model || '使用默认模型',
      tone: 'neutral',
    },
    {
      label: '事件流',
      value: `${events.length}`,
      meta: events.at(-1)?.type ?? '暂无事件',
      tone: events.length ? 'success' : 'neutral',
    },
    {
      label: '工具工作台',
      value: `${tools.length}`,
      meta: `${qgisToolCount} 个 QGIS 工具`,
      tone: tools.length ? 'accent' : 'neutral',
    },
  ]

  return (
    <div className="debug-shell">
      <header className="debug-shell__header">
        <div>
          <div className="panel__eyebrow">内部调试页</div>
          <h1>运行诊断与数据管理台</h1>
          <p>这里聚合模型输入、数据资产、事件流、QGIS 操作与 API 快捷入口，方便你完整检查一次分析任务。</p>
        </div>
        <div className="debug-shell__actions">
          <StatusPill label={formatRunStatus(runStatus)} tone={deriveTone(runStatus)} />
          <Link to="/" className="toolbar-button toolbar-button--ghost">
            <ArrowLeft size={16} aria-hidden="true" />
            返回用户页面
          </Link>
        </div>
      </header>

      <section className="debug-overview">
        {overviewItems.map((item) => (
          <article key={item.label} className="overview-card">
            <div className="overview-card__label">{item.label}</div>
            <div className="overview-card__value">{item.value}</div>
            <div className="overview-card__footer">
              <StatusPill label={item.meta} tone={item.tone} />
            </div>
          </article>
        ))}
      </section>

      <main className="debug-columns">
        <div className="debug-column">
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
                <div className="panel__eyebrow">数据管理</div>
                <h2>会话、结果与 API 入口</h2>
              </div>
            </div>
            <div className="panel__section">
              <div className="inventory-grid">
                <div className="inventory-card">
                  <span>Session</span>
                  <strong>{currentSessionId ? shortId(currentSessionId) : '未创建'}</strong>
                  <p>{latestRuns.length} 条运行记录</p>
                </div>
                <div className="inventory-card">
                  <span>当前结果</span>
                  <strong>{selectedArtifact ? shortId(selectedArtifact.artifactId) : '--'}</strong>
                  <p>{selectedArtifact?.name ?? '未选择结果'}</p>
                </div>
                <div className="inventory-card">
                  <span>上传图层</span>
                  <strong>{uploadedLayerName ? '1' : '0'}</strong>
                  <p>{uploadedLayerName ?? '暂无上传文件'}</p>
                </div>
                <div className="inventory-card">
                  <span>产物总数</span>
                  <strong>{artifacts.length}</strong>
                  <p>{layers.length} 个系统图层可用</p>
                </div>
              </div>
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>最近运行</span>
                <span className="panel__muted">{latestRuns.length} 条</span>
              </div>
              <div className="mini-list">
                {latestRuns.length ? (
                  latestRuns.map((item) => (
                    <div key={item.id} className="mini-list__item">
                      <strong>{item.userQuery}</strong>
                      <p>
                        {shortId(item.id)} · {formatRunStatus(item.status)}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="panel__empty">当前会话还没有历史运行记录。</p>
                )}
              </div>
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>API 快捷入口</span>
                <span className="panel__muted">便于直接排查</span>
              </div>
              <div className="data-link-list">
                {publishLinks.map((item) => (
                  <a key={item.label} className="data-link" href={item.href} target="_blank" rel="noreferrer">
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.description}</p>
                    </div>
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">运行诊断</div>
                <h2>快速排查</h2>
              </div>
            </div>
            <div className="panel__section">
              <div className="intent-block">
                <div className="intent-row">
                  <span>QGIS 模型目录</span>
                  <strong>{qgisModels?.available ? `已加载 ${qgisModels.models.length} 个模型` : "当前不可用"}</strong>
                </div>
                <div className="intent-row">
                  <span>最新事件</span>
                  <strong>{latestEvent?.type ?? "暂无事件"}</strong>
                </div>
              </div>
              {qgisModels?.error ? <div className="clarification-box clarification-box--error">{qgisModels.error}</div> : null}
              {latestEvent?.message ? <p className="panel__muted">{latestEvent.message}</p> : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">工具工作台</div>
                <h2>自动发现的地理工具</h2>
              </div>
            </div>
            <div className="panel__section">
              <div className="tool-lab__toolbar">
                <div>
                  <label className="composer__label" htmlFor="debug-tool-select">
                    选择工具
                  </label>
                  <select
                    id="debug-tool-select"
                    className="composer__select"
                    value={selectedTool?.name ?? ''}
                    onChange={(event) => setSelectedToolName(event.target.value)}
                  >
                    {groupedTools.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.tools.map((tool) => (
                          <option key={`${tool.toolKind}:${tool.name}`} value={tool.name}>
                            {tool.label}
                            {!tool.available ? '（当前不可用）' : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="tool-lab__meta">
                  <StatusPill label={selectedTool ? `${selectedTool.group} · ${selectedTool.toolKind}` : '暂无工具'} tone="accent" />
                  <p>{selectedTool?.description ?? '当前还没有加载到工具元数据。'}</p>
                </div>
              </div>
            </div>
            {selectedTool ? (
              <>
                <div className="panel__section">
                  <div className="tool-lab__grid">
                    {selectedTool.parameters.map((parameter) => (
                      <ToolParameterField
                        key={`${selectedTool.name}:${parameter.key}`}
                        parameter={parameter}
                        value={toolFormValues[parameter.key] ?? ''}
                        collectionOptions={collectionOptions}
                        artifacts={artifacts}
                        layers={layers}
                        onChange={(value) => {
                          if (!selectedTool) {
                            return
                          }
                          setToolFormsByName((current) => ({
                            ...current,
                            [selectedTool.name]: {
                              ...(current[selectedTool.name] ?? resolveToolDefaults(selectedTool)),
                              [parameter.key]: value,
                            },
                          }))
                        }}
                      />
                    ))}
                  </div>
                  {selectedTool.error ? <div className="clarification-box clarification-box--error">{selectedTool.error}</div> : null}
                  {missingToolParameters.length ? (
                    <div className="clarification-box">
                      还缺少必填参数：{missingToolParameters.map((item) => item.label).join('、')}
                    </div>
                  ) : null}
                  <div className="composer__actions">
                    <button
                      className="toolbar-button toolbar-button--primary"
                      type="button"
                      disabled={!selectedTool.available || isQgisSubmitting || missingToolParameters.length > 0}
                      onClick={() => onRunTool(selectedTool, buildToolArgs(selectedTool, toolFormValues))}
                    >
                      {isQgisSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Wrench size={16} aria-hidden="true" />}
                      运行工具
                    </button>
                  </div>
                </div>
                <div className="panel__section">
                  <div className="panel__subheader">
                    <span>参数预览</span>
                    <span className="panel__muted">{selectedTool.parameters.length} 个参数</span>
                  </div>
                  <pre className="debug-pre">{JSON.stringify(buildToolArgs(selectedTool, toolFormValues), null, 2)}</pre>
                </div>
              </>
            ) : null}
            <div className="panel__section">
              <div className="panel__subheader">
                <span>最近工具结果</span>
              </div>
              <pre className="debug-pre">{toolRunResult ? JSON.stringify(toolRunResult, null, 2) : '暂无数据'}</pre>
            </div>
            {selectedTool ? (
              <div className="panel__section">
                <div className="panel__subheader">
                  <span>Tool Catalog</span>
                  <span className="panel__muted">
                    {selectedToolCatalogEntry ? `${selectedTool.toolKind}/${selectedTool.name}` : '当前无 override'}
                  </span>
                </div>
                <ToolCatalogEditor
                  key={`${selectedTool.toolKind}:${selectedTool.name}:${selectedToolCatalogEntry?.sortOrder ?? 'new'}`}
                  tool={selectedTool}
                  entry={selectedToolCatalogEntry}
                  isSubmitting={Boolean(isToolCatalogSubmitting)}
                  onSave={onUpsertToolCatalogEntry}
                  onDelete={onDeleteToolCatalogEntry}
                />
                <p className="panel__muted">这里只管理 Postgres 里的目录与展示配置，不会修改工具的实际执行逻辑。</p>
              </div>
            ) : null}
          </section>
        </div>

        <div className="debug-column">
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
                {layers.length ? (
                  layers.map((layer) => (
                    <div key={layer.layerKey} className="layer-list__item">
                      <div>
                        <strong>{layer.name}</strong>
                        <p>
                          {layer.layerKey} · {layer.geometryType} · {layer.featureCount ?? 0} 要素
                        </p>
                      </div>
                      <StatusPill label={layer.sourceType} tone="neutral" />
                    </div>
                  ))
                ) : (
                  <p className="panel__empty">当前没有可展示图层。</p>
                )}
              </div>
            </div>
          </section>
        </div>

        <div className="debug-column">
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
              <div className="panel__subheader">
                <span>结果清单</span>
                <span className="panel__muted">{artifacts.length} 个</span>
              </div>
              <div className="artifact-list">
                {artifacts.length ? (
                  artifacts.map((artifact) => (
                    <button
                      key={artifact.artifactId}
                      className={`artifact-list__item${
                        artifact.artifactId === selectedArtifact?.artifactId ? ' artifact-list__item--active' : ''
                      }`}
                      type="button"
                      onClick={() => onSelectArtifact(artifact.artifactId)}
                    >
                      <div>
                        <strong>{artifact.name}</strong>
                        <p>{artifact.artifactId}</p>
                      </div>
                      <StatusPill label={artifact.artifactType} tone="accent" />
                    </button>
                  ))
                ) : (
                  <p className="panel__empty">还没有生成结果对象。</p>
                )}
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
                    disabled={!selectedArtifact || isQgisSubmitting}
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
                      disabled={!selectedArtifact || isQgisSubmitting}
                      onClick={() => onRunQgisModel(modelName, overlayCandidates[0]?.artifactId)}
                    >
                      {isQgisSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
                      运行模型：{modelName}
                    </button>
                  ))}
                </div>
              ) : (
                <div>
                  <p className="panel__empty">qgis-runtime 当前不可用。</p>
                  {qgisModels?.error ? <p className="panel__muted">{qgisModels.error}</p> : null}
                </div>
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
        </div>
      </main>
    </div>
  )
}

function ToolCatalogEditor({
  tool,
  entry,
  isSubmitting,
  onSave,
  onDelete,
}: {
  tool: ToolDescriptor
  entry?: Record<string, unknown>
  isSubmitting: boolean
  onSave: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDelete: (tool: ToolDescriptor) => void
}) {
  const initialPayload = entry?.payload
  const [draft, setDraft] = useState(initialPayload ? JSON.stringify(initialPayload, null, 2) : '')
  const [sortOrder, setSortOrder] = useState(entry?.sortOrder != null ? String(entry.sortOrder) : '')
  const [error, setError] = useState<string>()

  return (
    <>
      <label className="tool-field">
        <span className="composer__label">排序权重</span>
        <input
          className="composer__input"
          type="number"
          inputMode="numeric"
          value={sortOrder}
          placeholder="例如：120"
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>
      <label className="tool-field tool-field--full">
        <span className="composer__label">目录配置 JSON</span>
        <textarea
          className="composer__textarea tool-field__textarea tool-field__textarea--catalog"
          value={draft}
          placeholder='例如：{"label":"缓冲分析 Pro","group":"analysis"}'
          onChange={(event) => {
            setDraft(event.target.value)
            setError(undefined)
          }}
        />
      </label>
      {error ? <div className="clarification-box clarification-box--error">{error}</div> : null}
      <div className="composer__actions">
        <button
          className="toolbar-button toolbar-button--primary"
          type="button"
          disabled={isSubmitting}
          onClick={() => {
            try {
              const parsedPayload = draft.trim() ? JSON.parse(draft) : {}
              if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
                setError('目录配置 JSON 必须是对象。')
                return
              }
              onSave(tool, parsedPayload as Record<string, unknown>, sortOrder.trim() ? Number(sortOrder) : undefined)
            } catch (parseError) {
              setError(parseError instanceof Error ? parseError.message : '目录配置 JSON 解析失败。')
            }
          }}
        >
          {isSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
          保存目录项
        </button>
        <button
          className="toolbar-button toolbar-button--ghost"
          type="button"
          disabled={isSubmitting || !entry}
          onClick={() => onDelete(tool)}
        >
          <Trash2 size={16} aria-hidden="true" />
          删除 override
        </button>
      </div>
    </>
  )
}

function ToolParameterField({
  parameter,
  value,
  collectionOptions,
  artifacts,
  layers,
  onChange,
}: {
  parameter: ToolParameterDescriptor
  value: string
  collectionOptions: Array<{ label: string; value: string }>
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  onChange: (value: string) => void
}) {
  if (parameter.options.length) {
    return (
      <label className="tool-field">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option>
          {parameter.options.map((option) => (
            <option key={`${parameter.key}:${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (parameter.source === 'boolean') {
    return (
      <label className="tool-field tool-field--toggle">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value || 'true'} onChange={(event) => onChange(event.target.value)}>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      </label>
    )
  }

  if (parameter.source === 'artifact') {
    return (
      <label className="tool-field">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择结果</option>
          {artifacts.map((artifact) => (
            <option key={artifact.artifactId} value={artifact.artifactId}>
              {artifact.name} · {shortId(artifact.artifactId)}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (parameter.source === 'layer') {
    return (
      <label className="tool-field">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择图层</option>
          <option value="latest_upload">latest_upload</option>
          {layers.map((layer) => (
            <option key={layer.layerKey} value={layer.layerKey}>
              {layer.name} · {layer.layerKey}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (parameter.source === 'collection') {
    return (
      <label className="tool-field">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择结果或图层</option>
          {collectionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (parameter.source === 'json') {
    return (
      <label className="tool-field tool-field--full">
        <span className="composer__label">{parameter.label}</span>
        <textarea
          className="composer__textarea tool-field__textarea"
          value={value}
          placeholder={parameter.placeholder ?? ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    )
  }

  return (
    <label className={parameter.source === 'text' ? 'tool-field tool-field--full' : 'tool-field'}>
      <span className="composer__label">{parameter.label}</span>
      <input
        className="composer__input"
        type={parameter.source === 'number' ? 'number' : 'text'}
        inputMode={parameter.source === 'number' ? 'decimal' : undefined}
        value={value}
        placeholder={parameter.placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function resolveToolDefaults(tool: ToolDescriptor) {
  return tool.parameters.reduce<Record<string, string>>((accumulator, parameter) => {
    if (parameter.defaultValue === undefined || parameter.defaultValue === null) {
      accumulator[parameter.key] = ''
      return accumulator
    }
    accumulator[parameter.key] = String(parameter.defaultValue)
    return accumulator
  }, {})
}

function buildCollectionOptions({
  artifacts,
  layers,
}: {
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
}) {
  const artifactOptions = artifacts.map((artifact) => ({
    label: `结果 · ${artifact.name} · ${shortId(artifact.artifactId)}`,
    value: artifact.artifactId,
  }))
  const layerOptions = layers.map((layer) => ({
    label: `图层 · ${layer.name} · ${layer.layerKey}`,
    value: layer.layerKey,
  }))
  return [...artifactOptions, ...layerOptions]
}

function buildToolArgs(tool: ToolDescriptor, values: Record<string, string>) {
  return tool.parameters.reduce<Record<string, unknown>>((accumulator, parameter) => {
    const rawValue = values[parameter.key]
    if (rawValue == null || rawValue === '') {
      return accumulator
    }
    if (parameter.source === 'number') {
      accumulator[parameter.key] = Number(rawValue)
      return accumulator
    }
    if (parameter.source === 'boolean') {
      accumulator[parameter.key] = rawValue === 'true'
      return accumulator
    }
    if (parameter.source === 'json') {
      accumulator[parameter.key] = rawValue
      return accumulator
    }
    accumulator[parameter.key] = rawValue
    return accumulator
  }, {})
}

function groupTools(tools: ToolDescriptor[]) {
  const labelMap: Record<string, string> = {
    analysis: '空间分析',
    catalog: '目录与图层',
    data: '数据准备',
    lookup: '地理编码',
    output: '导出与发布',
    qgis: 'QGIS 工具',
  }

  return Object.entries(
    tools.reduce<Record<string, ToolDescriptor[]>>((accumulator, tool) => {
      const group = tool.group || 'other'
      accumulator[group] = [...(accumulator[group] ?? []), tool]
      return accumulator
    }, {}),
  )
    .map(([group, groupTools]) => ({
      key: group,
      label: labelMap[group] ?? group,
      tools: groupTools,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
}

function getMissingRequiredParameters(tool: ToolDescriptor, values: Record<string, string>) {
  return tool.parameters.filter((parameter) => parameter.required && !String(values[parameter.key] ?? '').trim())
}

function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}

function formatRunStatus(status?: string) {
  if (status === 'completed') {
    return '分析完成'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'failed') {
    return '运行失败'
  }
  if (status === 'running') {
    return '执行中'
  }
  return '待命'
}

function deriveTone(status?: string): 'neutral' | 'success' | 'warning' | 'accent' | 'danger' {
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'clarification_needed') {
    return 'warning'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'running') {
    return 'accent'
  }
  return 'neutral'
}

function buildQuickLinks({
  currentSessionId,
  currentRunId,
  selectedArtifactId,
}: {
  currentSessionId?: string
  currentRunId?: string
  selectedArtifactId?: string
}) {
  return [
    currentSessionId
      ? {
          label: '会话运行列表',
          description: '查看当前 session 的所有运行记录',
          href: `${apiBaseUrl}/api/v1/sessions/${currentSessionId}/runs`,
        }
      : null,
    currentRunId
      ? {
          label: '当前运行产物',
          description: '直接检查本次分析生成的 artifact 列表',
          href: `${apiBaseUrl}/api/v1/analysis/${currentRunId}/artifacts`,
        }
      : null,
    {
      label: '系统图层目录',
      description: '检查可用图层、类型与要素数',
      href: `${apiBaseUrl}/api/v1/layers`,
    },
    selectedArtifactId
      ? {
          label: '当前结果元数据',
          description: '查看被选中结果的原始 metadata',
          href: `${apiBaseUrl}/api/v1/results/${selectedArtifactId}/metadata`,
        }
      : null,
  ].flatMap((item) => (item ? [item] : []))
}
