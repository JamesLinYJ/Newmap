// +-------------------------------------------------------------------------
//
//   地理智能平台 - 第三方气象工具 Mini-App
//
//   文件:       ToolMiniApp.tsx
//
//   日期:       2026年06月23日
//   作者:       Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 在工具管理页、DebugPage 和对话工具卡片中还原第三方小工具体验。
// 组件只展示流程与结果，执行仍由上层统一工具运行入口负责。

import { useMemo, useState } from 'react'
import { Download, Layers3, Play, Radar, SlidersHorizontal, Table2 } from 'lucide-react'
import type { ToolDescriptor, ToolValueRef } from '@geo-agent-platform/shared-types'
import type { ToolFormState } from './toolFormState'
import { miniAppKindForTool, type MiniAppKind } from './toolMiniAppModel'

interface ToolMiniAppPanelProps {
  tool: ToolDescriptor
  formState: ToolFormState
  valueRefs: ToolValueRef[]
  isSubmitting: boolean
  onRunTool: (tool: ToolDescriptor, args: Record<string, unknown>) => void
}

interface ToolMiniAppResultProps {
  toolName?: string | null
  result: unknown
  artifacts: MiniArtifact[]
  onSelectArtifact?: (id: string) => void
}

interface MiniArtifact {
  artifactId?: string
  artifactType?: string
  name?: string
  uri?: string
  metadata?: Record<string, unknown>
}

export function ToolMiniAppPanel({
  tool,
  formState,
  valueRefs,
  isSubmitting,
  onRunTool,
}: ToolMiniAppPanelProps) {
  const kind = miniAppKindForTool(tool.name)
  const selectedRefs = useMemo(
    () => Object.values(formState.values)
      .map((refId) => valueRefs.find((reference) => reference.refId === refId))
      .filter((reference): reference is ToolValueRef => Boolean(reference)),
    [formState.values, valueRefs],
  )
  if (!kind) return null
  const copy = miniAppCopy(kind)
  const canRun = tool.available && !isSubmitting && !formState.missing.length && !formState.parsed.error
  return (
    <section className={`tool-mini-app tool-mini-app--${kind}`}>
      <div className="tool-mini-app__hero">
        <span className="tool-mini-app__icon">{miniAppIcon(kind)}</span>
        <div>
          <div className="panel__eyebrow">{copy.eyebrow}</div>
          <h3>{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
      </div>
      <div className="tool-mini-app__steps">
        {copy.steps.map((step, index) => (
          <div className="tool-mini-app__step" key={step}>
            <span>{index + 1}</span>
            <p>{step}</p>
          </div>
        ))}
      </div>
      <div className="tool-mini-app__state">
        <strong>当前引用</strong>
        {selectedRefs.length ? (
          <div className="tool-mini-app__chips">
            {selectedRefs.map((reference) => (
              <span key={reference.refId}>{reference.label} · {reference.kind}</span>
            ))}
          </div>
        ) : (
          <p>请在下方参数表单选择 valueRef，mini-app 会按契约只接收可用引用。</p>
        )}
      </div>
      <button
        className="toolbar-button toolbar-button--primary tool-mini-app__run"
        type="button"
        disabled={!canRun}
        onClick={() => onRunTool(tool, formState.parsed.args)}
      >
        <Play size={15} aria-hidden="true" />
        运行当前步骤
      </button>
    </section>
  )
}

export function ToolMiniAppResult({ toolName, result, artifacts, onSelectArtifact }: ToolMiniAppResultProps) {
  const kind = miniAppKindForTool(toolName)
  if (!kind) return null
  const payload = isRecord(result) ? result : {}
  const imageArtifacts = artifacts.filter((artifact) => artifact.artifactType === 'raster_png')
  const downloadableArtifacts = artifacts.filter((artifact) => artifact.artifactType !== 'raster_png')
  return (
    <section className={`tool-mini-result tool-mini-result--${kind}`}>
      <div className="tool-mini-result__header">
        <span className="tool-mini-app__icon">{miniAppIcon(kind)}</span>
        <div>
          <strong>{miniAppCopy(kind).title}</strong>
          <p>{resultSummary(toolName, payload)}</p>
        </div>
      </div>
      {toolName === 'compare_radar_mosaic_reference' && imageArtifacts.length >= 2 ? (
        <ImageSlider artifacts={imageArtifacts} />
      ) : imageArtifacts.length ? (
        <div className="tool-mini-result__preview-grid">
          {imageArtifacts.map((artifact) => (
            <button
              key={artifact.artifactId ?? artifact.uri}
              className="tool-mini-result__preview"
              type="button"
              onClick={() => artifact.artifactId && onSelectArtifact?.(artifact.artifactId)}
            >
              {artifact.uri ? <img src={artifact.uri} alt={artifact.name ?? '工具结果预览'} /> : null}
              <span>{artifact.name ?? artifact.artifactId}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ResultFacts toolName={toolName} payload={payload} />
      {downloadableArtifacts.length ? (
        <div className="tool-mini-result__downloads">
          {downloadableArtifacts.map((artifact) => (
            <a
              key={artifact.artifactId ?? artifact.uri}
              href={artifact.uri ?? '#'}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={14} aria-hidden="true" />
              {artifact.name ?? artifact.artifactType ?? '下载结果'}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ImageSlider({ artifacts }: { artifacts: MiniArtifact[] }) {
  const [split, setSplit] = useState(50)
  const base = artifacts[0]
  const overlay = artifacts[1]
  return (
    <div className="tool-mini-slider">
      <div className="tool-mini-slider__canvas">
        {base.uri ? <img src={base.uri} alt={base.name ?? '底图'} /> : null}
        {overlay.uri ? (
          <div className="tool-mini-slider__overlay" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
            <img src={overlay.uri} alt={overlay.name ?? '覆盖图'} />
          </div>
        ) : null}
        <span className="tool-mini-slider__handle" style={{ left: `${split}%` }} />
      </div>
      <input
        type="range"
        min={5}
        max={95}
        value={split}
        aria-label="对比滑块"
        onChange={(event) => setSplit(Number(event.target.value))}
      />
    </div>
  )
}

function ResultFacts({ toolName, payload }: { toolName?: string | null; payload: Record<string, unknown> }) {
  if (toolName === 'render_radar_mosaic') {
    const stations = Array.isArray(payload.stationsUsed) ? payload.stationsUsed.join('、') : '未返回'
    const range = isRecord(payload.valueRange) ? `${payload.valueRange.min ?? '--'} ~ ${payload.valueRange.max ?? '--'}` : '--'
    return <FactGrid items={[['站点', stations], ['策略', String(payload.strategy ?? '--')], ['数值范围', range]]} />
  }
  if (toolName === 'render_rainfall_risk_map') {
    const range = isRecord(payload.valueRange) ? `${payload.valueRange.min ?? '--'} ~ ${payload.valueRange.max ?? '--'}` : '--'
    return <FactGrid items={[['变量', String(payload.variable ?? '--')], ['模式', String(payload.mapMode ?? '--')], ['数值范围', range]]} />
  }
  if (toolName === 'generate_area_rainfall_table') {
    const rows = Array.isArray(payload.topRows) ? payload.topRows.length : 0
    return <FactGrid items={[['区划数', String(payload.regionCount ?? '--')], ['TopN', String(payload.topN ?? rows)], ['时间', String(payload.timeText ?? '--')]]} />
  }
  return null
}

function FactGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="tool-mini-result__facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

function resultSummary(toolName: string | null | undefined, payload: Record<string, unknown>) {
  if (toolName === 'inspect_radar_station_collection') return `${payload.fileCount ?? 0} 个雷达文件已检查`
  if (toolName === 'recommend_radar_mosaic_strategy') return String(payload.reason ?? '策略已生成')
  if (toolName === 'render_radar_mosaic') return '拼图 PNG 与 NPZ 数据已生成'
  if (toolName === 'compare_radar_mosaic_reference') return '参考对比图与统计已生成'
  if (toolName === 'define_rainfall_risk_thresholds') return `${Array.isArray(payload.thresholds) ? payload.thresholds.length : 0} 个风险等级`
  if (toolName === 'render_rainfall_risk_map') return '风险区划图已生成，可下载或加入地图侧栏'
  if (toolName === 'generate_area_rainfall_table') return 'Excel 与 PNG 表格已生成'
  return '工具执行完成'
}

function miniAppCopy(kind: MiniAppKind) {
  if (kind === 'radar_mosaic_console') {
    return {
      eyebrow: 'Radar Mosaic',
      title: '雷达拼图控制台',
      description: '复刻原雷达拼图工具的站点检查、策略推荐、拼图执行和 NC 对比流程。',
      steps: ['选择雷达 bz2 文件集合', '检查站点与目标时次', '选择推荐策略', '生成 PNG/NPZ 或执行 NC 对比'],
    }
  }
  if (kind === 'rainfall_risk_map_console') {
    return {
      eyebrow: 'Rainfall Risk',
      title: '降雨风险区划图',
      description: '复刻原区划图工具的变量选择、阈值调色板、区划聚合与对比图输出。',
      steps: ['选择 NC 数据集和变量', '选择边界 valueRef', '确认风险阈值和调色板', '生成区划/渐变/对比图'],
    }
  }
  return {
    eyebrow: 'Area Rainfall',
    title: '面雨量表格',
    description: '复刻原短临面雨量表格的 topN、样式编辑、Excel 和 PNG 输出。',
    steps: ['选择 NC 文件集合或短临序列', '选择区划边界', '配置 topN 和样式 JSON', '生成 XLSX 与图片预览'],
  }
}

function miniAppIcon(kind: MiniAppKind) {
  if (kind === 'radar_mosaic_console') return <Radar size={17} aria-hidden="true" />
  if (kind === 'rainfall_risk_map_console') return <Layers3 size={17} aria-hidden="true" />
  if (kind === 'area_rainfall_table_console') return <Table2 size={17} aria-hidden="true" />
  return <SlidersHorizontal size={17} aria-hidden="true" />
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
