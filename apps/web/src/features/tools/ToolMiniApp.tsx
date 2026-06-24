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

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { CheckCircle2, CircleDashed, Download, Layers3, Play, Radar, SlidersHorizontal, Table2 } from 'lucide-react'
import type { ToolDescriptor, ToolValueRef } from '@geo-agent-platform/shared-types'
import { artifactHasDisplaySurface } from '../artifacts/artifactDisplay'
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

interface WorkflowStage {
  label: string
  description: string
  requiredKinds?: string[]
  anyOfKinds?: string[]
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
  const workflow = miniAppWorkflow(kind)
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
      <MiniAppConsole kind={kind} formState={formState} valueRefs={valueRefs} selectedRefs={selectedRefs} />
      <div className="tool-mini-app__workflow" aria-label={`${copy.title} 流程台`}>
        {workflow.map((stage) => {
          const status = workflowStageStatus(stage, valueRefs)
          return (
            <div className={`tool-mini-app__workflow-step ${status.done ? 'is-done' : ''}`} key={stage.label}>
              {status.done ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleDashed size={16} aria-hidden="true" />}
              <div>
                <strong>{stage.label}</strong>
                <p>{stage.description}</p>
                <span>{status.label}</span>
              </div>
            </div>
          )
        })}
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
      <ToolContractSummary tool={tool} formState={formState} />
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

function MiniAppConsole({
  kind,
  formState,
  valueRefs,
  selectedRefs,
}: {
  kind: MiniAppKind
  formState: ToolFormState
  valueRefs: ToolValueRef[]
  selectedRefs: ToolValueRef[]
}) {
  if (kind === 'radar_mosaic_console') {
    return <RadarMosaicConsole valueRefs={valueRefs} selectedRefs={selectedRefs} formState={formState} />
  }
  if (kind === 'rainfall_risk_map_console') {
    return <RainfallRiskConsole formState={formState} selectedRefs={selectedRefs} />
  }
  return <AreaRainfallConsole formState={formState} selectedRefs={selectedRefs} />
}

function RadarMosaicConsole({
  valueRefs,
  selectedRefs,
  formState,
}: {
  valueRefs: ToolValueRef[]
  selectedRefs: ToolValueRef[]
  formState: ToolFormState
}) {
  const stationRefs = valueRefs.filter((reference) => reference.kind === 'radar_station_collection')
  const timeRefs = valueRefs.filter((reference) => reference.kind === 'radar_target_time')
  const strategy = selectedRefs.find((reference) => reference.kind === 'radar_mosaic_strategy')
  return (
    <div className="tool-mini-console tool-mini-console--radar" aria-label="雷达拼图 React 控制台">
      <div className="tool-mini-console__banner">
        <span className="tool-mini-console__live-dot" />
        <strong>Radar Mosaic Agent</strong>
        <small>站点检查 {'->'} 策略推荐 {'->'} 拼图执行 {'->'} NC 对比</small>
      </div>
      <div className="tool-mini-console__grid tool-mini-console__grid--three">
        <ConsoleCard index="01" title="选择数据和时次">
          <SelectPreview label="数据集" value={stationRefs[0]?.label ?? '等待 radar_station_collection'} />
          <SelectPreview label="目标时间" value={timeRefs[0]?.label ?? String(formState.values.target_time_ref ?? '等待候选时次')} />
        </ConsoleCard>
        <ConsoleCard index="02" title="生成智能体建议">
          <div className="tool-mini-console__picker">
            {['覆盖完整优先', '处理速度优先', '图面平滑优先'].map((item, index) => (
              <span className={index === 0 ? 'is-active' : ''} key={item}>{item}</span>
            ))}
          </div>
          <p>推荐结果：{strategy?.label ?? '运行 recommend_radar_mosaic_strategy 后填充'}</p>
        </ConsoleCard>
        <ConsoleCard index="03" title="执行拼图并查看结果">
          <div className="tool-mini-console__algo">
            {['最大反射率', '距离加权', '质量评分', '严格同步'].map((item, index) => (
              <span className={index === 0 ? 'is-active' : ''} key={item}>{item}</span>
            ))}
          </div>
          <p>输出 PNG/NPZ 后，可在结果卡中打开滑块对比。</p>
        </ConsoleCard>
      </div>
    </div>
  )
}

function RainfallRiskConsole({
  formState,
  selectedRefs,
}: {
  formState: ToolFormState
  selectedRefs: ToolValueRef[]
}) {
  const thresholds = thresholdRows(formState)
  return (
    <div className="tool-mini-console tool-mini-console--risk" aria-label="降雨风险区划图 React 控制台">
      <div className="tool-mini-console__grid">
        <ConsoleCard index="01" title="数据与变量">
          <SelectPreview label="NC 数据" value={selectedRefs.find((reference) => reference.kind === 'meteorological_dataset')?.label ?? '等待 dataset_ref'} />
          <SelectPreview label="变量" value={selectedRefs.find((reference) => reference.kind === 'meteorological_variable')?.label ?? '等待 variable_ref'} />
          <SelectPreview label="区划边界" value={selectedRefs.find((reference) => ['meteorological_file', 'feature_collection', 'nowcast_area'].includes(reference.kind))?.label ?? '等待 boundary_ref'} />
        </ConsoleCard>
        <ConsoleCard index="02" title="阈值调色板">
          <div className="tool-mini-palette">
            {thresholds.map((item) => (
              <span key={`${item.label}-${item.min}-${item.max}`} style={{ '--risk-color': item.color } as CSSProperties}>
                <i />
                {item.label}
                <small>{formatThresholdNumber(item.min)} - {formatThresholdNumber(item.max)}</small>
              </span>
            ))}
          </div>
        </ConsoleCard>
        <ConsoleCard index="03" title="出图模式">
          <div className="tool-mini-console__tabs">
            {['区划图', '网格渐变', '对比图'].map((item, index) => (
              <span className={index === 0 ? 'is-active' : ''} key={item}>{item}</span>
            ))}
          </div>
          <p>生成时会同时交付预览 PNG 和地图用 GeoJSON 区划图层。</p>
        </ConsoleCard>
      </div>
    </div>
  )
}

function AreaRainfallConsole({
  formState,
  selectedRefs,
}: {
  formState: ToolFormState
  selectedRefs: ToolValueRef[]
}) {
  const style = isRecord(formState.parsed.args.style) ? formState.parsed.args.style : {}
  const topN = typeof formState.parsed.args.top_n === 'number' ? formState.parsed.args.top_n : 10
  return (
    <div className="tool-mini-console tool-mini-console--table" aria-label="面雨量表格 React 控制台">
      <div className="tool-mini-console__grid">
        <ConsoleCard index="01" title="数据配置">
          <SelectPreview label="NC 文件集合" value={selectedRefs.find((reference) => ['meteorological_file_collection', 'nowcast_sequence'].includes(reference.kind))?.label ?? '等待文件集合'} />
          <SelectPreview label="区划边界" value={selectedRefs.find((reference) => ['meteorological_file', 'feature_collection', 'nowcast_area'].includes(reference.kind))?.label ?? '等待边界'} />
          <SelectPreview label="显示前 N 名" value={`${topN}`} />
        </ConsoleCard>
        <ConsoleCard index="02" title="样式设置">
          <div className="tool-mini-style-grid">
            {[
              ['标题', String(style.titleText ?? '区县面雨量排行')],
              ['标题色', String(style.titleColor ?? '#2E72D6')],
              ['表头底色', String(style.headerBg ?? '#E8F0FA')],
              ['前三名底色', String(style.top3Bg ?? '#FFF2CC')],
            ].map(([label, value]) => (
              <span key={label}><small>{label}</small><strong>{value}</strong></span>
            ))}
          </div>
        </ConsoleCard>
        <ConsoleCard index="03" title="表格预览">
          <table className="tool-mini-table-preview">
            <thead><tr><th>排名</th><th>区域</th><th>最大雨量</th><th>面雨量</th></tr></thead>
            <tbody>
              {[1, 2, 3].map((rank) => (
                <tr key={rank}><td>{rank}</td><td>示例区 {rank}</td><td>{(1.2 / rank).toFixed(3)} mm</td><td>{(0.42 / rank).toFixed(3)} mm</td></tr>
              ))}
            </tbody>
          </table>
          <p>运行后生成 XLSX 下载件和 PNG 表格预览。</p>
        </ConsoleCard>
      </div>
    </div>
  )
}

function ConsoleCard({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <article className="tool-mini-console__card">
      <span>{index}</span>
      <h4>{title}</h4>
      {children}
    </article>
  )
}

function SelectPreview({ label, value }: { label: string; value: string }) {
  return (
    <label className="tool-mini-console__field">
      <span>{label}</span>
      <strong>{value}</strong>
    </label>
  )
}

function thresholdRows(formState: ToolFormState): Array<{ label: string; min: number; max: number; color: string }> {
  const raw = formState.parsed.args.thresholds
  const candidate = isRecord(raw) && Array.isArray(raw.thresholds) ? raw.thresholds : raw
  if (!Array.isArray(candidate)) {
    return [
      { label: '无雨/小雨', min: 0, max: 1.5, color: '#f0f0f0' },
      { label: '短时大雨', min: 1.5, max: 3, color: '#a6d96a' },
      { label: '短时暴雨', min: 3, max: 5, color: '#1a9850' },
      { label: '短时大暴雨', min: 5, max: 8, color: '#fdae61' },
      { label: '短时特大暴雨', min: 12, max: 999, color: '#7a0177' },
    ]
  }
  return candidate.flatMap((item) => {
    if (!isRecord(item)) return []
    const label = typeof item.label === 'string' ? item.label : ''
    const min = Number(item.min)
    const max = Number(item.max)
    const color = typeof item.color === 'string' ? item.color : ''
    if (!label || !Number.isFinite(min) || !Number.isFinite(max) || !/^#[0-9a-f]{6}$/iu.test(color)) return []
    return [{ label, min, max, color }]
  })
}

function formatThresholdNumber(value: number) {
  if (!Number.isFinite(value)) return '--'
  return value >= 100 ? value.toFixed(0) : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
}

function ToolContractSummary({ tool, formState }: { tool: ToolDescriptor; formState: ToolFormState }) {
  const required = tool.parameters.filter((parameter) => parameter.required)
  return (
    <div className="tool-mini-app__contract">
      <div>
        <strong>当前步骤</strong>
        <p>{tool.label} · {tool.name}</p>
      </div>
      <div className="tool-mini-app__contract-grid">
        {required.length ? required.map((parameter) => (
          <span key={parameter.key}>
            {parameter.label}
            {parameter.acceptedValueRefKinds.length ? ` · ${parameter.acceptedValueRefKinds.join(' / ')}` : ''}
          </span>
        )) : <span>该步骤没有必填参数</span>}
      </div>
      {formState.parsed.error ? <p className="tool-mini-app__contract-error">{formState.parsed.error}</p> : null}
    </div>
  )
}

export function ToolMiniAppResult({ toolName, result, artifacts, onSelectArtifact }: ToolMiniAppResultProps) {
  const kind = miniAppKindForTool(toolName)
  if (!kind) return null
  const payload = isRecord(result) ? result : {}
  const imageArtifacts = artifacts.filter((artifact) => (
    artifact.artifactType === 'raster_png' && artifactHasDisplaySurface(artifact, 'mini_app')
  ))
  const downloadableArtifacts = artifacts.filter((artifact) => artifactHasDisplaySurface(artifact, 'download'))
  const selectableArtifacts = artifacts.filter((artifact) => (
    artifact.artifactId && artifactHasDisplaySurface(artifact, 'map')
  ))
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
            <figure
              key={artifact.artifactId ?? artifact.uri}
              className="tool-mini-result__preview"
            >
              {artifact.uri ? <img src={artifact.uri} alt={artifact.name ?? '工具结果预览'} /> : null}
              <figcaption>
                {artifact.name ?? artifact.artifactId}
                <em>小工具预览图</em>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {selectableArtifacts.length ? (
        <div className="tool-mini-result__map-actions">
          {selectableArtifacts.map((artifact) => (
            <button
              key={`map-${artifact.artifactId}`}
              type="button"
              onClick={() => artifact.artifactId && onSelectArtifact?.(artifact.artifactId)}
            >
              在地图中查看 {artifact.name ?? artifact.artifactId}
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
    return <FactGrid items={[{ label: '站点', value: stations, wide: stations.length > 14 }, { label: '策略', value: String(payload.strategy ?? '--') }, { label: '数值范围', value: range, wide: range.length > 18 }]} />
  }
  if (toolName === 'render_rainfall_risk_map') {
    const range = isRecord(payload.valueRange) ? `${payload.valueRange.min ?? '--'} ~ ${payload.valueRange.max ?? '--'}` : '--'
    return <FactGrid items={[{ label: '变量', value: String(payload.variable ?? '--') }, { label: '模式', value: String(payload.mapMode ?? '--') }, { label: '数值范围', value: range, wide: range.length > 18 }]} />
  }
  if (toolName === 'generate_area_rainfall_table') {
    const rows = Array.isArray(payload.topRows) ? payload.topRows.length : 0
    return <FactGrid items={[{ label: '区划数', value: String(payload.regionCount ?? '--') }, { label: 'TopN', value: String(payload.topN ?? rows) }, { label: '时间', value: String(payload.timeText ?? '--'), wide: true }]} />
  }
  return null
}

interface FactItem {
  label: string
  value: string
  wide?: boolean
}

function FactGrid({ items }: { items: FactItem[] }) {
  return (
    <div className="tool-mini-result__facts">
      {items.map((item) => (
        <div className={item.wide ? 'is-wide' : undefined} key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
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
  if (toolName === 'render_rainfall_risk_map') return '风险区划图已在小工具中生成预览，区划图层可加入地图侧栏'
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

function miniAppWorkflow(kind: MiniAppKind): WorkflowStage[] {
  if (kind === 'radar_mosaic_console') {
    return [
      {
        label: '文件集合',
        description: '上传或列出雷达 bz2 文件，生成 radar_file_collection。',
        requiredKinds: ['radar_file_collection'],
      },
      {
        label: '站点与时次',
        description: '检查站点文件集，得到 radar_station_collection 和候选时次。',
        requiredKinds: ['radar_station_collection', 'radar_target_time'],
      },
      {
        label: '策略',
        description: '保留原工具的 max / weighted / quality 拼图策略。',
        requiredKinds: ['radar_mosaic_strategy'],
      },
      {
        label: '拼图与对比',
        description: '生成 PNG/NPZ，必要时用 NC 参考图做滑块对比。',
        anyOfKinds: ['radar_mosaic_result', 'radar_mosaic_comparison'],
      },
    ]
  }
  if (kind === 'rainfall_risk_map_console') {
    return [
      {
        label: '数据与变量',
        description: '先检查 NC，生成 dataset 和 variable 引用。',
        requiredKinds: ['meteorological_dataset', 'meteorological_variable'],
      },
      {
        label: '区划边界',
        description: '边界可来自上传 GeoJSON/SHP、FeatureCollection 或短临范围。',
        anyOfKinds: ['meteorological_file', 'feature_collection', 'nowcast_area'],
      },
      {
        label: '阈值调色板',
        description: '定义降雨等级、上下界和颜色。',
        requiredKinds: ['rainfall_risk_thresholds'],
      },
      {
        label: '图件输出',
        description: '输出区划、渐变或对比 PNG。',
        requiredKinds: ['rainfall_risk_map_result'],
      },
    ]
  }
  return [
    {
      label: 'NC 序列',
      description: '选择通用 NC 文件集合或短临序列。',
      anyOfKinds: ['meteorological_file_collection', 'nowcast_sequence'],
    },
    {
      label: '区划边界',
      description: '边界可来自上传文件、FeatureCollection 或短临范围。',
      anyOfKinds: ['meteorological_file', 'feature_collection', 'nowcast_area'],
    },
    {
      label: '样式与排行',
      description: '配置 topN 和表格样式 JSON。',
      requiredKinds: [],
    },
    {
      label: '表格输出',
      description: '生成 Excel 下载件和 PNG 预览。',
      requiredKinds: ['area_rainfall_table_result'],
    },
  ]
}

function workflowStageStatus(stage: WorkflowStage, valueRefs: ToolValueRef[]) {
  const kinds = new Set(valueRefs.map((reference) => reference.kind))
  const required = stage.requiredKinds ?? []
  const anyOf = stage.anyOfKinds ?? []
  const requiredDone = required.every((kind) => kinds.has(kind))
  const anyDone = anyOf.length === 0 || anyOf.some((kind) => kinds.has(kind))
  const done = requiredDone && anyDone
  const missing = [
    ...required.filter((kind) => !kinds.has(kind)),
    ...(anyOf.length && !anyOf.some((kind) => kinds.has(kind)) ? [`任选：${anyOf.join(' / ')}`] : []),
  ]
  return {
    done,
    label: done ? '已准备' : `缺少 ${missing.join('、') || '参数确认'}`,
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
