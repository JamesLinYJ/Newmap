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

import { useMemo } from 'react'
import { m, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ExternalLink, LoaderCircle, Play, Upload } from 'lucide-react'
import { Link } from 'react-router-dom'

import type {
  AgentRuntimeConfig,
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ConversationItem,
  ExecutionPlan,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  RunSummary,
  SystemComponentsStatus,
  ToolDescriptor,
  UserIntent,
} from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../../api/client'
import { deriveEntriesFromItems, pickConversationHeadline } from '../conversation/items'
import { buildFadeUpMotion, buildListItemVariants, buildListVariants, buildPressMotion } from '../../shared/motion'
import { providerUnavailableLabel, supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'
import { StatusPill } from '../../shared/components/StatusPill'
import { LiquidGlassLayer } from '../../shared/components/LiquidGlassLayer'
import { ToolWorkbench } from './tools/ToolWorkbench'
import { RuntimeConfigEditor } from './config/RuntimeConfigEditor'
import {
  buildQuickLinks,
  buildSubAgentDiagnostic,
  buildSupervisorFocus,
  buildSupervisorStages,
  compactPath,
  deriveApprovalTone,
  deriveExecutionTone,
  deriveLoopTraceFromEvents,
  deriveTone,
  formatApprovalStatus,
  formatExecutionStatus,
  formatLoopPhase,
  formatPlaceResolutionStatus,
  formatRunStatus,
  shortId,
} from './diagnostics'

// DebugPageProps
//
// 汇总调试台所需的运行态、数据资产、工具清单与管理动作。
interface DebugPageProps {
  query: string
  isSubmitting: boolean
  isToolSubmitting: boolean
  uploadedLayerName?: string
  errorMessage?: string
  runStatus?: string
  currentRunId?: string
  currentSessionId?: string
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  currentRun?: AnalysisRun
  sessionRuns: RunSummary[]
  layers: LayerDescriptor[]
  events: RunEvent[]
  items: ConversationItem[]
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  agentState?: AgentState
  artifacts: ArtifactRef[]
  artifactMetadata: Record<string, Record<string, unknown>>
  selectedArtifactId?: string
  toolRunResult?: Record<string, unknown> | null
  toolCatalogEntries: Array<Record<string, unknown>>
  runtimeConfig?: AgentRuntimeConfig
  systemComponents?: SystemComponentsStatus
  tools: ToolDescriptor[]
  isToolCatalogSubmitting?: boolean
  onQueryChange: (value: string) => void
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onSubmit: () => void
  onUpload: (file: File) => void
  onSelectArtifact: (artifactId: string) => void
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
  isToolSubmitting,
  uploadedLayerName,
  errorMessage,
  runStatus,
  currentRunId,
  currentSessionId,
  provider,
  model,
  providers,
  currentRun,
  sessionRuns,
  layers,
  events,
  items,
  intent,
  executionPlan,
  agentState,
  artifacts,
  artifactMetadata,
  selectedArtifactId,
  toolRunResult,
  toolCatalogEntries,
  runtimeConfig,
  systemComponents,
  tools,
  isToolCatalogSubmitting,
  onQueryChange,
  onProviderChange,
  onModelChange,
  onSubmit,
  onUpload,
  onSelectArtifact,
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
  const conversationPath = currentRun?.conversationPath
  const selectedMetadata = selectedArtifact ? artifactMetadata[selectedArtifact.artifactId] : undefined
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
  const transcriptHeadline = useMemo(() => pickConversationHeadline(items, runStatus), [items, runStatus])
  const assistantSummary = transcriptHeadline.title === '回答' ? transcriptHeadline.body : undefined
  const supervisorFocus = useMemo(
    () =>
      buildSupervisorFocus({
        runStatus,
        todos: todoItems,
        subAgents,
        approvals,
        toolCalls,
        events,
        finalSummary: assistantSummary,
      }),
    [approvals, assistantSummary, events, runStatus, subAgents, todoItems, toolCalls],
  )
  const agentDiagnostics = useMemo(
    () => subAgents.map((agent) => buildSubAgentDiagnostic(agent, todoItems, toolCalls, events)),
    [events, subAgents, todoItems, toolCalls],
  )
  const conversationEntries = useMemo(
    () => deriveEntriesFromItems(items, runStatus, tools),
    [items, runStatus, tools],
  )
  const quickLinks = buildQuickLinks({
    currentSessionId,
    currentRunId,
    selectedArtifactId: selectedArtifact?.artifactId,
  })
  const toolGroupCount = useMemo(() => new Set(tools.map((tool) => tool.group || 'other')).size, [tools])
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
      label: '会话存储',
      value: conversationPath ? '已绑定' : '未绑定',
      meta: conversationPath ? compactPath(conversationPath) : compactPath(systemComponents?.conversationStoreRoot),
      tone: conversationPath ? 'success' : 'neutral',
    },
    {
      label: '工具工作台',
      value: `${tools.length}`,
      meta: tools.length ? `${toolGroupCount} 个工具分组` : '暂无工具',
      tone: tools.length ? 'accent' : 'neutral',
    },
  ]

  return (
    <m.div className="debug-shell" {...buildFadeUpMotion(reducedMotion, 0, 12)}>
      <LiquidGlassLayer />
      <m.header className="debug-shell__header" layout {...buildFadeUpMotion(reducedMotion, 0.02, 12)}>
        <div>
          <div className="panel__eyebrow">内部调试页</div>
          <h1>运行诊断与数据管理台</h1>
          <p>这里聚合模型输入、数据资产、事件流、工具执行与 API 快捷入口，方便你完整检查一次分析任务。</p>
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
                      <option key={item.provider} value={item.provider} disabled={!supportsAgentSdkLiveSupervisor(item)}>
                        {item.displayName}
                        {providerUnavailableLabel(item)}
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
                  accept=".geojson,.json,.gpkg,.zip,.nc,.nc4,.tif,.tiff,.grib,.grb,.grb2,.h5,.hdf5,.bz2"
                  className="cc-file-hidden"
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
                  <span>会话事实源</span>
                  <strong>{conversationPath ? '分片文件' : '--'}</strong>
                  <p>{conversationPath ? compactPath(conversationPath) : compactPath(systemComponents?.conversationStoreRoot)}</p>
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
                {quickLinks.map((item) => (
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
                  <span>会话存储目录</span>
                  <strong>{compactPath(systemComponents?.conversationStoreRoot)}</strong>
                </div>
                <div className="intent-row">
                  <span>最新事件</span>
                  <strong>{latestEvent?.type ?? "暂无事件"}</strong>
                </div>
              </div>
              {latestEvent?.message ? <p className="panel__muted">{latestEvent.message}</p> : null}
            </div>
          </m.section>

          <ToolWorkbench
            tools={tools}
            artifacts={artifacts}
            layers={layers}
            valueRefs={agentState?.toolValueRefs ?? []}
            toolRunResult={toolRunResult}
            toolCatalogEntries={toolCatalogEntries}
            isToolSubmitting={isToolSubmitting}
            isToolCatalogSubmitting={isToolCatalogSubmitting}
            panelVariants={panelVariants}
            onRunTool={onRunTool}
            onUpsertToolCatalogEntry={onUpsertToolCatalogEntry}
            onDeleteToolCatalogEntry={onDeleteToolCatalogEntry}
          />
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
                  {systemComponents.postgisError ? (
                    <div className="intent-row">
                      <span>PostGIS 错误</span>
                      <strong>{systemComponents.postgisError}</strong>
                    </div>
                  ) : null}
                  <div className="intent-row">
                    <span>文件会话内核</span>
                    <strong>{systemComponents.conversationStoreRoot ? '已启用' : '未返回'}</strong>
                  </div>
                  {systemComponents.toolProviders.map((toolProvider) => (
                    <div className="intent-row" key={toolProvider.providerId}>
                      <span>{toolProvider.name}</span>
                      <strong>{toolProvider.available ? '可用' : toolProvider.error ?? '不可用'}</strong>
                    </div>
                  ))}
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
                <div className="panel__eyebrow">Agent SDK 运行态</div>
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
            <RuntimeConfigEditor runtimeConfig={runtimeConfig} onSaveRuntimeConfig={onSaveRuntimeConfig} />
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
                <div className="panel__eyebrow">产物与元数据</div>
                <h2>Artifacts 与状态快照</h2>
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
