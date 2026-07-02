// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 错误归一化
//
//   文件:       errors.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const API_UNAVAILABLE_MESSAGE = 'GeoForge API 未连接，请启动 Node API 服务。'

const API_UNAVAILABLE_PATTERNS = [
  'bad gateway',
  'proxy failed',
  'econnrefused',
  'failed to fetch',
  'load failed',
  'networkerror',
  'http 502',
  'http 503',
  '502',
  '503',
] as const

// 代理层和浏览器网络异常不是认证失败；统一翻译成可执行的服务状态提示。
// 这里不吞掉后端业务错误，只有明确 API 不可达时才替换为固定文案。
export function normalizeApiErrorMessage(error: unknown, fallback = API_UNAVAILABLE_MESSAGE): string {
  const message = extractErrorMessage(error, fallback)
  return isApiUnavailableMessage(message) ? API_UNAVAILABLE_MESSAGE : message
}

export function formatApiError(prefix: string, detail?: string): string {
  if (detail && isApiUnavailableMessage(detail)) return API_UNAVAILABLE_MESSAGE
  return detail?.trim() ? `${prefix}：${detail.trim()}` : prefix
}

export function isApiUnavailableMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase()
  return API_UNAVAILABLE_PATTERNS.some(pattern => normalized.includes(pattern))
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (isRecord(error)) {
    const detail = error.detail ?? error.error ?? error.message
    if (typeof detail === 'string' && detail.trim()) return detail
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
