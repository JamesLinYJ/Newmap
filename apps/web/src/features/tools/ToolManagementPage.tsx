// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具管理页面
//
//   文件:       ToolManagementPage.tsx
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 面向主工作台展示工具目录、Provider 可用性、参数 schema、目录 override
// 与试运行入口。页面只消费 WebSocket 控制器传入的服务端状态，不直接发请求。

import { useMemo, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Box,
  CloudSun,
  Code2,
  DatabaseZap,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type {
  ArtifactRef,
  LayerDescriptor,
  SystemComponentsStatus,
  ToolDescriptor,
  ToolValueRef,
} from '@geo-agent-platform/shared-types'

import { StatusPill } from '../../shared/components/StatusPill'
import { LiquidGlassSurface } from '../../shared/components/LiquidGlassLayer'
import {
  ToolCatalogEditor,
  ToolParameterForm,
  ToolRunControls,
} from './toolForm'
import {
  buildToolFormState,
  resolveToolDefaults,
} from './toolFormState'
import { ToolMiniAppPanel } from './ToolMiniApp'
import {
  filterTools,
  findToolCatalogEntry,
  groupToolsForManagement,
  providerLabel,
  summarizeTools,
} from './toolManagementModel'

interface ToolManagementPageProps {
  tools: ToolDescriptor[]
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  valueRefs: ToolValueRef[]
  toolRunResult?: Record<string, unknown> | null
  toolCatalogEntries: Array<Record<string, unknown>>
  systemComponents?: SystemComponentsStatus
  isToolSubmitting: boolean
  isToolCatalogSubmitting?: boolean
  onRunTool: (tool: ToolDescriptor, args: Record<string, unknown>) => void
  onUpsertToolCatalogEntry: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDeleteToolCatalogEntry: (tool: ToolDescriptor) => void
}

export function ToolManagementPage({
  tools,
  artifacts,
  layers,
  valueRefs,
  toolRunResult,
  toolCatalogEntries,
  systemComponents,
  isToolSubmitting,
  isToolCatalogSubmitting,
  onRunTool,
  onUpsertToolCatalogEntry,
  onDeleteToolCatalogEntry,
}: ToolManagementPageProps) {
  const [query, setQuery] = useState('')
  const [selectedToolName, setSelectedToolName] = useState('')
  const [toolFormsByName, setToolFormsByName] = useState<Record<string, Record<string, string>>>({})
  const filteredTools = useMemo(() => filterTools(tools, query), [query, tools])
  const groupedTools = useMemo(() => groupToolsForManagement(filteredTools), [filteredTools])
  const summary = useMemo(() => summarizeTools(tools, systemComponents), [systemComponents, tools])
  const selectedTool =
    tools.find((tool) => tool.name === selectedToolName) ??
    filteredTools.find((tool) => tool.available) ??
    filteredTools[0] ??
    tools[0]
  const selectedToolCatalogEntry = findToolCatalogEntry(toolCatalogEntries, selectedTool)
  const toolFormValues = selectedTool ? toolFormsByName[selectedTool.name] ?? resolveToolDefaults(selectedTool) : {}
  const formState = selectedTool
    ? buildToolFormState(selectedTool, toolFormValues)
    : { values: {}, missing: [], parsed: { args: {}, error: null } }
  const schemaPreview = selectedTool ? buildSchemaPreview(selectedTool) : null
  const providers = systemComponents?.toolProviders ?? []

  return (
    <section className="tool-management">
      <LiquidGlassSurface as="section" variant="strong" className="tool-management__hero">
        <div className="tool-management__hero-copy">
          <div className="tool-management__hero-icon">
            <Sparkles size={20} aria-hidden="true" />
          </div>
          <div>
            <div className="panel__eyebrow">Agent Tool Registry</div>
            <h1>工具与能力中心</h1>
            <p>
              管理 Agent 可调用的空间分析、气象计算与产品生成能力，并在同一工作区完成参数配置、运行验证和目录治理。
            </p>
          </div>
        </div>
        <div className="tool-doc-grid">
          <DocShortcut icon={BookOpen} title="工具接入规范" pathValue="docs/tool-integration-standard.md" />
          <DocShortcut icon={Code2} title="Provider Demo" pathValue="demo/tool-provider-demo" />
        </div>
      </LiquidGlassSurface>

      <div className="tool-management__overview">
        <OverviewCard icon={Wrench} label="工具总数" value={String(summary.total)} hint={`${summary.available} 个可用`} />
        <OverviewCard icon={ShieldCheck} label="只读工具" value={String(summary.readOnly)} hint="默认无需审批" />
        <OverviewCard icon={DatabaseZap} label="需谨慎工具" value={String(summary.destructive)} hint="破坏性操作会标识风险" />
        <OverviewCard icon={Box} label="Provider" value={String(summary.providers)} hint={`${summary.unavailableProviders} 个不可用`} />
      </div>

      <div className="tool-management__grid">
        <LiquidGlassSurface as="aside" variant="strong" className="tool-management__sidebar">
          <div className="tool-management__sidebar-header">
            <div>
              <div className="panel__eyebrow">目录</div>
              <h2>能力目录</h2>
            </div>
            <span className="tool-management__count">{filteredTools.length}</span>
          </div>
          <div className="tool-management__search-wrap">
            <label className="tool-management__search">
              <Search size={15} aria-hidden="true" />
              <input
                value={query}
                placeholder="搜索工具、标签或 Provider"
                aria-label="搜索工具"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="tool-management__catalog">
            {groupedTools.length ? groupedTools.map((group) => (
              <div className="tool-management__group" key={group.key}>
                <div className="tool-management__group-title">
                  <span>{group.label}</span>
                  <small>{group.availableCount}/{group.tools.length}</small>
                </div>
                {group.tools.map((tool) => (
                  <button
                    key={`${tool.toolKind}:${tool.name}`}
                    type="button"
                    className={selectedTool?.name === tool.name ? 'tool-card tool-card--active' : 'tool-card'}
                    onClick={() => setSelectedToolName(tool.name)}
                  >
                    <span className="tool-card__icon">
                      {tool.group === '气象' || tool.tags.some((tag) => tag.includes('meteorology') || tag.includes('气象'))
                        ? <CloudSun size={15} aria-hidden="true" />
                        : <Wrench size={15} aria-hidden="true" />}
                    </span>
                    <span className="tool-card__body">
                      <span className="tool-card__title">{tool.label}</span>
                      <span className="tool-card__meta">{providerLabel(tool)}</span>
                    </span>
                    <span className={tool.available ? 'tool-card__status tool-card__status--ready' : 'tool-card__status'} />
                  </button>
                ))}
              </div>
            )) : (
              <div className="panel__empty">没有匹配的工具。</div>
            )}
          </div>
        </LiquidGlassSurface>

        <main className="tool-management__detail">
          <LiquidGlassSurface as="section" variant="panel" className="panel tool-management__provider-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Provider Health</div>
                <h2>能力服务状态</h2>
              </div>
              <StatusPill label={providers.length ? `${providers.length} 个 Provider` : '等待系统状态'} tone="accent" />
            </div>
            <div className="panel__section">
              <div className="tool-provider-list">
                {providers.length ? providers.map((provider) => (
                  <article className="tool-provider-row" key={provider.providerId}>
                    <div>
                      <strong>{provider.name}</strong>
                      <p>
                        {provider.providerId} · {provider.language ?? 'unknown'} · {provider.toolCount} tools
                      </p>
                    </div>
                    <div className="tool-provider-row__meta">
                      <span className={provider.available ? 'dc-pill-meta badge-green' : 'dc-pill-meta badge-red'}>
                        {provider.available ? '可用' : '不可用'}
                      </span>
                      <span className="dc-pill-meta">{provider.version ?? 'no-version'}</span>
                      <span className="dc-pill-meta">{provider.author ?? 'unknown-author'}</span>
                    </div>
                    {provider.error ? <p className="tool-provider-row__error">{provider.error}</p> : null}
                  </article>
                )) : (
                  <div className="panel__empty">系统状态尚未返回 Provider 信息。</div>
                )}
              </div>
            </div>
          </LiquidGlassSurface>

          <LiquidGlassSurface as="section" variant="strong" className="panel tool-management__primary-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Tool Detail</div>
                <h2>{selectedTool?.label ?? '未选择工具'}</h2>
              </div>
              {selectedTool ? (
                <div className="tool-management__risk">
                  <span className={selectedTool.available ? 'dc-pill-meta badge-green' : 'dc-pill-meta badge-red'}>
                    {selectedTool.available ? '可运行' : '不可运行'}
                  </span>
                  <span className="dc-pill-meta">{selectedTool.isReadOnly ? '只读' : '写操作'}</span>
                  {selectedTool.isDestructive ? <span className="dc-pill-meta badge-amber">破坏性</span> : null}
                </div>
              ) : null}
            </div>
            {selectedTool ? (
              <>
                <div className="panel__section">
                  <div className="tool-management__description">
                    <p>{selectedTool.description}</p>
                    <div className="tool-management__tag-row">
                      <span className="dc-pill-meta">{selectedTool.toolKind}</span>
                      <span className="dc-pill-meta">{providerLabel(selectedTool)}</span>
                      <span className="dc-pill-meta">{selectedTool.group}</span>
                      {selectedTool.tags.map((tag) => (
                        <span key={tag} className="dc-pill-meta">{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="panel__section">
                  <div className="tool-schema-grid">
                    <div className="tool-management__form-column">
                      <div className="panel__subheader">
                        <span>参数表单</span>
                        <span className="panel__muted">{selectedTool.parameters.length} 个参数</span>
                      </div>
                      <ToolMiniAppPanel
                        tool={selectedTool}
                        formState={formState}
                        valueRefs={valueRefs}
                        isSubmitting={isToolSubmitting}
                        onRunTool={onRunTool}
                      />
                      <ToolParameterForm
                        tool={selectedTool}
                        values={formState.values}
                        artifacts={artifacts}
                        layers={layers}
                        valueRefs={valueRefs}
                        onValuesChange={setToolFormsByName}
                      />
                      <ToolRunControls
                        tool={selectedTool}
                        formState={formState}
                        isSubmitting={isToolSubmitting}
                        onRunTool={onRunTool}
                      />
                    </div>
                    <div className="tool-management__schema-column">
                      <div className="panel__subheader">
                        <span>参数 schema</span>
                        <span className="panel__muted">只读预览</span>
                      </div>
                      <pre className="debug-pre">{JSON.stringify(schemaPreview, null, 2)}</pre>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="panel__section">
                <div className="panel__empty">当前还没有工具 descriptor。</div>
              </div>
            )}
          </LiquidGlassSurface>

          {selectedTool ? (
            <LiquidGlassSurface as="section" variant="panel" className="panel">
              <div className="panel__header">
                <div>
                  <div className="panel__eyebrow">Catalog Override</div>
                  <h2>目录展示配置</h2>
                </div>
                <StatusPill
                  label={selectedToolCatalogEntry ? '已有 override' : '使用默认 descriptor'}
                  tone={selectedToolCatalogEntry ? 'success' : 'accent'}
                />
              </div>
              <div className="panel__section">
                <StatefulToolCatalogEditor
                  key={`${selectedTool.toolKind}:${selectedTool.name}:${selectedToolCatalogEntry?.sortOrder ?? 'new'}`}
                  tool={selectedTool}
                  entry={selectedToolCatalogEntry}
                  isSubmitting={Boolean(isToolCatalogSubmitting)}
                  onSave={onUpsertToolCatalogEntry}
                  onDelete={onDeleteToolCatalogEntry}
                />
                <p className="panel__muted">
                  Override 只改变目录展示、排序和管理元数据；工具的 handler、schema 和审批边界仍来自 in-repo Provider。
                </p>
              </div>
            </LiquidGlassSurface>
          ) : null}

          <LiquidGlassSurface as="section" variant="panel" className="panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Trial Run</div>
                <h2>最近试运行结果</h2>
              </div>
              <Activity size={16} aria-hidden="true" />
            </div>
            <div className="panel__section">
              <pre className="debug-pre">{toolRunResult ? JSON.stringify(toolRunResult, null, 2) : '暂无工具运行结果。'}</pre>
            </div>
          </LiquidGlassSurface>
        </main>
      </div>
    </section>
  )
}

function OverviewCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint: string
}) {
  return (
    <LiquidGlassSurface as="article" variant="chip" className="overview-card tool-management__overview-card">
      <span className="tool-management__overview-icon">
        <Icon size={17} aria-hidden="true" />
      </span>
      <div>
        <span className="overview-card__label">{label}</span>
        <strong className="overview-card__value">{value}</strong>
        <p className="overview-card__footer">{hint}</p>
      </div>
    </LiquidGlassSurface>
  )
}

function DocShortcut({
  icon: Icon,
  title,
  pathValue,
}: {
  icon: LucideIcon
  title: string
  pathValue: string
}) {
  return (
    <button
      className="tool-doc-card"
      type="button"
      title={`点击复制路径：${pathValue}`}
      onClick={() => {
        void navigator.clipboard?.writeText(pathValue).catch(() => undefined)
      }}
    >
      <span className="tool-doc-card__icon"><Icon size={16} aria-hidden="true" /></span>
      <span className="tool-doc-card__body">
        <strong>{title}</strong>
        <small>{pathValue}</small>
      </span>
      <ArrowUpRight size={15} aria-hidden="true" />
    </button>
  )
}

function StatefulToolCatalogEditor({
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
    <ToolCatalogEditor
      tool={tool}
      entry={entry}
      draft={draft}
      sortOrder={sortOrder}
      error={error}
      isSubmitting={isSubmitting}
      onDraftChange={setDraft}
      onSortOrderChange={setSortOrder}
      onErrorChange={setError}
      onSave={onSave}
      onDelete={onDelete}
    />
  )
}

function buildSchemaPreview(tool: ToolDescriptor) {
  const rawSchema = tool.meta.jsonSchema
  if (isRecord(rawSchema)) {
    return rawSchema
  }
  const required = tool.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.key)
  const properties = tool.parameters.reduce<Record<string, Record<string, unknown>>>((accumulator, parameter) => {
    accumulator[parameter.key] = {
      title: parameter.label,
      type: parameter.dataType,
      description: parameter.description,
      default: parameter.defaultValue,
      enum: parameter.options.length ? parameter.options.map((option) => option.value) : undefined,
      'x-source': parameter.source,
    }
    return accumulator
  }, {})
  return {
    type: 'object',
    required,
    properties,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
