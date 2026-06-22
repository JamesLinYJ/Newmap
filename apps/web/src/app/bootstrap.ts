// +-------------------------------------------------------------------------
//
//   地理智能平台 - App 启动辅助
//
//   文件:       bootstrap.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 放置 AppShell 启动、历史恢复和 URL 同步用到的纯辅助函数。
// 这里不持有 React state，也不参与聊天事实派生。

import type { ConversationItem, TranscriptEntry } from '@geo-agent-platform/shared-types'
import { runController } from './controllers'

const { getRunItems } = runController

export function formatUiError(error: unknown, defaultMessage: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return defaultMessage
}

export function reportNonBlockingError(scope: string, error: unknown) {
  // 非阻断刷新失败不覆盖主任务状态。
  //
  // 但失败必须留下诊断线索，避免历史列表或辅助面板悄悄停更。
  console.warn(`[${scope}]`, error)
}

export async function aggregateThreadItems(runs: { id: string; status: string }[]): Promise<ConversationItem[]> {
  const all: ConversationItem[] = []
  for (const run of runs) {
    if (run.status === 'running') continue
    try {
      const items = await getRunItems(run.id)
      all.push(...items)
    } catch {
      // 单个 run item 获取失败不影响整体；最终列表仍只由 ConversationItem replay。
    }
  }
  const seen = new Set<string>()
  return all
    .sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime())
    .filter((item) => {
      const key = item.itemId
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function transcriptEntriesToConversationItems(entries: TranscriptEntry[]): ConversationItem[] {
  return entries.flatMap((entry): ConversationItem[] => {
    if (entry.kind === 'message') {
      const role = typeof entry.payload.role === 'string' ? entry.payload.role : null
      const content = typeof entry.payload.content === 'string' ? entry.payload.content : ''
      if (!role || !content) return []
      return [{
        itemId: `transcript:${entry.entryId}`,
        itemType: 'message',
        runId: entry.runId ?? `thread:${entry.threadId}`,
        threadId: entry.threadId,
        turnId: entry.turnId,
        callId: null,
        role,
        body: content,
        name: null,
        arguments: null,
        output: null,
        isError: false,
        phase: null,
        status: 'completed',
        metadata: { transcriptEntryId: entry.entryId, canonical: true },
        timestamp: entry.timestamp,
      }]
    }
    if (entry.kind === 'tool_call') {
      const callId = typeof entry.payload.callId === 'string' ? entry.payload.callId : null
      if (!callId) return []
      return [{
        itemId: `transcript:${entry.entryId}`,
        itemType: 'function_call',
        runId: entry.runId ?? `thread:${entry.threadId}`,
        threadId: entry.threadId,
        turnId: entry.turnId,
        callId,
        role: 'assistant',
        body: null,
        name: typeof entry.payload.name === 'string' ? entry.payload.name : null,
        arguments: typeof entry.payload.arguments === 'string' ? entry.payload.arguments : JSON.stringify(entry.payload.arguments ?? {}),
        output: null,
        isError: false,
        phase: null,
        status: 'completed',
        metadata: { transcriptEntryId: entry.entryId, canonical: true },
        timestamp: entry.timestamp,
      }]
    }
    if (entry.kind === 'tool_result') {
      const callId = typeof entry.payload.callId === 'string' ? entry.payload.callId : null
      if (!callId) return []
      return [{
        itemId: `transcript:${entry.entryId}`,
        itemType: 'function_call_output',
        runId: entry.runId ?? `thread:${entry.threadId}`,
        threadId: entry.threadId,
        turnId: entry.turnId,
        callId,
        role: 'tool',
        body: null,
        name: typeof entry.payload.name === 'string' ? entry.payload.name : null,
        arguments: null,
        output: typeof entry.payload.content === 'string' ? entry.payload.content : String(entry.payload.summary ?? ''),
        isError: entry.payload.ledgerStatus === 'failed',
        phase: null,
        status: entry.payload.ledgerStatus === 'failed' ? 'failed' : 'completed',
        metadata: { transcriptEntryId: entry.entryId, canonical: true, contentRef: entry.payload.contentRef ?? null },
        timestamp: entry.timestamp,
      }]
    }
    return []
  })
}

export function mergeConversationItems(canonical: ConversationItem[], replayed: ConversationItem[]): ConversationItem[] {
  const replayedEntryIds = new Set(replayed.flatMap(item => {
    const entryId = item.metadata?.transcriptEntryId
    return typeof entryId === 'string' ? [entryId] : []
  }))
  const combined = [
    ...canonical.filter(item => {
      const entryId = item.metadata?.transcriptEntryId
      return typeof entryId !== 'string' || !replayedEntryIds.has(entryId)
    }),
    ...replayed,
  ]
  const latest = new Map<string, ConversationItem>()
  for (const item of combined) latest.set(item.itemId, item)
  return [...latest.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

export async function retryAsync<T>(task: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs * (attempt + 1)))
      }
    }
  }
  throw lastError
}
