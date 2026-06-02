// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 客户端
//
//   文件:       api.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 封装前端对后端 REST 接口的请求入口与统一错误处理。

import type {
  AgentRuntimeConfig,
  AnalysisRun,
  AgentThreadRecord,
  ArtifactRef,
  BasemapDescriptor,
  LayerDescriptor,
  ModelProviderDescriptor,
  RunEvent,
  SessionRecord,
  SystemComponentsStatus,
  ToolDescriptor,
  WeatherDatasetRecord,
  WeatherJobRecord,
} from '@geo-agent-platform/shared-types'

// API 地址解析
//
// 前端不推断 API 端口：显式 VITE_API_BASE_URL 代表跨端口/跨域 API；
// 未配置时使用同源相对路径，由部署入口或 Vite proxy 决定实际后端。
export function deriveApiBaseUrl(envBaseUrl?: string) {
  const explicit = envBaseUrl?.trim()
  if (!explicit || explicit === '/') {
    return ''
  }
  return explicit.replace(/\/+$/u, '')
}

const API_BASE_URL = deriveApiBaseUrl(import.meta.env.VITE_API_BASE_URL)
const API_BASE_LABEL = API_BASE_URL || '同源相对地址'

export const apiBaseUrl = API_BASE_URL

// 错误消息格式化
//
// 把网络层异常和后端 detail 统一整理成前端可直接展示的中文提示。
function formatApiErrorMessage(prefix: string, detail?: string) {
  return detail?.trim() ? `${prefix}：${detail.trim()}` : prefix
}

async function extractErrorDetail(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const payload = (await response.json()) as { detail?: unknown; error?: unknown; message?: unknown }
      const detail = payload.detail ?? payload.error ?? payload.message
      if (typeof detail === 'string' && detail.trim()) {
        return detail
      }
      if (Array.isArray(detail)) {
        return detail.map((item) => String(item)).join('；')
      }
      return JSON.stringify(payload)
    } catch {
      return response.statusText || `HTTP ${response.status}`
    }
  }

  const text = await response.text()
  return text.trim() || response.statusText || `HTTP ${response.status}`
}

async function requestJson<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  // 通用 JSON 请求入口。
  let response: Response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = new Headers(init?.headers ?? {})
    if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(formatApiErrorMessage(`请求超时（${path}），请检查 API 服务是否响应正常。`, detail))
    }
    throw new Error(formatApiErrorMessage(`暂时无法连接分析服务，请确认本地 API 或部署代理已经启动（接口：${path}，当前地址：${API_BASE_LABEL}）`, detail))
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response))
  }

  return (await response.json()) as T
}

async function requestFormJson<T>(path: string, body: FormData, failurePrefix: string, timeoutMs = 120_000): Promise<T> {
  // FormData 请求同样走统一超时和错误提取。
  //
  // 图层上传、后台导入和数据替换都可能传较大文件；这里不给它们另起一套
  // 网络语义，避免图层管理在端口/代理异常时只抛出浏览器原始 TypeError。
  let response: Response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      body,
      signal: controller.signal,
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(formatApiErrorMessage(`${failurePrefix}超时（接口：${path}）。`, detail))
    }
    throw new Error(formatApiErrorMessage(`${failurePrefix}，请确认本地 API 或部署代理已经启动（接口：${path}，当前地址：${API_BASE_LABEL}）`, detail))
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response))
  }

  return (await response.json()) as T
}

export function createSession() {
  // 会话是工作台的最外层容器，首页首次进入先拿到它。
  return requestJson<SessionRecord>('/api/v1/sessions', {
    method: 'POST',
  })
}

export function getSession(sessionId: string) {
  return requestJson<SessionRecord>(`/api/v1/sessions/${sessionId}`)
}

export function listSessionThreads(sessionId: string) {
  // 任务历史现在以 thread 作为主索引，而不是把每次 run 都当成独立任务。
  return requestJson<AgentThreadRecord[]>(`/api/v1/sessions/${sessionId}/threads`)
}

export function createThread(sessionId: string, title?: string) {
  // v2 thread/run 模型下，thread 负责承接多轮上下文与历史恢复。
  return requestJson<AgentThreadRecord>('/api/v2/threads', {
    method: 'POST',
    body: JSON.stringify({ sessionId, title }),
  })
}

export function getThread(threadId: string) {
  return requestJson<{ thread: AgentThreadRecord; runs: AnalysisRun[]; latestRun?: AnalysisRun | null }>(`/api/v2/threads/${threadId}`)
}

export function updateThread(threadId: string, title: string) {
  return requestJson<AgentThreadRecord>(`/api/v2/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export function deleteThread(threadId: string) {
  return requestJson<{ deleted: boolean; threadId: string }>(`/api/v2/threads/${threadId}`, {
    method: 'DELETE',
  })
}

export function listSessionRuns(sessionId: string) {
  return requestJson<AnalysisRun[]>(`/api/v1/sessions/${sessionId}/runs`)
}

export function listLayers(sessionId?: string | null, threadId?: string | null) {
  const params = new URLSearchParams({ includeInactive: 'true' })
  if (sessionId) {
    params.set('sessionId', sessionId)
  }
  if (threadId) {
    params.set('threadId', threadId)
  }
  return requestJson<LayerDescriptor[]>(`/api/v1/layers?${params.toString()}`)
}

export function createLayer(payload: Record<string, unknown>) {
  return requestJson<LayerDescriptor>('/api/v1/layers', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateLayer(layerKey: string, payload: Record<string, unknown>) {
  return requestJson<LayerDescriptor>(`/api/v1/layers/${encodeURIComponent(layerKey)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteLayer(layerKey: string) {
  return requestJson<{ deleted: boolean; layerKey: string }>(`/api/v1/layers/${encodeURIComponent(layerKey)}`, {
    method: 'DELETE',
  })
}

export function listBasemaps() {
  return requestJson<BasemapDescriptor[]>('/api/v1/map/basemaps')
}

export function listProviders() {
  return requestJson<ModelProviderDescriptor[]>('/api/v1/providers')
}

export function getSystemComponents() {
  return requestJson<SystemComponentsStatus>('/api/v1/system/components')
}

export function listTools() {
  return requestJson<ToolDescriptor[]>('/api/v1/tools')
}

export function listToolCatalogEntries() {
  return requestJson<Array<Record<string, unknown>>>('/api/v1/tools/catalog')
}

export function getRuntimeConfig() {
  // runtime config 来自后端持久化配置，而不是前端硬编码默认值。
  return requestJson<AgentRuntimeConfig>('/api/v1/runtime/config')
}

export function updateRuntimeConfig(payload: AgentRuntimeConfig) {
  // 调试页保存配置后，前后端都应立即切到同一份结构化配置。
  return requestJson<AgentRuntimeConfig>('/api/v1/runtime/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function upsertToolCatalogEntry(toolKind: string, toolName: string, payload: Record<string, unknown>, sortOrder?: number) {
  return requestJson<Record<string, unknown>>(`/api/v1/tools/catalog/${encodeURIComponent(toolKind)}/${encodeURIComponent(toolName)}`, {
    method: 'PUT',
    body: JSON.stringify({ payload, sortOrder }),
  })
}

export function deleteToolCatalogEntry(toolKind: string, toolName: string) {
  return requestJson<Record<string, unknown>>(`/api/v1/tools/catalog/${encodeURIComponent(toolKind)}/${encodeURIComponent(toolName)}`, {
    method: 'DELETE',
  })
}

export type AgentExecutionMode = 'plan' | 'auto'

export function startAnalysis(sessionId: string, query: string, provider?: string, model?: string, clarificationOptionId?: string | null, executionMode: AgentExecutionMode = 'auto') {
  // v1 仍保留作主工作台入口，内部会启动一次完整 run。
  // 后端会同步调用 LLM 生成线程标题，超时放宽到 60 秒。
  return requestJson<AnalysisRun>('/api/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, query, provider, model, clarificationOptionId, executionMode }),
  }, 60_000)
}

export function startThreadRun(threadId: string, query: string, provider?: string, model?: string, clarificationOptionId?: string | null, executionMode: AgentExecutionMode = 'auto') {
  // v2 明确把“线程”和“运行”拆开，便于任务历史与上下文管理。
  return requestJson<AnalysisRun>(`/api/v2/threads/${threadId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ query, provider, model, clarificationOptionId, executionMode }),
  })
}

export function getRun(runId: string) {
  // 首页和 SSE 断线恢复都依赖这条接口回收最终快照。
  return requestJson<AnalysisRun>(`/api/v1/analysis/${runId}`)
}

export function getThreadRun(runId: string) {
  return requestJson<AnalysisRun>(`/api/v2/runs/${runId}`)
}

export function getRunEvents(runId: string) {
  return requestJson<RunEvent[]>(`/api/v2/runs/${runId}/events.json`)
}

export function getArtifacts(runId: string) {
  return requestJson<ArtifactRef[]>(`/api/v1/analysis/${runId}/artifacts`)
}

export function getArtifactGeoJson(artifactId: string) {
  return requestJson<GeoJSON.FeatureCollection>(`/api/v1/results/${artifactId}/geojson`)
}

export function getArtifactMetadata(artifactId: string) {
  return requestJson<Record<string, unknown>>(`/api/v1/results/${artifactId}/metadata`)
}

export function resolveApproval(runId: string, approvalId: string, approved: boolean) {
  // 审批动作恢复的是被中断的 run，而不是单独起一个新任务。
  return requestJson<AnalysisRun>(`/api/v2/runs/${runId}/approvals/${approvalId}`, {
    method: 'POST',
    body: JSON.stringify({ approved }),
  })
}

export function cancelRun(runId: string) {
  // 中断当前后台 run。后端会取消对应 asyncio task 并回写 cancelled 快照。
  return requestJson<AnalysisRun>(`/api/v2/runs/${runId}/cancel`, {
    method: 'POST',
  }, 10_000)
}

export function runTool(payload: Record<string, unknown>) {
  return requestJson<Record<string, unknown>>('/api/v1/tools/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function uploadLayer(sessionId: string, file: File, threadId?: string | null) {
  // 图层上传走 FormData，避免手动处理二进制序列化。
  const formData = new FormData()
  formData.append('session_id', sessionId)
  if (threadId) {
    formData.append('threadId', threadId)
  }
  formData.append('file', file)

  return requestFormJson<LayerDescriptor>('/api/v1/layers/register', formData, '图层上传请求失败')
}

export async function uploadWeatherDataset(sessionId: string, file: File, threadId?: string | null) {
  // 气象数据文件可能很大，后端会流式落盘并创建后台解析任务。
  const formData = new FormData()
  formData.append('sessionId', sessionId)
  if (threadId) {
    formData.append('threadId', threadId)
  }
  formData.append('file', file)

  return requestFormJson<{ dataset: WeatherDatasetRecord; job?: WeatherJobRecord | null }>(
    '/api/v1/weather/datasets',
    formData,
    '气象数据上传请求失败',
    600_000,
  )
}

export function listWeatherDatasets(sessionId?: string, threadId?: string | null) {
  const params = new URLSearchParams()
  if (sessionId) params.set('sessionId', sessionId)
  if (threadId) params.set('threadId', threadId)
  const query = params.toString()
  return requestJson<WeatherDatasetRecord[]>(`/api/v1/weather/datasets${query ? '?' + query : ''}`)
}

export function getWeatherJob(jobId: string) {
  return requestJson<WeatherJobRecord>(`/api/v1/weather/jobs/${encodeURIComponent(jobId)}`)
}

export function generateWeatherDatasetReport(
  datasetId: string,
  payload: {
    llmInterpretation: string
    runId?: string | null
    resultName?: string | null
  },
) {
  return requestJson<{ artifact: ArtifactRef; payload: Record<string, unknown> }>(
    `/api/v1/weather/datasets/${encodeURIComponent(datasetId)}/report`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    120_000,
  )
}

export async function importManagedLayer(
  file: File,
  options?: {
    name?: string
    description?: string
    category?: string
    tags?: string[]
    status?: string
    analysisCapabilities?: string[]
    sourceConfigSummary?: string
  },
) {
  const formData = new FormData()
  formData.append('file', file)
  if (options?.name) {
    formData.append('name', options.name)
  }
  if (options?.description) {
    formData.append('description', options.description)
  }
  if (options?.category) {
    formData.append('category', options.category)
  }
  if (options?.tags?.length) {
    formData.append('tags', options.tags.join(','))
  }
  if (options?.status) {
    formData.append('status', options.status)
  }
  if (options?.analysisCapabilities?.length) {
    formData.append('analysisCapabilities', options.analysisCapabilities.join(','))
  }
  if (options?.sourceConfigSummary) {
    formData.append('sourceConfigSummary', options.sourceConfigSummary)
  }

  return requestFormJson<LayerDescriptor>('/api/v1/layers/import', formData, '后台图层导入请求失败')
}

export async function replaceManagedLayer(layerKey: string, file: File) {
  const formData = new FormData()
  formData.append('file', file)

  return requestFormJson<LayerDescriptor>(
    `/api/v1/layers/${encodeURIComponent(layerKey)}/replace`,
    formData,
    '图层数据替换请求失败',
  )
}

export function openRunEventStream(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError: (error: Event) => void,
) {
  // SSE 事件流订阅。
  //
  // 浏览器端只负责连接与转发事件对象；
  // 重连策略和状态吸收由上层组件统一决定，避免这里隐式维护第二套状态。
  const source = new EventSource(`${API_BASE_URL}/api/v1/analysis/${runId}/events`)
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RunEvent)
    } catch {
      // 后端返回畸形 JSON 时静默丢弃本条消息，不中断事件流
    }
  }
  source.onerror = onError
  return source
}
