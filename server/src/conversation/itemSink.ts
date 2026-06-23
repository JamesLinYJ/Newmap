// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 发布器
//
//   文件:       itemSink.ts
//
//   日期:       2026年06月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// ItemSink owns the UI item lifecycle for a single run. ConversationItem.timestamp
// means "first visible position in the timeline"; body/status/metadata updates must
// not move an item after later tools or messages.

import type { ConversationItem } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'

type AppendItem = (item: ConversationItem) => void

export class ItemSink {
  private textBuffers = new Map<string, string>()
  private itemDrafts = new Map<string, ConversationItem>()
  private itemSnapshots = new Map<string, ConversationItem>()

  constructor(
    private appendItem: AppendItem,
    private runId: string,
    private threadId: string | null,
  ) {}

  appendUserMessage(text: string, metadata: Record<string, unknown> = {}): ConversationItem {
    const item: ConversationItem = {
      itemId: makeId('item'), itemType: 'message', runId: this.runId,
      threadId: this.threadId, role: 'user', body: text,
      isError: false, timestamp: nowUtc(),
      turnId: null, callId: null, name: null, arguments: null,
      output: null, phase: null, status: 'completed', metadata,
    }
    return this.publish(item)
  }

  appendAssistantMessage(text: string, metadata: Record<string, unknown> = {}): ConversationItem {
    const item: ConversationItem = {
      itemId: makeId('item'), itemType: 'message', runId: this.runId,
      threadId: this.threadId, role: 'assistant', body: text,
      isError: false, timestamp: nowUtc(),
      turnId: null, callId: null, name: null, arguments: null,
      output: null, phase: null, status: 'completed', metadata,
    }
    return this.publish(item)
  }

  startItem(itemType: ConversationItem['itemType'], opts: {
    itemId?: string
    role?: string
    name?: string
    callId?: string
    arguments?: string
    metadata?: Record<string, unknown>
  } = {}): ConversationItem {
    const item: ConversationItem = {
      itemId: opts.itemId ?? makeId('item'), itemType,
      runId: this.runId, threadId: this.threadId,
      role: opts.role ?? null, name: opts.name ?? null,
      callId: opts.callId ?? null, arguments: opts.arguments ?? null,
      body: null, output: null, turnId: null,
      status: 'running', isError: false,
      phase: itemType === 'reasoning' ? 'commentary' : null,
      metadata: opts.metadata ?? {},
      timestamp: nowUtc(),
    }
    this.itemDrafts.set(item.itemId, item)
    return this.publish(item)
  }

  deltaItem(itemId: string, text: string): void {
    const current = this.textBuffers.get(itemId) ?? ''
    const body = current + text
    this.textBuffers.set(itemId, body)
    const draft = this.itemDrafts.get(itemId)
    if (!draft) return
    this.publish({
      ...draft,
      body,
      output: draft.itemType === 'function_call_output' ? body : draft.output,
      status: 'running',
    })
  }

  completeItem(itemId: string, opts: {
    body?: string
    output?: string
    isError?: boolean
    callId?: string
    name?: string
    metadata?: Record<string, unknown>
  } = {}): void {
    const draft = this.itemDrafts.get(itemId)
    const previous = this.itemSnapshots.get(itemId)
    const base = draft ?? previous
    const itemType: ConversationItem['itemType'] = base?.itemType ?? 'message'
    const body = opts.body ?? this.textBuffers.get(itemId) ?? base?.body ?? ''
    const item: ConversationItem = {
      itemId, itemType,
      runId: this.runId, threadId: this.threadId,
      role: base?.role ?? 'assistant', body,
      name: opts.name ?? base?.name ?? null, callId: opts.callId ?? base?.callId ?? null,
      output: opts.output ?? base?.output ?? null, isError: opts.isError ?? base?.isError ?? false,
      status: opts.isError ? 'failed' : 'completed',
      metadata: { ...(base?.metadata ?? {}), ...(opts.metadata ?? {}) },
      turnId: base?.turnId ?? null, arguments: base?.arguments ?? null, phase: base?.phase ?? null,
      timestamp: base?.timestamp ?? nowUtc(),
    }
    this.publish(item)
    this.textBuffers.delete(itemId)
    this.itemDrafts.delete(itemId)
  }

  appendResult(
    resultType: 'success' | 'failed' | 'cancelled' | 'waiting_approval' | 'clarification_needed',
    payload: Record<string, unknown> = {},
  ): ConversationItem {
    const item: ConversationItem = {
      itemId: makeId('item'), itemType: 'result', runId: this.runId,
      threadId: this.threadId, body: null,
      status: resultType === 'success' ? 'completed' : resultType,
      isError: resultType === 'failed',
      metadata: { ...payload, resultType }, timestamp: nowUtc(),
      turnId: null, callId: null, role: null, name: null,
      arguments: null, output: null, phase: null,
    }
    return this.publish(item)
  }

  private publish(item: ConversationItem): ConversationItem {
    this.itemSnapshots.set(item.itemId, item)
    this.appendItem(item)
    return item
  }
}
