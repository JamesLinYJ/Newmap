// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话线程控制器
//
//   文件:       sessionThreadController.ts
//
//   日期:       2026年06月18日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { startTransition, useCallback, useRef, useState } from 'react'
import type {
  AgentThreadRecord,
  AnalysisRun,
  RunSummary,
  SessionRecord,
  WorkspaceBootstrapSnapshot,
} from '@geo-agent-platform/shared-types'
import {
  bootstrapWorkspace,
  createThread,
  deleteThread,
  getSession,
  getThread,
  listRunSummaries,
  listSessionThreads,
  updateThread,
} from '../../api/client'

export const sessionThreadController = {
  bootstrapWorkspace,
  createThread,
  deleteThread,
  getThread,
  listRunSummaries,
  listSessionThreads,
  updateThread,
}

// JSONL 是 thread/run 事实源；这里持有首屏摘要、分页游标和当前选中态。
// 完整运行快照只由 run:subscribe 吸收，不再通过历史列表隐式水合。
export function useSessionThreadController() {
  const [session, setSession] = useState<SessionRecord>()
  const [sessionRuns, setSessionRuns] = useState<RunSummary[]>([])
  const [sessionThreads, setSessionThreads] = useState<AgentThreadRecord[]>([])
  const [threadRuns, setThreadRuns] = useState<AnalysisRun[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string>()
  const [runHistoryCursor, setRunHistoryCursor] = useState<string | null>(null)
  const [isRunHistoryLoading, setIsRunHistoryLoading] = useState(false)
  const runHistoryCursorRef = useRef<string | null>(null)
  const runHistoryLoadingRef = useRef(false)

  const applyBootstrap = useCallback((snapshot: WorkspaceBootstrapSnapshot) => {
    startTransition(() => {
      setSession(snapshot.session)
      setSessionThreads(snapshot.threads)
    })
  }, [])

  const loadWorkspaceBootstrap = useCallback(async (sessionId?: string) => {
    const snapshot = await bootstrapWorkspace(sessionId)
    applyBootstrap(snapshot)
    return snapshot
  }, [applyBootstrap])

  const refreshSessionHistory = useCallback(async (sessionId: string) => {
    const threads = await listSessionThreads(sessionId)
    startTransition(() => setSessionThreads(threads ?? []))
    return { threads }
  }, [])

  const loadRunHistory = useCallback(async (sessionId: string, append = false) => {
    if (runHistoryLoadingRef.current) return null
    runHistoryLoadingRef.current = true
    setIsRunHistoryLoading(true)
    try {
      const page = await listRunSummaries(sessionId, {
        cursor: append ? runHistoryCursorRef.current : null,
        limit: 20,
      })
      runHistoryCursorRef.current = page.nextCursor
      startTransition(() => {
        setSessionRuns(current => append
          ? [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]
          : page.items)
        setRunHistoryCursor(page.nextCursor)
      })
      return page
    } finally {
      runHistoryLoadingRef.current = false
      setIsRunHistoryLoading(false)
    }
  }, [])

  const ensureUploadThread = useCallback(async (
    currentThreadId: string | null | undefined,
    syncUrl: (sessionId: string, runId?: string, threadId?: string) => void,
  ) => {
    if (!session) throw new Error('当前会话还没有初始化，暂时不能上传文件。')
    if (currentThreadId) return currentThreadId
    const thread = await createThread(session.id, '文件上传')
    startTransition(() => {
      setActiveThreadId(thread.id)
      setSessionThreads(current => current.some(item => item.id === thread.id) ? current : [thread, ...current])
    })
    syncUrl(session.id, undefined, thread.id)
    return thread.id
  }, [session])

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const updated = await updateThread(threadId, title)
    startTransition(() => {
      setSessionThreads(current => current.map(item => item.id === threadId ? updated : item))
    })
    return updated
  }, [])

  const removeThread = useCallback(async (threadId: string) => {
    if (!session) return null
    await deleteThread(threadId)
    const sessionRecord = await getSession(session.id)
    await refreshSessionHistory(session.id)
    startTransition(() => {
      setSession(sessionRecord)
      setSessionRuns(current => current.filter(run => run.threadId !== threadId))
    })
    return sessionRecord
  }, [refreshSessionHistory, session])

  return {
    activeThreadId,
    ensureUploadThread,
    getThread,
    hasMoreRunHistory: Boolean(runHistoryCursor),
    isRunHistoryLoading,
    loadRunHistory,
    loadWorkspaceBootstrap,
    refreshSessionHistory,
    removeThread,
    renameThread,
    session,
    sessionRuns,
    sessionThreads,
    setActiveThreadId,
    setSession,
    setSessionThreads,
    setThreadRuns,
    threadRuns,
  }
}
