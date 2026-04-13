import type {
  AnalysisRun,
  ArtifactRef,
  BasemapDescriptor,
  LayerDescriptor,
  ModelProviderDescriptor,
  PublishRequest,
  QgisModelsResponse,
  RunEvent,
  SessionRecord,
  SystemComponentsStatus,
} from '@geo-agent-platform/shared-types'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

export const apiBaseUrl = API_BASE_URL

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

export function startAnalysis(sessionId: string, query: string, provider?: string, model?: string) {
  return requestJson<AnalysisRun>('/api/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, query, provider, model }),
  })
}

export function getRun(runId: string) {
  return requestJson<AnalysisRun>(`/api/v1/analysis/${runId}`)
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

export async function uploadLayer(sessionId: string, file: File) {
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
  const source = new EventSource(`${API_BASE_URL}/api/v1/analysis/${runId}/events`)
  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data) as RunEvent)
  }
  source.onerror = onError
  return source
}
