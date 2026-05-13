// +-------------------------------------------------------------------------
//
//   地理智能平台 - 调试工作台页面
//
//   文件:       DebugPage.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 组织调试页的运行诊断、工具工作台、runtime config 编辑和 loop 可视化。

import { useCallback, useMemo, useState } from 'react'
import { m, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ExternalLink, LoaderCircle, Play, Save, Trash2, Upload, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'

import type {
  AgentRuntimeConfig,
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ExecutionPlan,
  LayerDescriptor,
  LoopTraceEntry,
  ModelProviderDescriptor,
  QgisModelsResponse,
  RunEvent,
  SystemComponentsStatus,
  ToolDescriptor,
  ToolParameterDescriptor,
  UserIntent,
} from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../api'
import { buildFadeUpMotion, buildListItemVariants, buildListVariants, buildPressMotion } from '../motion'
import { deriveConversationEntries, deriveRunTranscript, pickTranscriptHeadline } from '../runTranscript'
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
  runtimeConfig?: AgentRuntimeConfig
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
  onSaveRuntimeConfig: (config: AgentRuntimeConfig) => void
}

// 空状态常量
//
// 调试页会把 agentState 中的多个数组字段下发到 useMemo。
// 这里统一复用稳定常量，避免每次 render 都创建新的空数组引用。
const EMPTY_TODOS: AgentState['todos'] = []
const EMPTY_SUB_AGENTS: AgentState['subAgents'] = []
const EMPTY_APPROVALS: AgentState['approvals'] = []
const EMPTY_TOOL_RESULTS: AgentState['toolResults'] = []

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
  runtimeConfig,
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
  onSaveRuntimeConfig,
}: DebugPageProps) {
  const reducedMotion = useReducedMotion() ?? false
  // 页面级派生状态
  //
  // 将 artifact 选择、工具表单默认值、概览指标、快速链接和 catalog 编辑态
  // 集中在组件顶部整理，避免 JSX 区域混入过多条件推导逻辑。
  // 调试页的目标不是做漂亮摘要，而是把一次运行里最关键的对象
  // 统一摆在同一页上：输入、状态、事件、数据资产、工具和目录配置。
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? artifacts[0]
  const currentRun = sessionRuns.find((item) => item.id === currentRunId)
  const selectedMetadata = selectedArtifact ? artifactMetadata[selectedArtifact.artifactId] : undefined
  const overlayCandidates = artifacts.filter((artifact) => artifact.artifactId !== selectedArtifact?.artifactId)
  const latestRuns = sessionRuns.slice(0, 5)
  const latestEvent = events.at(-1)
  const currentThreadId = agentState?.threadId ?? events.find((event) => event.threadId)?.threadId
  const todoItems = agentState?.todos ?? EMPTY_TODOS
  const subAgents = agentState?.subAgents ?? EMPTY_SUB_AGENTS
  const approvals = agentState?.approvals ?? EMPTY_APPROVALS
  const toolCalls = agentState?.toolResults ?? EMPTY_TOOL_RESULTS
  const loopTrace = agentState?.loopTrace?.length ? agentState.loopTrace : deriveLoopTraceFromEvents(events)
  const latestLoopEntry = loopTrace.at(-1)
  const placeResolution = agentState?.placeResolution
  const supervisorStages = useMemo(
    () =>
      buildSupervisorStages({
        query,
        runStatus,
        intent,
        executionPlan,
        todos: todoItems,
        subAgents,
        approvals,
        toolCalls,
        events,
      }),
    [approvals, events, executionPlan, intent, query, runStatus, subAgents, todoItems, toolCalls],
  )
  const supervisorFocus = useMemo(
    () =>
      buildSupervisorFocus({
        runStatus,
        todos: todoItems,
        subAgents,
        approvals,
        toolCalls,
        events,
        finalSummary: agentState?.finalResponse?.summary,
      }),
    [agentState?.finalResponse?.summary, approvals, events, runStatus, subAgents, todoItems, toolCalls],
  )
  const agentDiagnostics = useMemo(
    () => subAgents.map((agent) => buildSubAgentDiagnostic(agent, todoItems, toolCalls, events)),
    [events, subAgents, todoItems, toolCalls],
  )
  const [selectedToolName, setSelectedToolName] = useState('')
  const [toolFormsByName, setToolFormsByName] = useState<Record<string, Record<string, string>>>({})
  const transcriptEntries = useMemo(
    () =>
      deriveRunTranscript({
        run: currentRun,
        agentState,
        events,
        artifacts,
        query,
        runtimeConfig,
      }),
    [agentState, artifacts, currentRun, events, query, runtimeConfig],
  )
  const transcriptHeadline = useMemo(() => pickTranscriptHeadline(transcriptEntries, runStatus), [runStatus, transcriptEntries])
  const conversationEntries = useMemo(
    () => deriveConversationEntries(transcriptEntries, runStatus, tools),
    [runStatus, tools, transcriptEntries],
  )
  // 运行时配置编辑态
  //
  // 通过 seed 标识当前 props 版本，在 props 变化时按需重建编辑态，
  // 避免 useEffect 中同步 setState 造成 ESLint 与交互抖动问题。
  const runtimeConfigSeed = useMemo(() => JSON.stringify(runtimeConfig ?? null), [runtimeConfig])
  const [runtimeConfigEditor, setRuntimeConfigEditorState] = useState<{
    seed: string
    draft?: AgentRuntimeConfig
    error?: string
  }>({
    seed: JSON.stringify(runtimeConfig ?? null),
    draft: runtimeConfig,
    error: undefined,
  })
  const activeRuntimeConfigEditor =
    runtimeConfigEditor.seed === runtimeConfigSeed
      ? runtimeConfigEditor
      : { seed: runtimeConfigSeed, draft: runtimeConfig, error: undefined }
  const runtimeConfigDraft = activeRuntimeConfigEditor.draft
  const runtimeConfigError = activeRuntimeConfigEditor.error
  const setRuntimeConfigDraft = useCallback((nextDraft: AgentRuntimeConfig) => {
    setRuntimeConfigEditorState((current) => ({
      ...current,
      draft: nextDraft,
      error: undefined,
    }))
  }, [])
  const setRuntimeConfigError = useCallback((nextError: string | undefined) => {
    setRuntimeConfigEditorState((current) => ({
      ...current,
      error: nextError,
    }))
  }, [])
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
  const panelVariants = buildListItemVariants(reducedMotion, 18)
  const overviewVariants = buildListVariants(reducedMotion, 0.05, 0.03)
  const pressMotion = buildPressMotion(reducedMotion)
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
    <m.div className="debug-shell" {...buildFadeUpMotion(reducedMotion, 0, 12)}>
      <m.header className="debug-shell__header" layout {...buildFadeUpMotion(reducedMotion, 0.02, 12)}>
        <div>
          <div className="panel__eyebrow">内部调试页</div>
          <h1>运行诊断与数据管理台</h1>
          <p>这里聚合模型输入、数据资产、事件流、QGIS 操作与 API 快捷入口，方便你完整检查一次分析任务。</p>
        </div>
        <div className="debug-shell__actions">
          <StatusPill label={formatRunStatus(runStatus)} tone={deriveTone(runStatus)} />
          <m.div {...pressMotion}>
            <Link to="/" className="toolbar-button toolbar-button--ghost">
              <ArrowLeft size={16} aria-hidden="true" />
              返回用户页面
            </Link>
          </m.div>
        </div>
      </m.header>

      <m.section
        className="debug-overview"
        variants={overviewVariants}
        initial="hidden"
        animate="visible"
      >
        {overviewItems.map((item) => (
          <m.article key={item.label} className="overview-card" layout variants={panelVariants}>
            <div className="overview-card__label">{item.label}</div>
            <div className="overview-card__value">{item.value}</div>
            <div className="overview-card__footer">
              <StatusPill label={item.meta} tone={item.tone} />
            </div>
          </m.article>
        ))}
      </m.section>

      <m.main
        className="debug-columns"
        variants={overviewVariants}
        initial="hidden"
        animate="visible"
      >
        <m.div className="debug-column" layout variants={panelVariants}>
          <m.section className="panel" layout variants={panelVariants}>
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
                      <option key={item.provider} value={item.provider} disabled={!item.configured}>
                        {item.displayName}
                        {!item.configured ? '（未配置）' : ''}
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
          </m.section>

          <m.section className="panel" layout variants={panelVariants}>
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
          </m.section>

          <m.section className="panel" layout variants={panelVariants}>
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
          </m.section>

          <m.section className="panel" layout variants={panelVariants}>
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
                    {...pressMotion}
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
                  <span>工具目录配置</span>
                  <span className="panel__muted">
                    {selectedToolCatalogEntry ? `${selectedTool.toolKind}/${selectedTool.name}` : '当前没有覆盖项'}
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
          </m.section>
        </m.div>

        <m.div className="debug-column" layout variants={panelVariants}>
          <m.section className="panel" layout variants={panelVariants}>
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
                    <span>目录后端</span>
                    <strong>{systemComponents.catalogBackend}</strong>
                  </div>
                  <div className="intent-row">
                    <span>PostGIS</span>
                    <strong>{systemComponents.postgisEnabled ? '已接入' : '未接入'}</strong>
                  </div>
                  <div className="intent-row">
                    <span>QGIS 运行环境</span>
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
          </m.section>
        </m.div>

        <m.div className="debug-column" layout variants={panelVariants}>
          <m.section className="panel" layout variants={panelVariants}>
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Deep Agents 运行态</div>
                <h2>主智能体与子智能体轨迹</h2>
              </div>
            </div>
            <div className="panel__section">
              <div className="agent-visual-summary">
                <article className="agent-visual-card">
                  <span>线程 / 运行</span>
                  <strong>
                    {currentThreadId ? shortId(currentThreadId) : '--'} / {currentRunId ? shortId(currentRunId) : '--'}
                  </strong>
                  <p>thread / run 视图是调试页里追踪主智能体与子智能体的主上下文。</p>
                </article>
                <article className="agent-visual-card">
                  <span>主智能体焦点</span>
                  <strong>{supervisorFocus.title}</strong>
                  <p>{supervisorFocus.description}</p>
                </article>
                <article className="agent-visual-card">
                  <span>工具与审批</span>
                  <strong>
                    {toolCalls.length} 次工具调用 · {approvals.length} 个审批
                  </strong>
                  <p>
                    {approvals.some((item) => item.status === 'pending')
                      ? '当前存在待审批动作，supervisor 会停在审批节点。'
                      : '当前没有待审批动作，工具调用可继续向结果交付推进。'}
                  </p>
                </article>
              </div>
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>共享 REPL 记录流</span>
                <span className="panel__muted">{conversationEntries.length} 条对话轮次 · {transcriptHeadline.title}</span>
              </div>
              {conversationEntries.length ? (
                <div className="debug-transcript">
                  {conversationEntries.slice(-12).map((entry) => (
                    <article key={entry.id} className={`debug-transcript__entry debug-transcript__entry--${entry.kind} debug-transcript__entry--${entry.status}`}>
                      <div className="debug-transcript__meta">
                        <span>{entry.kind === 'message' ? entry.role ?? entry.kind : entry.kind}</span>
                        <span>{entry.status}</span>
                        <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString('zh-CN')}</time>
                      </div>
                      <strong>{entry.title}</strong>
                      <p>{entry.body}</p>
                    </article>
                  ))}
                </div>
              ) : (
                  <p className="panel__empty">当前还没有可渲染的 transcript。</p>
                )}
              </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>运行时默认配置</span>
                <span className="panel__muted">保存到数据库，debug 页面可细调</span>
              </div>
              {runtimeConfigDraft ? (
                <div className="runtime-config-grid">
                  <label className="tool-field">
                    <span className="composer__label">默认发布项目</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.defaultPublishProjectKey}
                      onChange={(event) => {
                        setRuntimeConfigDraft({ ...runtimeConfigDraft, defaultPublishProjectKey: event.target.value })
                        setRuntimeConfigError(undefined)
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">Loop 轨迹上限</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.loopTraceLimit}
                      onChange={(event) => {
                        setRuntimeConfigDraft({ ...runtimeConfigDraft, loopTraceLimit: Number(event.target.value) || 1 })
                        setRuntimeConfigError(undefined)
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">主智能体名称</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.supervisor.name}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          supervisor: { ...runtimeConfigDraft.supervisor, name: event.target.value },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field tool-field--full">
                    <span className="composer__label">主智能体系统提示词</span>
                    <textarea
                      className="composer__textarea tool-field__textarea tool-field__textarea--catalog"
                      value={runtimeConfigDraft.supervisor.systemPrompt}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          supervisor: { ...runtimeConfigDraft.supervisor, systemPrompt: event.target.value },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field tool-field--full">
                    <span className="composer__label">审批中断工具</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.supervisor.approvalInterruptTools.join(', ')}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          supervisor: {
                            ...runtimeConfigDraft.supervisor,
                            approvalInterruptTools: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">记录流上限</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.ui.transcriptMaxEntries}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          ui: { ...runtimeConfigDraft.ui, transcriptMaxEntries: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">事件分组窗口(ms)</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={0}
                      value={runtimeConfigDraft.ui.eventGroupingWindowMs}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          ui: { ...runtimeConfigDraft.ui, eventGroupingWindowMs: Number(event.target.value) || 0 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field tool-field--checkbox">
                    <span className="composer__label">显示内部标签</span>
                    <input
                      type="checkbox"
                      checked={runtimeConfigDraft.ui.showInternalReasoningLabels}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          ui: { ...runtimeConfigDraft.ui, showInternalReasoningLabels: event.target.checked },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">线程历史轮数</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.context.historyRunLimit}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          context: { ...runtimeConfigDraft.context, historyRunLimit: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">事件上下文窗口</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.context.eventWindow}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          context: { ...runtimeConfigDraft.context, eventWindow: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">工具调用窗口</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.context.toolCallWindow}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          context: { ...runtimeConfigDraft.context, toolCallWindow: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">结果产物窗口</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.context.artifactWindow}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          context: { ...runtimeConfigDraft.context, artifactWindow: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">告警上下文窗口</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.context.warningWindow}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          context: { ...runtimeConfigDraft.context, warningWindow: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field tool-field--full">
                    <span className="composer__label">Agent SDK 记忆文件</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.context.memoryFilePaths.join(', ')}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          context: {
                            ...runtimeConfigDraft.context,
                            memoryFilePaths: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">地理检索 Provider</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.geosearch.provider}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          geosearch: { ...runtimeConfigDraft.geosearch, provider: event.target.value },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">检索服务地址</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.geosearch.baseUrl}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          geosearch: { ...runtimeConfigDraft.geosearch, baseUrl: event.target.value },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">请求超时(ms)</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={100}
                      value={runtimeConfigDraft.geosearch.timeoutMs}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          geosearch: { ...runtimeConfigDraft.geosearch, timeoutMs: Number(event.target.value) || 1000 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field">
                    <span className="composer__label">候选结果上限</span>
                    <input
                      className="composer__input"
                      type="number"
                      min={1}
                      value={runtimeConfigDraft.geosearch.maxCandidates}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          geosearch: { ...runtimeConfigDraft.geosearch, maxCandidates: Number(event.target.value) || 1 },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field tool-field--full">
                    <span className="composer__label">检索服务 User-Agent</span>
                    <input
                      className="composer__input"
                      value={runtimeConfigDraft.geosearch.userAgent}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          geosearch: { ...runtimeConfigDraft.geosearch, userAgent: event.target.value },
                        })
                      }}
                    />
                  </label>
                  <label className="tool-field tool-field--checkbox">
                    <span className="composer__label">启用远程地点检索</span>
                    <input
                      type="checkbox"
                      checked={runtimeConfigDraft.geosearch.enabled}
                      onChange={(event) => {
                        setRuntimeConfigDraft({
                          ...runtimeConfigDraft,
                          geosearch: { ...runtimeConfigDraft.geosearch, enabled: event.target.checked },
                        })
                      }}
                    />
                  </label>
                  <div className="tool-field tool-field--full">
                    <div className="panel__subheader">
                      <span>子智能体</span>
                      <button
                        type="button"
                        className="toolbar-button toolbar-button--ghost"
                        onClick={() => {
                          setRuntimeConfigDraft({
                            ...runtimeConfigDraft,
                            subAgents: [
                              ...runtimeConfigDraft.subAgents,
                              {
                                agentId: `agent_${runtimeConfigDraft.subAgents.length + 1}`,
                                name: '新智能体',
                                role: '新角色',
                                summary: '负责新的工具职责。',
                                systemPrompt: '',
                                tools: [],
                              },
                            ],
                          })
                        }}
                      >
                        新增子智能体
                      </button>
                    </div>
                    <div className="runtime-config-agents">
                      {runtimeConfigDraft.subAgents.map((agent, index) => (
                        <article key={`${agent.agentId}:${index}`} className="runtime-config-agent">
                          <div className="runtime-config-agent__header">
                            <strong>{agent.name}</strong>
                            <button
                              type="button"
                              className="toolbar-button toolbar-button--ghost"
                              onClick={() => {
                                setRuntimeConfigDraft({
                                  ...runtimeConfigDraft,
                                  subAgents: runtimeConfigDraft.subAgents.filter((_, candidateIndex) => candidateIndex !== index),
                                })
                              }}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              删除
                            </button>
                          </div>
                          <div className="runtime-config-grid">
                            <label className="tool-field">
                              <span className="composer__label">智能体 ID</span>
                              <input
                                className="composer__input"
                                value={agent.agentId}
                                onChange={(event) => {
                                  setRuntimeConfigDraft({
                                    ...runtimeConfigDraft,
                                    subAgents: runtimeConfigDraft.subAgents.map((item, candidateIndex) =>
                                      candidateIndex === index ? { ...item, agentId: event.target.value } : item,
                                    ),
                                  })
                                }}
                              />
                            </label>
                            <label className="tool-field">
                              <span className="composer__label">名称</span>
                              <input
                                className="composer__input"
                                value={agent.name}
                                onChange={(event) => {
                                  setRuntimeConfigDraft({
                                    ...runtimeConfigDraft,
                                    subAgents: runtimeConfigDraft.subAgents.map((item, candidateIndex) =>
                                      candidateIndex === index ? { ...item, name: event.target.value } : item,
                                    ),
                                  })
                                }}
                              />
                            </label>
                            <label className="tool-field">
                              <span className="composer__label">角色</span>
                              <input
                                className="composer__input"
                                value={agent.role}
                                onChange={(event) => {
                                  setRuntimeConfigDraft({
                                    ...runtimeConfigDraft,
                                    subAgents: runtimeConfigDraft.subAgents.map((item, candidateIndex) =>
                                      candidateIndex === index ? { ...item, role: event.target.value } : item,
                                    ),
                                  })
                                }}
                              />
                            </label>
                            <label className="tool-field tool-field--full">
                              <span className="composer__label">摘要</span>
                              <input
                                className="composer__input"
                                value={agent.summary}
                                onChange={(event) => {
                                  setRuntimeConfigDraft({
                                    ...runtimeConfigDraft,
                                    subAgents: runtimeConfigDraft.subAgents.map((item, candidateIndex) =>
                                      candidateIndex === index ? { ...item, summary: event.target.value } : item,
                                    ),
                                  })
                                }}
                              />
                            </label>
                            <label className="tool-field tool-field--full">
                              <span className="composer__label">系统提示词</span>
                              <textarea
                                className="composer__textarea tool-field__textarea tool-field__textarea--catalog"
                                value={agent.systemPrompt ?? ''}
                                onChange={(event) => {
                                  setRuntimeConfigDraft({
                                    ...runtimeConfigDraft,
                                    subAgents: runtimeConfigDraft.subAgents.map((item, candidateIndex) =>
                                      candidateIndex === index ? { ...item, systemPrompt: event.target.value } : item,
                                    ),
                                  })
                                }}
                              />
                            </label>
                            <label className="tool-field tool-field--full">
                              <span className="composer__label">工具列表</span>
                              <input
                                className="composer__input"
                                value={agent.tools.join(', ')}
                                onChange={(event) => {
                                  setRuntimeConfigDraft({
                                    ...runtimeConfigDraft,
                                    subAgents: runtimeConfigDraft.subAgents.map((item, candidateIndex) =>
                                      candidateIndex === index
                                        ? {
                                            ...item,
                                            tools: event.target.value
                                              .split(',')
                                              .map((tool) => tool.trim())
                                              .filter(Boolean),
                                          }
                                        : item,
                                    ),
                                  })
                                }}
                              />
                            </label>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="panel__empty">当前还没有运行时配置。</p>
              )}
              {runtimeConfigError ? <div className="clarification-box clarification-box--error">{runtimeConfigError}</div> : null}
              <div className="composer__actions">
                <button
                  className="toolbar-button toolbar-button--primary"
                  type="button"
                  onClick={() => {
                    if (!runtimeConfigDraft) {
                      setRuntimeConfigError('当前没有可保存的运行时配置。')
                      return
                    }
                    onSaveRuntimeConfig(runtimeConfigDraft)
                  }}
                >
                  <Save size={16} aria-hidden="true" />
                  保存运行时配置
                </button>
              </div>
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>地点解析状态</span>
                <span className="panel__muted">{formatPlaceResolutionStatus(placeResolution?.status)}</span>
              </div>
              {placeResolution ? (
                <div className="intent-block">
                  <div className="intent-row">
                    <span>查询词</span>
                    <strong>{placeResolution.query || '未提供'}</strong>
                  </div>
                  <div className="intent-row">
                    <span>Provider</span>
                    <strong>{placeResolution.provider || '未记录'}</strong>
                  </div>
                  <div className="intent-row">
                    <span>状态</span>
                    <strong>{formatPlaceResolutionStatus(placeResolution.status)}</strong>
                  </div>
                  <div className="intent-row">
                    <span>已选锚点</span>
                    <strong>{placeResolution.selected?.displayName || placeResolution.selected?.label || '尚未确定'}</strong>
                  </div>
                  <div className="intent-row">
                    <span>候选数量</span>
                    <strong>{placeResolution.candidates?.length ?? 0}</strong>
                  </div>
                </div>
              ) : (
                <p className="panel__empty">当前运行还没有地点解析结果。</p>
              )}
              {placeResolution?.candidates?.length ? (
                <pre className="debug-pre">{JSON.stringify(placeResolution.candidates, null, 2)}</pre>
              ) : null}
              {placeResolution?.error ? <div className="clarification-box clarification-box--error">{placeResolution.error}</div> : null}
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>主智能体 Loop</span>
                <span className="panel__muted">
                  iteration {agentState?.loopIteration || latestLoopEntry?.iteration || 0} ·{' '}
                  {formatLoopPhase(agentState?.loopPhase || latestLoopEntry?.phase)}
                </span>
              </div>
              {loopTrace.length ? (
                <ol className="timeline">
                  {[...loopTrace].reverse().slice(0, 8).map((item) => (
                    <li key={`${item.iteration}:${item.phase}:${item.timestamp}`} className="timeline__item">
                      <div className="timeline__marker" aria-hidden="true" />
                      <div className="timeline__content">
                        <div className="timeline__meta">
                          <span>
                            #{item.iteration} · {formatLoopPhase(item.phase)} · {item.status}
                          </span>
                          <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString('zh-CN')}</time>
                        </div>
                        <p>
                          <strong>{item.title}</strong>
                        </p>
                        <p>{item.description}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="panel__empty">当前还没有 loop 轨迹。</p>
              )}
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>主智能体阶段</span>
                <span className="panel__muted">按 Agent SDK thread/run 状态展开</span>
              </div>
              <div className="agent-stage-list">
                {supervisorStages.map((stage) => (
                  <article key={stage.id} className={`agent-stage agent-stage--${stage.status}`}>
                    <div className="agent-stage__marker" aria-hidden="true" />
                    <div className="agent-stage__body">
                      <div className="agent-stage__header">
                        <strong>{stage.title}</strong>
                        <StatusPill label={formatExecutionStatus(stage.status)} tone={deriveExecutionTone(stage.status)} />
                      </div>
                      <p>{stage.description}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>子智能体执行位置</span>
                <span className="panel__muted">{agentDiagnostics.length} 个 agent</span>
              </div>
              {agentDiagnostics.length ? (
                <div className="agent-card-grid">
                  {agentDiagnostics.map((agent) => (
                    <article key={agent.agent.agentId} className="agent-card">
                      <div className="agent-card__header">
                        <div>
                          <strong>{agent.agent.name}</strong>
                          <p>
                            {agent.agent.role} · {agent.progressLabel}
                          </p>
                        </div>
                        <StatusPill label={formatExecutionStatus(agent.agent.status)} tone={deriveExecutionTone(agent.agent.status)} />
                      </div>
                      <div className="agent-card__metrics">
                        <div className="agent-card__metric">
                          <span>当前步骤</span>
                          <strong>{agent.currentWork}</strong>
                        </div>
                        <div className="agent-card__metric">
                          <span>最近消息</span>
                          <strong>{agent.latestMessage}</strong>
                        </div>
                      </div>
                      <div className="agent-card__chips">
                        {agent.agent.tools.length ? (
                          agent.agent.tools.slice(0, 6).map((tool) => (
                            <span key={`${agent.agent.agentId}:${tool}`} className="agent-chip">
                              {tool}
                            </span>
                          ))
                        ) : (
                          <span className="agent-chip agent-chip--muted">当前未声明专属工具</span>
                        )}
                      </div>
                      <div className="agent-card__events">
                        <div className="panel__subheader">
                          <span>最近轨迹</span>
                          <span className="panel__muted">{agent.recentEvents.length} 条</span>
                        </div>
                        {agent.recentEvents.length ? (
                          <ol className="agent-mini-timeline">
                            {agent.recentEvents.map((event) => (
                              <li key={event.eventId}>
                                <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time>
                                <span>{event.message}</span>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="panel__empty">当前还没有这个子智能体的独立事件。</p>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="panel__empty">当前运行还没有装配子智能体状态。</p>
              )}
            </div>
            <div className="panel__section">
              <div className="panel__subheader">
                <span>工具与审批轨迹</span>
                <span className="panel__muted">状态与其他工具一视同仁</span>
              </div>
              <div className="agent-ops-grid">
                <div className="agent-ops-card">
                  <div className="panel__subheader">
                    <span>工具调用</span>
                    <span className="panel__muted">{toolCalls.length} 次</span>
                  </div>
                  {toolCalls.length ? (
                    <div className="agent-ops-list">
                      {toolCalls.map((toolCall) => (
                        <div key={toolCall.stepId} className="agent-ops-item">
                          <div>
                            <strong>{toolCall.tool}</strong>
                            <p>{toolCall.message}</p>
                          </div>
                          <StatusPill label={formatExecutionStatus(toolCall.status)} tone={deriveExecutionTone(toolCall.status)} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="panel__empty">当前还没有记录到工具调用。</p>
                  )}
                </div>
                <div className="agent-ops-card">
                  <div className="panel__subheader">
                    <span>审批节点</span>
                    <span className="panel__muted">{approvals.length} 个</span>
                  </div>
                  {approvals.length ? (
                    <div className="agent-ops-list">
                      {approvals.map((approval) => (
                        <div key={approval.approvalId} className="agent-ops-item">
                          <div>
                            <strong>{approval.title}</strong>
                            <p>{approval.description}</p>
                          </div>
                          <StatusPill label={formatApprovalStatus(approval.status)} tone={deriveApprovalTone(approval.status)} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="panel__empty">本次运行没有产生审批节点。</p>
                  )}
                </div>
              </div>
            </div>
          </m.section>

          <m.section className="panel" layout variants={panelVariants}>
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
          </m.section>

          <m.section className="panel" layout variants={panelVariants}>
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
                      {...pressMotion}
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
                    {...pressMotion}
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
                      {...pressMotion}
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
          </m.section>
        </m.div>
      </m.main>
    </m.div>
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
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'cancelled') {
    return '已取消'
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
  if (status === 'waiting_approval') {
    return 'warning'
  }
  if (status === 'clarification_needed') {
    return 'warning'
  }
  if (status === 'cancelled') {
    return 'danger'
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

function buildSupervisorStages({
  query,
  runStatus,
  intent,
  executionPlan,
  todos,
  subAgents,
  approvals,
  toolCalls,
  events,
}: {
  query: string
  runStatus?: string
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  todos: AgentState['todos']
  subAgents: AgentState['subAgents']
  approvals: AgentState['approvals']
  toolCalls: AgentState['toolResults']
  events: RunEvent[]
}) {
  const hasEvent = (type: RunEvent['type']) => events.some((event) => event.type === type)
  const hasPendingApproval = approvals.some((approval) => approval.status === 'pending')
  const allApprovalsResolved = approvals.length > 0 && approvals.every((approval) => approval.status !== 'pending')
  const hasFailure =
    runStatus === 'failed' ||
    runStatus === 'cancelled' ||
    todos.some((todo) => todo.status === 'failed') ||
    subAgents.some((agent) => agent.status === 'failed') ||
    toolCalls.some((tool) => tool.status === 'failed')
  const hasRunningExecution =
    todos.some((todo) => todo.status === 'running') ||
    subAgents.some((agent) => agent.status === 'running') ||
    toolCalls.some((tool) => tool.status === 'running')
  const allTodosCompleted = todos.length > 0 && todos.every((todo) => todo.status === 'completed')
  const executionStarted = hasEvent('step.started') || hasEvent('tool.started') || toolCalls.length > 0 || todos.length > 0

  return [
    {
      id: 'input',
      title: '接收任务',
      status: query.trim() ? 'completed' : 'pending',
      description: query.trim() ? '用户问题已经进入当前 thread/run。' : '等待新的空间分析请求进入。 ',
    },
    {
      id: 'intent',
      title: '解析意图',
      status: hasFailure ? 'failed' : intent || hasEvent('intent.parsed') ? 'completed' : runStatus === 'running' ? 'running' : 'pending',
      description: intent ? '主 agent 已识别查询区域、目标图层和空间约束。' : '等待 supervisor 解析用户意图与歧义。',
    },
    {
      id: 'planning',
      title: '拆分计划',
      status:
        hasFailure
          ? 'failed'
          : executionPlan || hasEvent('plan.ready')
            ? 'completed'
            : intent || hasEvent('intent.parsed')
              ? 'running'
              : 'pending',
      description: executionPlan ? `已拆出 ${executionPlan.steps.length} 个执行步骤，并回写到运行状态。` : '等待把用户问题落成可执行的 todo 和步骤。',
    },
    {
      id: 'execution',
      title: '调度执行',
      status: hasFailure ? 'failed' : hasRunningExecution ? 'running' : allTodosCompleted || runStatus === 'waiting_approval' || runStatus === 'completed' ? 'completed' : executionStarted ? 'running' : 'pending',
      description:
        todos.length || toolCalls.length
          ? `当前共有 ${todos.length} 个 todo，记录了 ${toolCalls.length} 次工具调用。`
          : '尚未进入工具调用与子智能体执行阶段。',
    },
    {
      id: 'approval',
      title: '审批节点',
      status: hasPendingApproval ? 'blocked' : allApprovalsResolved ? 'completed' : approvals.length ? 'running' : 'pending',
      description:
        approvals.length
          ? `${approvals.length} 个审批节点已进入运行状态，发布和 execute 这类敏感动作会在这里停住。`
          : '本次运行没有产生审批请求，supervisor 可以直接完成交付。',
    },
    {
      id: 'delivery',
      title: '结果交付',
      status:
        hasFailure
          ? 'failed'
          : runStatus === 'completed'
            ? 'completed'
            : runStatus === 'waiting_approval'
              ? 'running'
              : executionStarted
                ? 'running'
                : 'pending',
      description:
        runStatus === 'completed'
          ? '最终总结已经写回，结果可以被地图、历史和下载入口消费。'
          : runStatus === 'waiting_approval'
            ? '结果已经生成，但还在等待审批通过后继续交付。'
            : '最终总结和交付说明还在生成中。',
    },
  ]
}

function buildSupervisorFocus({
  runStatus,
  todos,
  subAgents,
  approvals,
  toolCalls,
  events,
  finalSummary,
}: {
  runStatus?: string
  todos: AgentState['todos']
  subAgents: AgentState['subAgents']
  approvals: AgentState['approvals']
  toolCalls: AgentState['toolResults']
  events: RunEvent[]
  finalSummary?: string
}) {
  const runningTodo = todos.find((todo) => todo.status === 'running')
  if (runStatus === 'waiting_approval') {
    const pendingApproval = approvals.find((approval) => approval.status === 'pending')
    return {
      title: pendingApproval?.title ?? '等待审批',
      description: pendingApproval?.description ?? '主 agent 已停在审批节点，等待人工确认敏感动作。',
    }
  }
  if (runningTodo) {
    return {
      title: runningTodo.title,
      description: runningTodo.description ?? '主 agent 正在推进当前 todo。',
    }
  }
  const runningSubAgent = subAgents.find((agent) => agent.status === 'running')
  if (runningSubAgent) {
    return {
      title: `${runningSubAgent.name} 正在执行`,
      description: runningSubAgent.latestMessage ?? runningSubAgent.summary,
    }
  }
  const runningTool = toolCalls.find((tool) => tool.status === 'running')
  if (runningTool) {
    return {
      title: runningTool.tool,
      description: runningTool.message,
    }
  }
  if (runStatus === 'completed' && finalSummary) {
    return {
      title: '运行完成',
      description: finalSummary,
    }
  }
  const latestMeaningfulEvent = [...events]
    .reverse()
    .find((event) => event.type !== 'message.delta')
  return {
    title: latestMeaningfulEvent?.type ?? '等待执行',
    description: latestMeaningfulEvent?.message ?? '当前还没有可展示的主 agent 轨迹。',
  }
}

function buildSubAgentDiagnostic(
  agent: AgentState['subAgents'][number],
  todos: AgentState['todos'],
  toolCalls: AgentState['toolResults'],
  events: RunEvent[],
) {
  const ownedTodos = todos.filter((todo) => todo.ownerAgentId === agent.agentId || (todo.stepId ? agent.stepIds.includes(todo.stepId) : false))
  const completedTodos = ownedTodos.filter((todo) => todo.status === 'completed').length
  const recentEvents = events
    .filter((event) => isEventOwnedByAgent(event, agent))
    .slice(-3)
    .reverse()
  const latestToolCall = [...toolCalls].reverse().find((tool) => agent.tools.includes(tool.tool))

  return {
    agent,
    progressLabel: ownedTodos.length ? `${completedTodos}/${ownedTodos.length} todo 完成` : `${agent.tools.length} 个专属工具`,
    currentWork: agent.currentStepId ?? latestToolCall?.tool ?? '当前待命',
    latestMessage: agent.latestMessage ?? latestToolCall?.message ?? agent.summary,
    recentEvents,
  }
}

function isEventOwnedByAgent(event: RunEvent, agent: AgentState['subAgents'][number]) {
  const payload = event.payload ?? {}
  const eventAgentId = toStringValue(payload.agentId) ?? toStringValue(payload.agent_id)
  const eventAgentName = toStringValue(payload.name)
  const payloadTool = toStringValue(payload.tool)
  return (
    eventAgentId === agent.agentId ||
    eventAgentName === agent.name ||
    Boolean(payloadTool && agent.tools.includes(payloadTool))
  )
}

function toStringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function deriveLoopTraceFromEvents(events: RunEvent[]): LoopTraceEntry[] {
  return events
    .filter((event) => event.type === 'loop.updated')
    .map((event) => {
      const payload = event.payload ?? {}
      return {
        iteration: Number(payload.iteration ?? 0),
        phase: String(payload.phase ?? 'observe'),
        title: String(payload.title ?? event.message),
        description: String(payload.description ?? event.message),
        status: String(payload.status ?? 'running') as LoopTraceEntry['status'],
        timestamp: String(payload.timestamp ?? event.timestamp),
        agentId: typeof payload.agentId === 'string' ? payload.agentId : null,
        toolName: typeof payload.toolName === 'string' ? payload.toolName : null,
        stepId: typeof payload.stepId === 'string' ? payload.stepId : null,
      }
    })
}

function formatExecutionStatus(status?: string) {
  if (status === 'completed') {
    return '已完成'
  }
  if (status === 'running') {
    return '执行中'
  }
  if (status === 'blocked') {
    return '阻塞中'
  }
  if (status === 'failed') {
    return '失败'
  }
  return '待命'
}

function deriveExecutionTone(status?: string): 'neutral' | 'success' | 'warning' | 'accent' | 'danger' {
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'running') {
    return 'accent'
  }
  if (status === 'blocked') {
    return 'warning'
  }
  if (status === 'failed') {
    return 'danger'
  }
  return 'neutral'
}

function formatApprovalStatus(status?: string) {
  if (status === 'approved') {
    return '已批准'
  }
  if (status === 'rejected') {
    return '已拒绝'
  }
  return '待审批'
}

function formatLoopPhase(phase?: string) {
  if (phase === 'observe') {
    return '观察'
  }
  if (phase === 'decide') {
    return '决策'
  }
  if (phase === 'act') {
    return '执行'
  }
  if (phase === 'observe_result') {
    return '吸收结果'
  }
  if (phase === 'approval') {
    return '审批'
  }
  if (phase === 'deliver') {
    return '交付'
  }
  if (phase === 'failed') {
    return '失败'
  }
  return '待命'
}

function deriveApprovalTone(status?: string): 'neutral' | 'success' | 'warning' | 'accent' | 'danger' {
  if (status === 'approved') {
    return 'success'
  }
  if (status === 'rejected') {
    return 'danger'
  }
  return 'warning'
}

function formatPlaceResolutionStatus(status?: string) {
  if (status === 'resolved') {
    return '已解析'
  }
  if (status === 'ambiguous') {
    return '待澄清'
  }
  if (status === 'not_found') {
    return '未找到'
  }
  if (status === 'failed') {
    return '解析失败'
  }
  if (status === 'unresolved') {
    return '未触发'
  }
  return '未知'
}
