// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区 URL 指针
//
//   文件:       workspacePointer.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export interface WorkspacePointer {
  activeSessionId?: string
  activeRunId?: string
  activeThreadId?: string
}

// URL 指针是可分享的轻量定位信息，不是运行历史事实源。
//
// session/thread/run 的真实内容仍通过 WebSocket 和文件型 conversation store 读取。
export function readWorkspacePointer(search = window.location.search): WorkspacePointer {
  const params = new URLSearchParams(search)
  return {
    activeSessionId: normalizeParam(params.get('session')),
    activeRunId: normalizeParam(params.get('run')),
    activeThreadId: normalizeParam(params.get('thread')),
  }
}

export function buildWorkspaceShareUrl(
  origin: string,
  sessionId?: string,
  runId?: string,
  threadId?: string,
): string {
  const url = new URL('/', origin)
  writePointerParams(url.searchParams, sessionId, runId, threadId)
  return url.toString()
}

export function syncCleanWorkspaceUrl(sessionId: string, runId?: string, threadId?: string) {
  const url = new URL(window.location.href)
  writePointerParams(url.searchParams, sessionId, runId, threadId)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function writePointerParams(
  params: URLSearchParams,
  sessionId?: string,
  runId?: string,
  threadId?: string,
) {
  setOptionalParam(params, 'session', sessionId)
  setOptionalParam(params, 'thread', threadId)
  setOptionalParam(params, 'run', runId)
}

function setOptionalParam(params: URLSearchParams, key: string, value?: string) {
  if (value?.trim()) {
    params.set(key, value.trim())
  } else {
    params.delete(key)
  }
}

function normalizeParam(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
