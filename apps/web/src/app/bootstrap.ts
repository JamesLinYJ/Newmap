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
export { mergeConversationItems } from '../features/conversation/timelineProjector'

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
  const assistantContentByCallId = assistantToolContentByCallId(entries)
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
        metadata: { transcriptEntryId: entry.entryId, transcriptSeq: entry.seq, canonical: true },
        timestamp: entry.timestamp,
      }]
    }
    if (entry.kind === 'tool_call') {
      const callId = typeof entry.payload.callId === 'string' ? entry.payload.callId : null
      if (!callId) return []
      const contentFromCheckpoint = assistantContentByCallId.get(callId) ?? null
      const assistantContent = contentFromCheckpoint
        ?? assistantContentFromToolEntry(entry)
      const assistantContentText = assistantContent?.content ?? null
      const assistantContentEntryId = assistantContent?.entryId ?? entry.entryId
      const assistantContentSeq = assistantContent?.displaySeq ?? entry.seq
      const assistantContentTimestamp = assistantContent?.displayTimestamp ?? entry.timestamp
      const assistantContentSource = assistantContent?.source ?? 'tool_call'
      const items: ConversationItem[] = []
      if (assistantContentText) {
        // assistant_content_for_tool_call 是这段正文的真实身份；
        // 展示顺序仍贴在工具调用之前，避免 canonical history 与 live item 双写成两条消息。
        items.push({
          itemId: `transcript:${assistantContentEntryId}:assistant-content`,
          itemType: 'message',
          runId: entry.runId ?? `thread:${entry.threadId}`,
          threadId: entry.threadId,
          turnId: entry.turnId,
          callId: null,
          role: 'assistant',
          body: assistantContentText,
          name: null,
          arguments: null,
          output: null,
          isError: false,
          phase: null,
          status: 'completed',
          metadata: {
            transcriptEntryId: assistantContentEntryId,
            transcriptSeq: assistantContentSeq,
            assistantContentForCallId: callId,
            assistantContentSource,
            canonical: true,
          },
          timestamp: assistantContentTimestamp,
        })
      }
      items.push({
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
        metadata: { transcriptEntryId: entry.entryId, transcriptSeq: entry.seq, canonical: true },
        timestamp: entry.timestamp,
      })
      return items
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
        metadata: { transcriptEntryId: entry.entryId, transcriptSeq: entry.seq, canonical: true, contentRef: entry.payload.contentRef ?? null },
        timestamp: entry.timestamp,
      }]
    }
    return []
  })
}

interface AssistantToolContent {
  content: string
  entryId: string
  displaySeq: number
  displayTimestamp: string
  source: 'checkpoint' | 'tool_call'
}

function assistantToolContentByCallId(entries: TranscriptEntry[]): Map<string, AssistantToolContent> {
  const contentByCallId = new Map<string, AssistantToolContent>()
  const toolCallDisplayByCallId = new Map<string, { seq: number; timestamp: string }>()
  for (const entry of entries) {
    if (entry.kind === 'tool_call') {
      const callId = typeof entry.payload.callId === 'string' ? entry.payload.callId : null
      if (!callId) continue
      toolCallDisplayByCallId.set(callId, { seq: entry.seq, timestamp: entry.timestamp })
      const content = assistantContentFromToolEntry(entry)
      if (content && !contentByCallId.has(callId)) contentByCallId.set(callId, content)
      continue
    }
    if (entry.kind !== 'checkpoint' || entry.payload.type !== 'assistant_content_for_tool_call') continue
    const callId = typeof entry.payload.callId === 'string' ? entry.payload.callId : null
    const content = typeof entry.payload.content === 'string' ? entry.payload.content.trim() : ''
    if (callId && content && !contentByCallId.has(callId)) {
      const display = toolCallDisplayByCallId.get(callId)
      contentByCallId.set(callId, {
        content,
        entryId: entry.entryId,
        displaySeq: display?.seq ?? entry.seq,
        displayTimestamp: display?.timestamp ?? entry.timestamp,
        source: 'checkpoint',
      })
    }
  }
  return contentByCallId
}

function assistantContentFromToolEntry(entry: TranscriptEntry): AssistantToolContent | null {
  const content = typeof entry.payload.assistantContent === 'string'
    ? entry.payload.assistantContent.trim()
    : ''
  if (!content) return null
  return {
    content,
    entryId: entry.entryId,
    displaySeq: entry.seq,
    displayTimestamp: entry.timestamp,
    source: 'tool_call',
  }
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
