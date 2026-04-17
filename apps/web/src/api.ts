// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 客户端
//
//   文件:       api.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type {
  AgentRuntimeConfig,
  AnalysisRun,
  AgentThreadRecord,
  ArtifactRef,
  BasemapDescriptor,
  LayerDescriptor,
  ModelProviderDescriptor,
  PublishRequest,
  QgisModelsResponse,
  RunEvent,
  SessionRecord,
  SystemComponentsStatus,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  // 通用 JSON 请求入口。
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new Error(formatApiErrorMessage('暂时无法连接分析服务，请确认本地 API 或部署环境已经启动', detail))
  }

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response))
  }

  return (await response.json()) as T
}

export function createSession() {
  return requestJson<SessionRecord>('/api/v1/sessions', {
    method: 'POST',
  })
}

export function getSession(sessionId: string) {
  return requestJson<SessionRecord>(`/api/v1/sessions/${sessionId}`)
}

export function createThread(sessionId: string, title?: string) {
  return requestJson<AgentThreadRecord>('/api/v2/threads', {
    method: 'POST',
    body: JSON.stringify({ sessionId, title }),
  })
}

export function getThread(threadId: string) {
  return requestJson<{ thread: AgentThreadRecord; runs: AnalysisRun[]; latestRun?: AnalysisRun | null }>(`/api/v2/threads/${threadId}`)
}

export function listSessionRuns(sessionId: string) {
  return requestJson<AnalysisRun[]>(`/api/v1/sessions/${sessionId}/runs`)
}

export function listLayers() {
  return requestJson<LayerDescriptor[]>('/api/v1/layers')
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

export function listQgisModels() {
  return requestJson<QgisModelsResponse>('/api/v1/qgis/models')
}

export function listQgisAlgorithms() {
  // QGIS algorithm 列表。
  return requestJson<{ available: boolean; algorithms: ToolDescriptor[]; error?: string }>('/api/v1/qgis/algorithms')
}

export function listTools() {
  return requestJson<ToolDescriptor[]>('/api/v1/tools')
}

export function listToolCatalogEntries() {
  return requestJson<Array<Record<string, unknown>>>('/api/v1/tools/catalog')
}

export function getRuntimeConfig() {
  return requestJson<AgentRuntimeConfig>('/api/v1/runtime/config')
}

export function updateRuntimeConfig(payload: AgentRuntimeConfig) {
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

export function startAnalysis(sessionId: string, query: string, provider?: string, model?: string) {
  return requestJson<AnalysisRun>('/api/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, query, provider, model }),
  })
}

export function startThreadRun(threadId: string, query: string, provider?: string, model?: string) {
  return requestJson<AnalysisRun>(`/api/v2/threads/${threadId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ query, provider, model }),
  })
}

export function getRun(runId: string) {
  return requestJson<AnalysisRun>(`/api/v1/analysis/${runId}`)
}

export function getThreadRun(runId: string) {
  return requestJson<AnalysisRun>(`/api/v2/runs/${runId}`)
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

export function publishArtifact(artifactId: string, payload: PublishRequest) {
  return requestJson<Record<string, unknown>>(`/api/v1/results/${artifactId}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function resolveApproval(runId: string, approvalId: string, approved: boolean) {
  return requestJson<AnalysisRun>(`/api/v2/runs/${runId}/approvals/${approvalId}`, {
    method: 'POST',
    body: JSON.stringify({ approved }),
  })
}

export function runQgisProcess(payload: Record<string, unknown>) {
  return requestJson<Record<string, unknown>>('/api/v1/qgis/process', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function runQgisModel(payload: Record<string, unknown>) {
  return requestJson<Record<string, unknown>>('/api/v1/qgis/models/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function runTool(payload: Record<string, unknown>) {
  return requestJson<Record<string, unknown>>('/api/v1/tools/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function uploadLayer(sessionId: string, file: File) {
  // 图层上传走 FormData，避免手动处理二进制序列化。
  const formData = new FormData()
  formData.append('session_id', sessionId)
  formData.append('file', file)

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/v1/layers/register`, {
      method: 'POST',
      body: formData,
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new Error(formatApiErrorMessage('暂时无法连接分析服务，请确认本地 API 或部署环境已经启动', detail))
  }

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response))
  }

  return (await response.json()) as LayerDescriptor
}

export function openRunEventStream(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError: (error: Event) => void,
) {
  // SSE 事件流订阅。
  const source = new EventSource(`${API_BASE_URL}/api/v1/analysis/${runId}/events`)
  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data) as RunEvent)
  }
  source.onerror = onError
  return source
}
