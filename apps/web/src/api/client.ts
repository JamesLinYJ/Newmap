// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 客户端
//
//   文件:       client.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 封装 WebSocket 控制面与受限 HTTP 数据面的请求入口和统一错误处理。

import type {
  ConversationItem,
  AgentExecutionMode,
  AgentRuntimeConfig,
  AnalysisRun,
  AgentThreadRecord,
  BasemapDescriptor,
  LayerDescriptor,
  MemoryFileRecord,
  MemorySearchResult,
  MeteorologicalDatasetRecord,
  MeteorologicalJobRecord,
  ModelProviderDescriptor,
  RunEvent,
  RunSummaryPage,
  SessionRecord,
  SpeechAuthorization,
  SystemComponentsStatus,
  ToolDescriptor,
  ThreadDetailSnapshot,
  ThreadHistoryPage,
  ThreadMemoryDocument,
  ContextAssemblyReport,
  CompactionRecord,
  WsControlCommand,
  WorkspaceBootstrapSnapshot,
} from '@geo-agent-platform/shared-types'
import { wsClient } from '../ws/client'

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

// 业务控制命令统一走 /ws；响应必须是具有关联请求 ID 的成功/错误 envelope。
async function requestControl<T>(type: WsControlCommand, payload: Record<string, unknown> = {}): Promise<T> {
  const message = await wsClient.send(type, payload)
  if (message.payload.ok !== true) {
    const error = message.payload.error
    const detail = typeof error === 'object' && error && 'message' in error ? String(error.message) : 'WebSocket 命令失败'
    throw new Error(detail)
  }
  return message.payload.data as T
}

export function createSession() {
  return requestControl<SessionRecord>('session:get-default')
}

export function bootstrapWorkspace(sessionId?: string) {
  return requestControl<WorkspaceBootstrapSnapshot>('workspace:bootstrap', { sessionId })
}

export function getDefaultSession() {
  // 默认工作台会话
  //
  // 返回跨浏览器/设备的稳态服务器端会话。
  // 前端不再用 localStorage 决定“历史属于哪个会话”，
  // 而是统一从这个端点获取确定性默认会话。
  return requestControl<SessionRecord>('session:get-default')
}

export function getSession(sessionId: string) {
  return requestControl<SessionRecord>('session:get', { sessionId })
}

export function listSessionThreads(sessionId: string) {
  // 任务历史现在以 thread 作为主索引，而不是把每次 run 都当成独立任务。
  return requestControl<AgentThreadRecord[]>('thread:list', { sessionId })
}

export function createThread(sessionId: string, title?: string) {
  // v2 thread/run 模型下，thread 负责承接多轮上下文与历史恢复。
  return requestControl<AgentThreadRecord>('thread:create', { sessionId, title })
}

export function getThread(threadId: string) {
  return requestControl<ThreadDetailSnapshot>('thread:get', { threadId })
}

export function updateThread(threadId: string, title: string) {
  return requestControl<AgentThreadRecord>('thread:update', { threadId, title })
}

export function deleteThread(threadId: string) {
  return requestControl<{ deleted: boolean; threadId: string }>('thread:delete', { threadId })
}

export function listRunSummaries(
  sessionId: string,
  options: { threadId?: string | null; cursor?: string | null; limit?: number } = {},
) {
  return requestControl<RunSummaryPage>('run:list', { sessionId, ...options })
}

export function getThreadHistory(threadId: string, cursor?: string | null, limit = 100) {
  return requestControl<ThreadHistoryPage>('thread:history', { threadId, cursor, limit })
}

export function forkThread(threadId: string, entryId: string, title?: string) {
  return requestControl<AgentThreadRecord>('thread:fork', { threadId, entryId, title })
}

export function compactThread(threadId: string) {
  return requestControl<CompactionRecord | null>('thread:compact', { threadId })
}

export function getThreadContext(threadId: string) {
  return requestControl<ContextAssemblyReport>('thread:context', { threadId })
}

export function getThreadMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('thread:memory:get', { threadId })
}

export function updateThreadMemory(threadId: string, content: string, expectedVersion: number) {
  return requestControl<ThreadMemoryDocument>('thread:memory:update', { threadId, content, expectedVersion })
}

export function rebuildThreadMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('thread:memory:rebuild', { threadId })
}

export function listMemories(scope?: 'private' | 'team') {
  return requestControl<{ records: MemoryFileRecord[]; total: number }>('memory:list', { scope })
}

export function readMemory(scope: 'private' | 'team', relativePath: string) {
  return requestControl<MemoryFileRecord>('memory:read', { scope, relativePath })
}

export function writeMemory(payload: {
  scope: 'private' | 'team'
  type: 'user' | 'feedback' | 'project' | 'reference'
  name: string
  description: string
  content: string
  relativePath?: string | null
}) {
  return requestControl<MemoryFileRecord>('memory:write', payload)
}

export function deleteMemory(scope: 'private' | 'team', relativePath: string) {
  return requestControl<{ deleted: boolean; relativePath: string }>('memory:delete', { scope, relativePath })
}

export function searchMemories(query: string) {
  return requestControl<{ matches: MemorySearchResult[]; total: number }>('memory:search', { query })
}

export function extractMemories(threadId: string, runId?: string | null) {
  return requestControl<{ records: MemoryFileRecord[]; total: number }>('memory:extract', { threadId, runId })
}

export function dreamMemories(force = false) {
  return requestControl<{ changed: boolean; message: string; records: MemoryFileRecord[]; summary?: string; warnings?: string[] }>('memory:dream', { force })
}

export function getSessionMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('memory:session:get', { threadId })
}

export function rebuildSessionMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('memory:session:rebuild', { threadId })
}

export function listInstructionMemories() {
  return requestControl<{ enabled: boolean; entrypointName: string; records: MemoryFileRecord[] }>('memory:instructions:list')
}

export function listTrashedThreads(sessionId: string) {
  return requestControl<Array<{ thread: AgentThreadRecord; deletedAt: string; purgeAfter: string }>>('thread:trash:list', { sessionId })
}

export function restoreThread(threadId: string) {
  return requestControl<AgentThreadRecord>('thread:trash:restore', { threadId })
}

export function purgeThread(threadId: string) {
  return requestControl<{ purged: boolean; threadId: string }>('thread:trash:purge', { threadId })
}

export function listLayers(sessionId?: string | null, threadId?: string | null) {
  return requestControl<LayerDescriptor[]>('layer:list', { sessionId, threadId })
}

export function updateLayer(layerKey: string, payload: Record<string, unknown>) {
  return requestControl<LayerDescriptor>('layer:update', { layerKey, update: payload })
}

export function deleteLayer(layerKey: string) {
  return requestControl<{ deleted: boolean; layerKey: string }>('layer:delete', { layerKey })
}

export function listBasemaps() {
  return requestJson<BasemapDescriptor[]>('/api/v1/map/basemaps')
}

export function listProviders() {
  return requestControl<ModelProviderDescriptor[]>('provider:list')
}

export function getSystemComponents() {
  return requestControl<SystemComponentsStatus>('system:get')
}

export function getSpeechAuthorization() {
  return requestControl<SpeechAuthorization>('speech:authorization')
}

export function listTools() {
  return requestControl<ToolDescriptor[]>('tool:list')
}

export function listToolCatalogEntries() {
  return requestControl<Array<Record<string, unknown>>>('tool-catalog:list')
}

export function getRuntimeConfig() {
  // runtime config 来自后端持久化配置，而不是前端硬编码默认值。
  return requestControl<AgentRuntimeConfig>('runtime-config:get')
}

export function updateRuntimeConfig(payload: AgentRuntimeConfig) {
  // 调试页保存配置后，前后端都应立即切到同一份结构化配置。
  return requestControl<AgentRuntimeConfig>('runtime-config:update', { config: payload })
}

export function upsertToolCatalogEntry(toolKind: string, toolName: string, payload: Record<string, unknown>, sortOrder?: number) {
  return requestControl<Record<string, unknown>>('tool-catalog:upsert', { toolKind, toolName, payload, sortOrder })
}

export function deleteToolCatalogEntry(toolKind: string, toolName: string) {
  return requestControl<Record<string, unknown>>('tool-catalog:delete', { toolKind, toolName })
}

export function startAnalysis(sessionId: string, query: string, provider?: string, model?: string, executionMode: AgentExecutionMode = 'auto') {
  // 新任务直接创建 v2 run；已有 thread 的续跑走 startThreadRun。
  return requestControl<AnalysisRun>('run:start', { sessionId, query, provider, modelName: model, executionMode })
}

export function startThreadRun(threadId: string, query: string, provider?: string, model?: string, executionMode: AgentExecutionMode = 'auto') {
  // v2 明确把“线程”和“运行”拆开，便于任务历史与上下文管理。
  return requestControl<AnalysisRun>('run:start', { threadId, query, provider, modelName: model, executionMode })
}

export function getRun(runId: string) {
  // 首页和 WebSocket 断线恢复都依赖这条命令回收最终快照。
  return requestControl<{ run: AnalysisRun }>('run:get', { runId }).then(snapshot => snapshot.run)
}

export function getThreadRun(runId: string) {
  return getRun(runId)
}

export function getRunEvents(runId: string) {
  return requestControl<{ events: RunEvent[] }>('run:get', { runId }).then(snapshot => snapshot.events)
}

export function getRunItems(runId: string) {
  return requestControl<{ items: ConversationItem[] }>('run:get', { runId }).then(snapshot => snapshot.items)
}

export function getArtifactGeoJson(artifactId: string) {
  return requestJson<GeoJSON.FeatureCollection>(`/api/v1/results/${artifactId}/geojson`)
}

export function getArtifactMetadata(artifactId: string) {
  return requestJson<Record<string, unknown>>(`/api/v1/results/${artifactId}/metadata`)
}

export function respondDecision(runId: string, decisionId: string, optionId?: string | null, text?: string | null) {
  // 用户决策统一走同一条控制命令；后端按 decision.kind 映射到审批恢复或澄清续跑。
  return requestControl<AnalysisRun>('run:respond-decision', { runId, decisionId, optionId, text })
}

export function cancelRun(runId: string) {
  // 中断当前后台 run。后端会取消对应 asyncio task 并回写 cancelled 快照。
  return requestControl<AnalysisRun>('run:cancel', { runId })
}

export function runTool(payload: Record<string, unknown>) {
  return requestControl<Record<string, unknown>>('tool:run', payload)
}

export async function uploadLayer(sessionId: string, file: File, threadId?: string | null, sourceRelativePath?: string | null) {
  // 图层上传走 FormData，避免手动处理二进制序列化。
  const formData = new FormData()
  formData.append('session_id', sessionId)
  if (threadId) {
    formData.append('threadId', threadId)
  }
  if (sourceRelativePath) {
    formData.append('sourceRelativePath', sourceRelativePath)
  }
  formData.append('file', file)

  return requestFormJson<LayerDescriptor>('/api/v1/layers/register', formData, '图层上传请求失败')
}

export async function uploadMeteorologicalDataset(sessionId: string, file: File, threadId?: string | null, sourceRelativePath?: string | null) {
  // 气象数据上传只写 meteorology 数据面；后端负责把 datasetId 与 runtime 文件对象关联。
  const formData = new FormData()
  formData.append('sessionId', sessionId)
  if (threadId) {
    formData.append('threadId', threadId)
  }
  if (sourceRelativePath) {
    formData.append('sourceRelativePath', sourceRelativePath)
  }
  formData.append('file', file)

  return requestFormJson<{ dataset: MeteorologicalDatasetRecord; job: MeteorologicalJobRecord | null }>(
    '/api/v1/meteorology/datasets',
    formData,
    '气象数据上传请求失败',
    600_000,
  )
}

export function listMeteorologicalDatasets(sessionId?: string | null, threadId?: string | null) {
  const params = new URLSearchParams()
  if (sessionId) params.set('sessionId', sessionId)
  if (threadId) params.set('threadId', threadId)
  const query = params.toString()
  return requestJson<MeteorologicalDatasetRecord[]>(`/api/v1/meteorology/datasets${query ? `?${query}` : ''}`)
}

export function getMeteorologicalJob(jobId: string) {
  return requestJson<MeteorologicalJobRecord>(`/api/v1/meteorology/jobs/${encodeURIComponent(jobId)}`)
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

// ---- 统一文件管理 API ----

export interface FileEntry {
  id: string; name: string; size: string; sizeBytes: number
  uploadedAt: string; status: string
  threadId?: string | null
  relativePath?: string
  sourceRelativePath?: string | null
}

export function resumeRun(runId: string) {
  return requestControl<AnalysisRun>('run:resume', { runId })
}

export interface FileListResponse {
  files: FileEntry[]; total: number
}

export function listAllFiles(threadId?: string | null) {
  return requestControl<FileListResponse>('file:list', { threadId })
}

export async function uploadAnyFile(file: File, threadId?: string | null, requestId?: string, sourceRelativePath?: string | null) {
  const form = new FormData()
  form.append('file', file)
  if (threadId) form.append('threadId', threadId)
  if (requestId) form.append('requestId', requestId)
  if (sourceRelativePath) form.append('sourceRelativePath', sourceRelativePath)
  return requestFormJson<{ id: string; name: string; size: string; sizeBytes: number; sourceRelativePath?: string | null }>(
    '/api/v1/files/upload',
    form,
    '文件上传请求失败',
    600_000,
  )
}

export function deleteAnyFile(fileId: string, threadId?: string | null) {
  return requestControl<{ deleted: boolean; id: string }>('file:delete', { fileId, threadId })
}

export function subscribeRun(runId: string) {
  return requestControl<{ run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }>('run:subscribe', { runId })
}

export function unsubscribeRun(runId: string) {
  return requestControl<{ unsubscribed: boolean; runId: string }>('run:unsubscribe', { runId })
}
