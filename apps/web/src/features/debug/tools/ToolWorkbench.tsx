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
import type {
  ArtifactRef,
  LayerDescriptor,
  ToolDescriptor,
  ToolValueRef,
} from '@geo-agent-platform/shared-types'
import { StatusPill } from '../../../shared/components/StatusPill'
import {
  ToolCatalogEditor,
  ToolParameterForm,
  ToolRunControls,
} from '../../tools/toolForm'
import {
  buildToolFormState,
  resolveToolDefaults,
} from '../../tools/toolFormState'
import { groupToolsForManagement } from '../../tools/toolManagementModel'
import { ToolMiniAppPanel } from '../../tools/ToolMiniApp'

interface ToolWorkbenchProps {
  tools: ToolDescriptor[]
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  valueRefs: ToolValueRef[]
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
  valueRefs,
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
  const groupedTools = useMemo(() => groupToolsForManagement(tools), [tools])
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
  const formState = selectedTool
    ? buildToolFormState(selectedTool, toolFormValues)
    : { values: {}, missing: [], parsed: { args: {}, error: null } }

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
          <div className="panel__section">
            <div className="panel__subheader">
              <span>参数预览</span>
              <span className="panel__muted">{selectedTool.parameters.length} 个参数</span>
            </div>
            <pre className="debug-pre">{formState.parsed.error ? formState.parsed.error : JSON.stringify(formState.parsed.args, null, 2)}</pre>
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
          <StatefulToolCatalogEditor
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
