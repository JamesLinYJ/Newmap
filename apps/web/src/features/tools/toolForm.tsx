// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具表单共享组件
//
//   文件:       toolForm.tsx
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 提供工具管理页和 DebugPage 共用的参数编辑、valueRef 选择、目录 override
// 编辑与 JSON 参数解析逻辑。表单只持有用户编辑态，工具事实来自服务端 descriptor。

import type { Dispatch, SetStateAction } from 'react'
import { LoaderCircle, Play, Save, Trash2 } from 'lucide-react'
import type {
  ArtifactRef,
  LayerDescriptor,
  ToolDescriptor,
  ToolParameterDescriptor,
  ToolValueRef,
} from '@geo-agent-platform/shared-types'
import {
  buildCollectionOptions,
  resolveToolDefaults,
  type ToolFormState,
} from './toolFormState'

interface ToolParameterFormProps {
  tool: ToolDescriptor
  values: Record<string, string>
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  valueRefs: ToolValueRef[]
  onValuesChange: Dispatch<SetStateAction<Record<string, Record<string, string>>>>
}

export function ToolParameterForm({
  tool,
  values,
  artifacts,
  layers,
  valueRefs,
  onValuesChange,
}: ToolParameterFormProps) {
  const collectionOptions = buildCollectionOptions({ artifacts, layers })
  return (
    <div className="tool-lab__grid">
      {tool.parameters.map((parameter) => (
        <ToolParameterField
          key={`${tool.name}:${parameter.key}`}
          parameter={parameter}
          value={values[parameter.key] ?? ''}
          collectionOptions={collectionOptions}
          artifacts={artifacts}
          layers={layers}
          valueRefs={valueRefs}
          onChange={(value) => {
            onValuesChange((current) => ({
              ...current,
              [tool.name]: {
                ...(current[tool.name] ?? resolveToolDefaults(tool)),
                [parameter.key]: value,
              },
            }))
          }}
        />
      ))}
    </div>
  )
}

interface ToolRunControlsProps {
  tool: ToolDescriptor
  formState: ToolFormState
  isSubmitting: boolean
  onRunTool: (tool: ToolDescriptor, args: Record<string, unknown>) => void
}

export function ToolRunControls({ tool, formState, isSubmitting, onRunTool }: ToolRunControlsProps) {
  return (
    <>
      {tool.error ? <div className="clarification-box clarification-box--error">{tool.error}</div> : null}
      {formState.missing.length ? (
        <div className="clarification-box">
          还缺少必填参数：{formState.missing.map((item) => item.label).join('、')}
        </div>
      ) : null}
      {formState.parsed.error ? <div className="clarification-box clarification-box--error">{formState.parsed.error}</div> : null}
      <div className="composer__actions">
        <button
          className="toolbar-button toolbar-button--primary"
          type="button"
          disabled={!tool.available || isSubmitting || formState.missing.length > 0 || Boolean(formState.parsed.error)}
          onClick={() => onRunTool(tool, formState.parsed.args)}
        >
          {isSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          运行工具
        </button>
      </div>
    </>
  )
}

interface ToolCatalogEditorProps {
  tool: ToolDescriptor
  entry?: Record<string, unknown>
  draft: string
  sortOrder: string
  error?: string
  isSubmitting: boolean
  onDraftChange: (value: string) => void
  onSortOrderChange: (value: string) => void
  onErrorChange: (value?: string) => void
  onSave: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDelete: (tool: ToolDescriptor) => void
}

export function ToolCatalogEditor({
  tool,
  entry,
  draft,
  sortOrder,
  error,
  isSubmitting,
  onDraftChange,
  onSortOrderChange,
  onErrorChange,
  onSave,
  onDelete,
}: ToolCatalogEditorProps) {
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
          onChange={(event) => onSortOrderChange(event.target.value)}
        />
      </label>
      <label className="tool-field tool-field--full">
        <span className="composer__label">目录配置 JSON</span>
        <textarea
          className="composer__textarea tool-field__textarea tool-field__textarea--catalog"
          value={draft}
          placeholder='例如：{"label":"缓冲分析 Pro","group":"analysis"}'
          onChange={(event) => {
            onDraftChange(event.target.value)
            onErrorChange(undefined)
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
                onErrorChange('目录配置 JSON 必须是对象。')
                return
              }
              onSave(tool, parsedPayload as Record<string, unknown>, sortOrder.trim() ? Number(sortOrder) : undefined)
            } catch (parseError) {
              onErrorChange(parseError instanceof Error ? parseError.message : '目录配置 JSON 解析失败。')
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
  valueRefs,
  onChange,
}: {
  parameter: ToolParameterDescriptor
  value: string
  collectionOptions: Array<{ label: string; value: string }>
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  valueRefs: ToolValueRef[]
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

  if (parameter.source === 'value_ref') {
    const selectableRefs = parameter.acceptedValueRefKinds.length
      ? valueRefs.filter((reference) => parameter.acceptedValueRefKinds.includes(reference.kind))
      : valueRefs
    return (
      <label className="tool-field">
        <span className="composer__label">{parameter.label}</span>
        <select className="composer__select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择当前运行引用</option>
          {selectableRefs.map((reference) => (
            <option key={reference.refId} value={reference.refId}>
              {reference.label} · {reference.kind}
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

function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}
