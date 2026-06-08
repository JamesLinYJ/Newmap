// +-------------------------------------------------------------------------
//
//   地理智能平台 - AppShell 派生状态工具
//
//   文件:       derivedState.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// AppShell 的纯派生逻辑：状态文案、上传分类、数据引用摘要、
// 进度投影和地图结果描述。这里不发起 API 请求，也不持有 React state。

import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ExecutionPlan,
  LayerDescriptor,
  RunEvent,
  UserIntent,
} from '@geo-agent-platform/shared-types'
import type { DataReferenceSummary } from '../shared/constants'
import type { PanelMode, PrimaryNav, UploadReference } from './types'

const LAYER_FILE_SUFFIXES = new Set(['.geojson', '.json', '.gpkg', '.zip'])
const WEATHER_FILE_SUFFIXES = new Set(['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5', '.bz2'])

export function formatTopBarRunStatus(status?: string) {
  if (status === 'completed') {
    return '分析完成'
  }
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'running') {
    return '执行中'
  }
  if (status === 'failed') {
    return '运行失败'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'cancelled') {
    return '已取消'
  }
  return '准备就绪'
}

export function formatPrimaryNav(nav: PrimaryNav) {
  if (nav === 'analysis') {
    return '分析工作台'
  }
  if (nav === 'layers') {
    return '图层视图'
  }
  if (nav === 'history') {
    return '历史追踪'
  }
  return '计算扩展'
}

export function formatPanelMode(mode: PanelMode) {
  if (mode === 'summary') {
    return '结果摘要'
  }
  if (mode === 'layers') {
    return '图层明细'
  }
  if (mode === 'history') {
    return '执行历史'
  }
  if (mode === 'compute') {
    return '计算工作区'
  }
  if (mode === 'sources') {
    return '数据源面板'
  }
  if (mode === 'export') {
    return '导出面板'
  }
  return '系统配置'
}

export function mergeThreadRuns(currentRuns: AnalysisRun[], incomingRun: AnalysisRun) {
  // 线程运行合并
  //
  // 新 run 启动后先把它乐观并入当前 thread 视图，
  // 这样首页在 SSE 继续推进前也能保持对话连续。
  const byId = new Map<string, AnalysisRun>()
  for (const item of currentRuns) {
    byId.set(item.id, item)
  }
  byId.set(incomingRun.id, incomingRun)
  return [...byId.values()].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return left.id.localeCompare(right.id)
    }
    return leftTime - rightTime
  })
}

export function classifyUploadFile(file: File): UploadReference['kind'] | undefined {
  }
  if (isLayerFile(file)) {
    return 'layer'
  }
  return undefined
}

export function isLayerFile(file: File) {
  const name = file.name.toLowerCase()
  return [...LAYER_FILE_SUFFIXES].some((suffix) => name.endsWith(suffix))
}

  const name = file.name.toLowerCase()
  return [...WEATHER_FILE_SUFFIXES].some((suffix) => name.endsWith(suffix))
}

export function getUploadRelativePath(file: File) {
  const relativePath = 'webkitRelativePath' in file ? String(file.webkitRelativePath || '') : ''
  return relativePath || file.name
}

export function makeUploadReferenceId(kind: UploadReference['kind'], relativePath: string, file: File) {
  return `${kind}:${relativePath}:${file.size}:${file.lastModified}`
}

export function upsertUploadReference(current: UploadReference[], incoming: UploadReference) {
  const next = current.filter((item) => item.id !== incoming.id)
  return [incoming, ...next].slice(0, 80)
}

  const byId = new Map(current.map((item) => [item.datasetId, item]))
  byId.set(incoming.datasetId, incoming)
  return [...byId.values()].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
}

export function buildDataReferences({
  layers,
  uploadReferences,
  artifacts,
  threadRuns,
  currentThreadId,
}: {
  layers: LayerDescriptor[]
  uploadReferences: UploadReference[]
  artifacts: ArtifactRef[]
  threadRuns: ReadonlyArray<AnalysisRun>
  currentThreadId?: string
}): DataReferenceSummary[] {
  // 数据引用摘要
  //
  // 聊天面板只展示当前 thread 关联的数据引用：上传队列、本 thread run
  // 产出的 artifact。session 级图层/气象数据只在有活跃 thread 时才展示，
  // 避免新建对话时看到旧 thread 的上传数据。
  const result: DataReferenceSummary[] = []
  const seen = new Set<string>()
  const layerByName = new Map(layers.map((layer) => [layer.name, layer]))
  const threadArtifactIds = new Set(
    threadRuns.flatMap((item) => item.state.artifacts.map((artifact) => artifact.artifactId)),
  )

  for (const item of uploadReferences) {
    const key = `${item.kind}:${item.relativePath ?? item.name}`
    seen.add(key)
    seen.add(`${item.kind}:${item.name}`)
    const matchedLayer = item.kind === 'layer' ? layerByName.get(item.name) : undefined
    result.push({
      id: `upload:${item.id}`,
      kind: item.kind,
      name: item.name,
      relativePath: item.relativePath,
    })
  }

  // session 级图层和气象数据只在有活跃 thread 上下文时才展示；
  // 没有 thread 上下文时跳过，避免新建对话看到旧 thread 的数据。
  if (currentThreadId) {
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      result.push({
        name: dataset.filename,
      })
    }

    for (const layer of layers) {
      if (!layer.sessionId && !layer.sourceType.startsWith('session_') && layer.sourceType !== 'upload') {
        continue
      }
      const key = `layer:${layer.name}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      result.push({
        id: `layer:${layer.layerKey}`,
        kind: 'layer',
        name: layer.name,
        status: layer.status === 'active' ? '可用' : layer.status,
        detail: `${layer.featureCount ?? 0} 个对象 · ${layer.geometryType || '图层'}`,
      })
    }
  }

  for (const artifact of artifacts) {
    if (!threadArtifactIds.has(artifact.artifactId)) {
      continue
    }
    const key = `artifact:${artifact.artifactId}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push({
      id: key,
      kind: 'artifact',
      name: artifact.name,
      status: '结果',
      detail: artifact.artifactType === 'raster_png' ? '栅格结果' : artifact.artifactType,
    })
  }

  return result.slice(0, 80)
}

  const variables = Array.isArray(dataset.metadata.variables) ? dataset.metadata.variables : []
  if (!variables.length && dataset.status === 'uploaded') {
    return '开始分析时解析'
  }
  const names = variables
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name?: unknown }).name ?? '') : ''))
    .filter(Boolean)
    .slice(0, 3)
  const variableLabel = names.length ? names.join(' / ') : '变量待识别'
  const mapReady = variables.filter((item) => Boolean((item as { mapReady?: unknown })?.mapReady)).length
  const analysisReady = variables.filter((item) => Boolean((item as { analysisReady?: unknown })?.analysisReady)).length
  const capabilityLabel = variables.length ? ` · ${analysisReady} 可统计 · ${mapReady} 可制图` : ''
  return `${variableLabel}${variables.length > names.length ? ` 等 ${variables.length} 个变量` : ''}${capabilityLabel}`
}

export function formatReferenceKind(kind: UploadReference['kind']) {
}

export function uploadStatusLabel(status: string) {
  if (status === 'pending') return '等待上传'
  if (status === 'uploading') return '上传中'
  if (status === 'ready') return '可用'
}

  if (status === 'uploaded') {
    return '已上传，开始分析时解析'
  }
}

  if (status === 'uploaded') return '已上传'
  if (status === 'completed') return '解析完成'
  if (status === 'failed') return '失败'
  if (status === 'running') return '解析中'
  if (status === 'queued') return '等待解析'
  return status || '已接入'
}

export function formatFileSize(size: number) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${size} B`
}

export type ProgressTodoItem = { id: string; content: string; status: string; activeForm: string }

export function buildAgentTodoItems(
  agentState: AgentState | undefined,
  executionPlan: ExecutionPlan | undefined,
  runStatus?: AnalysisRun['status'],
): ProgressTodoItem[] {
  // Todo 面板只投影后端事实源。
  //
  // 优先使用 todo_write 写回的 AgentState.todos；如果计划模式只提交了
  // executionPlan，则把计划步骤作为只读任务清单展示，不额外发明进度。
  const rawTodos = agentState?.todos ?? []
  if (rawTodos.length) {
    return rawTodos
      .map((todo, index) => {
        const record = todo as typeof todo & Record<string, unknown>
        const content = String(record.title ?? record.content ?? `待办 ${index + 1}`)
        const activeForm = String(record.activeForm ?? record.active_form ?? record.description ?? content)
        return {
          id: String(record.todoId ?? record.todo_id ?? record.id ?? `todo:${index + 1}`),
          content,
          status: normalizeTodoStatus(String(record.status ?? 'pending')),
          activeForm,
        }
      })
      .filter((item) => item.content.trim())
  }

  const steps = executionPlan?.steps ?? []
  if (!steps.length) {
    return []
  }
  const completed = runStatus === 'completed'
  return steps.map((step, index) => ({
    id: step.id || `plan-step:${index + 1}`,
    content: step.reason || step.tool || `计划步骤 ${index + 1}`,
    status: completed ? 'completed' : index === 0 && runStatus === 'running' ? 'running' : 'pending',
    activeForm: step.tool ? `准备调用 ${step.tool}` : '准备执行计划步骤',
  }))
}

export function normalizeTodoStatus(status: string) {
  if (status === 'in_progress' || status === 'doing') return 'running'
  if (status === 'done') return 'completed'
  return status || 'pending'
}

export function buildProgressItems({
  runStatus,
  intent,
  executionPlan,
  artifacts,
  events,
}: {
  runStatus?: AnalysisRun['status']
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  artifacts: ArtifactRef[]
  events: RunEvent[]
}) {
  const latestEvent = events.at(-1)
  const hasWorkStarted = events.length > 0 || runStatus === 'running' || runStatus === 'completed'

  return [
    {
      id: 'understand',
      title: '理解需求',
      description:
        intent?.clarificationRequired
          ? '系统已经识别出问题，但还需要补充确认。'
          : intent
            ? '已识别本轮问题里的地点、对象和空间关系。'
            : '等待输入问题后开始整理分析意图。',
      status:
        runStatus === 'clarification_needed'
          ? ('warning' as const)
          : intent
            ? ('done' as const)
            : hasWorkStarted
              ? ('active' as const)
              : ('pending' as const),
    },
    {
      id: 'prepare',
      title: '准备数据',
      description:
        executionPlan?.steps.length
          ? `已经整理出 ${executionPlan.steps.length} 个分析步骤。`
          : '会按当前目录、上传图层或外部来源准备数据。',
      status: executionPlan?.steps.length ? ('done' as const) : hasWorkStarted ? ('active' as const) : ('pending' as const),
    },
    {
      id: 'analyze',
      title: '执行分析',
      description:
        runStatus === 'running'
          ? formatUiRunEventMessage(latestEvent)
          : runStatus === 'waiting_approval'
            ? '分析已经完成，系统正在等待你确认发布或执行敏感操作。'
          : artifacts.length
            ? '空间分析已经完成，结果正在整理。'
            : '需要空间计算时，会基于真实工具执行。',
      status:
        runStatus === 'running' || runStatus === 'waiting_approval'
          ? ('active' as const)
          : artifacts.length || runStatus === 'completed'
            ? ('done' as const)
            : runStatus === 'failed'
              ? ('warning' as const)
              : ('pending' as const),
    },
    {
      id: 'deliver',
      title: '交付结果',
      description:
        runStatus === 'completed'
          ? '结果图层、下载入口和服务链接已经生成。'
          : runStatus === 'waiting_approval'
            ? '结果已经生成，待审批动作会在确认后继续执行。'
          : runStatus === 'failed'
            ? '本次没有成功生成最终结果。'
            : '完成后会自动把结果高亮到地图上。',
      status:
        runStatus === 'completed'
          ? ('done' as const)
          : runStatus === 'waiting_approval'
            ? ('warning' as const)
          : runStatus === 'failed'
            ? ('warning' as const)
            : runStatus === 'running'
              ? ('active' as const)
              : ('pending' as const),
    },
  ] as const
}

export function formatUiRunEventMessage(event?: RunEvent) {
  if (!event) {
    return '系统正在自动处理你的问题。'
  }
  if (event.type === 'intent.parsed') {
    return '正在识别地点、范围和目标数据。'
  }
  if (event.type === 'plan.ready') {
    return '分析步骤已经确定，马上开始计算。'
  }
  if (event.type === 'artifact.created') {
    return '已经生成新的地图结果，正在加入地图。'
  }
  if (event.type === 'approval.required') {
    return '分析结果已生成，正在等待审批。'
  }
  if (event.type === 'clarification.required') {
    return '需要你确认一个选项后继续。'
  }
  if (event.type === 'run.failed') {
    return '分析没有顺利完成，请稍后重试。'
  }
  return event.message
}

export function describeCollectionGeometry(collection?: GeoJSON.FeatureCollection) {
  if (!collection?.features.length) {
    return '空图层'
  }
  const geometryTypes = Array.from(
    new Set(
      collection.features
        .map((feature) => feature.geometry?.type)
        .filter((value): value is NonNullable<GeoJSON.Geometry['type']> => Boolean(value)),
    ),
  )
  if (!geometryTypes.length) {
    return '未知几何'
  }
  return geometryTypes.join(' / ')
}

export function parseRasterCoordinates(value: unknown): [[number, number], [number, number], [number, number], [number, number]] | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined
  }
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      return undefined
    }
    const lng = Number(point[0])
    const lat = Number(point[1])
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as [number, number] : undefined
  })
  return points.every(Boolean) ? points as [[number, number], [number, number], [number, number], [number, number]] : undefined
}

export function describeRasterMetadata(metadata: Record<string, unknown>) {
  const variable = typeof metadata.variable === 'string' ? metadata.variable : '气象栅格'
  const valueRange = Array.isArray(metadata.valueRange) ? metadata.valueRange.map(Number).filter(Number.isFinite) : []
  if (valueRange.length >= 2) {
    return `${variable} · ${valueRange[0].toFixed(2)} - ${valueRange[1].toFixed(2)}`
  }
  return variable
}
