// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台指针管理
//
//   文件:       workspacePointer.ts
//
//   日期:       2026年04月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 管理主工作台的本地恢复指针与分享链接生成。普通使用时地址栏保持干净，
// 只有用户主动复制分享链接时才显式编码 session/thread/run。

export const WORKSPACE_POINTER_STORAGE_KEY = 'geo-agent-platform:workspace-pointer'

export interface WorkspacePointer {
  sessionId?: string
  activeRunId?: string
  activeThreadId?: string
}

interface WorkspaceBrowserHost {
  location: Pick<Location, 'href'>
  history: Pick<History, 'replaceState'>
  localStorage: Pick<Storage, 'getItem' | 'setItem'>
}

export function readWorkspacePointer(host: WorkspaceBrowserHost = window): WorkspacePointer {
  try {
    const raw = host.localStorage.getItem(WORKSPACE_POINTER_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    return normalizeWorkspacePointer(JSON.parse(raw) as WorkspacePointer)
  } catch {
    return {}
  }
}

export function normalizeWorkspacePointer(pointer: WorkspacePointer): WorkspacePointer {
  // 指针收敛
  //
  // 当前尚未发版，因此不保留旧 runId/threadId 兼容；
  // 只接受新的 active* 字段，避免历史缓存把用户拖回旧 thread。
  return {
    sessionId: pointer.sessionId?.trim() || undefined,
    activeRunId: pointer.activeRunId?.trim() || undefined,
    activeThreadId: pointer.activeThreadId?.trim() || undefined,
  }
}

export function rememberWorkspacePointer(pointer: WorkspacePointer, host: WorkspaceBrowserHost = window) {
  try {
    const normalized = normalizeWorkspacePointer(pointer)
    host.localStorage.setItem(WORKSPACE_POINTER_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // 浏览器存储失败不应阻塞主工作台。
  }
}

export function syncCleanWorkspaceUrl(sessionId: string, runId?: string, threadId?: string, host: WorkspaceBrowserHost = window) {
  // 地址栏清理
  //
  // 主工作台的事实源是 React state + localStorage active 指针，
  // 不是 URL 查询参数；这里清理参数并保存可刷新恢复的本地状态。
  const url = new URL(host.location.href)
  url.search = ''
  host.history.replaceState({}, '', `${url.pathname}${url.hash}`)
  rememberWorkspacePointer({ sessionId, activeRunId: runId, activeThreadId: threadId }, host)
}

export function buildWorkspaceShareUrl(baseHref: string, sessionId?: string, runId?: string, threadId?: string) {
  const url = new URL(baseHref)
  url.search = ''
  if (sessionId) {
    url.searchParams.set('session', sessionId)
  }
  if (threadId) {
    url.searchParams.set('thread', threadId)
  }
  if (runId) {
    url.searchParams.set('run', runId)
  }
  return url.toString()
}
