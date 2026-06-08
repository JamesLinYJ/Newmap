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
//
// 重要：localStorage 仅作为 UI 选中提示（上次打开的 thread/run），
// 不是历史归属的事实源。会话归属由服务器端默认工作台会话
// （GET /api/v1/sessions/default）或 URL ?session= 分享链接决定。
// 前端不再通过 localStorage 创建或选择会话。

export const WORKSPACE_POINTER_STORAGE_KEY = 'geo-agent-platform:workspace-pointer'

export interface WorkspacePointer {
  activeRunId?: string
  activeThreadId?: string
}

interface WorkspaceBrowserHost {
  location: Pick<Location, 'href'>
  history: Pick<History, 'replaceState'>
  localStorage: Pick<Storage, 'getItem' | 'setItem'>
}

export function readWorkspacePointer(host: WorkspaceBrowserHost = window): WorkspacePointer {
  // 读取 localStorage 中的 UI 选中提示。
  //
  // activeThreadId / activeRunId 仅用于记住用户上次打开的是哪个线程/运行。
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
  // 只接受新的 active* 字段，避免历史缓存把用户拖回旧 thread。
  return {
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

export function syncCleanWorkspaceUrl(_sessionId: string, runId?: string, threadId?: string, host: WorkspaceBrowserHost = window) {
  // 地址栏清理并保存 UI 选中提示。
  //
  // 地址栏保持干净（不编码 session/thread/run）；localStorage 仅保存
  // activeThreadId / activeRunId 作为用户上次打开位置的 UI 提示。
  // 会话归属由服务器端默认工作台会话决定，不写回 localStorage。
  const url = new URL(host.location.href)
  url.search = ''
  host.history.replaceState({}, '', `${url.pathname}${url.hash}`)
  rememberWorkspacePointer({ activeRunId: runId, activeThreadId: threadId }, host)
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
