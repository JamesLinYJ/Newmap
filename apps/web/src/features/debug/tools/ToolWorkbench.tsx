// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具工作台
//
//   文件:       ToolWorkbench.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// DebugPage 内的工具调试功能域。这里管理工具选择、参数编辑和目录
// override；实际工具执行仍通过上层 API 动作进入后端 runtime。

import { useMemo, useState } from 'react'
import { m, type Variants } from 'framer-motion'
import { LoaderCircle, Save, Trash2, Wrench } from 'lucide-react'
import type {
  ArtifactRef,
  LayerDescriptor,
  ToolDescriptor,
  ToolParameterDescriptor,
  WeatherDatasetRecord,
} from '@geo-agent-platform/shared-types'
import { StatusPill } from '../../../shared/components/StatusPill'

interface ToolWorkbenchProps {
  tools: ToolDescriptor[]
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  weatherDatasets: WeatherDatasetRecord[]
  toolRunResult?: Record<string, unknown> | null
  toolCatalogEntries: Array<Record<string, unknown>>
  isToolSubmitting: boolean
  isToolCatalogSubmitting?: boolean
  panelVariants: Variants
  onRunTool: (tool: ToolDescriptor, args: Record<string, unknown>) => void
  onUpsertToolCatalogEntry: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDeleteToolCatalogEntry: (tool: ToolDescriptor) => void
}

export function ToolWorkbench({
  tools,
  artifacts,
  layers,
  weatherDatasets,
  toolRunResult,
  toolCatalogEntries,
  isToolSubmitting,
  isToolCatalogSubmitting,
  panelVariants,
  onRunTool,
  onUpsertToolCatalogEntry,
  onDeleteToolCatalogEntry,
}: ToolWorkbenchProps) {
  const [selectedToolName, setSelectedToolName] = useState('')
  const [toolFormsByName, setToolFormsByName] = useState<Record<string, Record<string, string>>>({})
  const collectionOptions = useMemo(() => buildCollectionOptions({ artifacts, layers }), [artifacts, layers])
  const weatherDatasetOptions = useMemo(() => buildWeatherDatasetOptions(weatherDatasets), [weatherDatasets])
  const groupedTools = useMemo(() => groupTools(tools), [tools])
  const selectedTool =
    tools.find((tool) => tool.name === selectedToolName) ??
    tools.find((tool) => tool.available) ??
    tools[0]
  const selectedToolCatalogEntry = selectedTool
    ? toolCatalogEntries.find(
        (entry) => String(entry.toolName ?? '') === selectedTool.name && String(entry.toolKind ?? '') === selectedTool.toolKind,
      )
    : undefined
  const toolFormValues = selectedTool ? toolFormsByName[selectedTool.name] ?? resolveToolDefaults(selectedTool) : {}
  const missingToolParameters = selectedTool ? getMissingRequiredParameters(selectedTool, toolFormValues) : []

  return (
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
                  weatherDatasetOptions={weatherDatasetOptions}
                  onChange={(value) => {
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
                disabled={!selectedTool.available || isToolSubmitting || missingToolParameters.length > 0}
                onClick={() => onRunTool(selectedTool, buildToolArgs(selectedTool, toolFormValues))}
              >
                {isToolSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Wrench size={16} aria-hidden="true" />}
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
  weatherDatasetOptions,
  onChange,
}: {
  parameter: ToolParameterDescriptor
  value: string
  collectionOptions: Array<{ label: string; value: string }>
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  weatherDatasetOptions: Array<{ label: string; value: string }>
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

  if (parameter.source === 'weather-dataset') {
    return (
      <label className="tool-field">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择气象数据集</option>
          {weatherDatasetOptions.map((option) => (
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

function buildWeatherDatasetOptions(datasets: WeatherDatasetRecord[]) {
  return datasets.map((dataset) => ({
    label: `${dataset.filename} · ${formatWeatherDatasetCapability(dataset)} · ${shortId(dataset.datasetId)}`,
    value: dataset.datasetId,
  }))
}

function formatWeatherDatasetCapability(dataset: WeatherDatasetRecord) {
  if (dataset.status !== 'completed') {
    return formatRunStatus(dataset.status)
  }
  const variables = Array.isArray(dataset.metadata.variables) ? dataset.metadata.variables : []
  const mapReady = variables.filter((item) => Boolean((item as { mapReady?: unknown })?.mapReady)).length
  const analysisReady = variables.filter((item) => Boolean((item as { analysisReady?: unknown })?.analysisReady)).length
  if (variables.length) {
    return `${variables.length} 变量 · ${analysisReady} 可统计 · ${mapReady} 可制图`
  }
  return '变量待识别'
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
    meteorology: '气象分析',
    output: '导出',
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
