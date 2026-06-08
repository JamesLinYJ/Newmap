// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 对话投影
//
//   文件:       items.ts
//
//   日期:       2026年06月04日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// ConversationItem 是聊天 UI 的唯一事实源。本文件只把 item 投影为可渲染
// 条目，不读取 RunEvent，也不从诊断事件里补造用户可见回答。

import type { ConversationItem, ToolDescriptor } from '@geo-agent-platform/shared-types'

export type LedgerEntryStatus = 'idle' | 'running' | 'completed' | 'failed' | 'blocked'
export type ConversationEntryKind = 'message' | 'command_batch' | 'approval' | 'artifact' | 'error' | 'system'

export interface ConversationCommand {
  id: string
  title: string
  status: LedgerEntryStatus
  body: string
  commandText?: string | null
  toolName?: string | null
  details?: Record<string, unknown> | null
}

export interface ConversationEntry {
  id: string
  kind: ConversationEntryKind
  timestamp: string
  title: string
  body: string
  status: LedgerEntryStatus
  role?: 'user' | 'assistant'
  badge?: string | null
  note?: string | null
  commands?: ConversationCommand[]
  artifactId?: string | null
  approvalId?: string | null
  recoveryNote?: string | null
  details?: Record<string, unknown> | null
}

export function deriveEntriesFromItems(
  items: ReadonlyArray<ConversationItem>,
  _runStatus?: string,
  tools: ReadonlyArray<ToolDescriptor> = [],
): ConversationEntry[] {
  const toolLabels = new Map(tools.map((tool) => [tool.name, tool.label]))
  const entries: ConversationEntry[] = []
  const toolCalls = new Map<string, ConversationItem>()

  for (const item of items) {
    if (item.itemType === 'message') {
      const body = itemText(item).trim()
      if (!body) continue
      entries.push({
        id: item.itemId,
        kind: 'message',
        role: item.role === 'user' ? 'user' : 'assistant',
        timestamp: item.timestamp,
        title: item.role === 'user' ? '用户' : '回答',
        body,
        status: itemStatus(item),
      })
      continue
    }

    if (item.itemType === 'reasoning') {
      const body = itemText(item)
      if (!body) continue
      entries.push({
        id: item.itemId,
        kind: 'message',
        role: 'assistant',
        timestamp: item.timestamp,
        title: '思考',
        body,
        status: itemStatus(item),
        badge: 'thinking',
      })
      continue
    }

    if (item.itemType === 'function_call') {
      if (!item.callId) continue
      toolCalls.set(item.callId, item)
      upsertToolEntry(entries, buildToolEntry(item, undefined, toolLabels))
      continue
    }

    if (item.itemType === 'function_call_output') {
      if (!item.callId) continue
      upsertToolEntry(entries, buildToolEntry(toolCalls.get(item.callId), item, toolLabels))
      continue
    }

    if (item.itemType === 'error') {
      entries.push({
        id: item.itemId,
        kind: 'error',
        timestamp: item.timestamp,
        title: '运行出错',
        body: itemText(item) || '运行失败。',
        status: 'failed',
        details: item.metadata ?? null,
      })
      continue
    }

    if (item.itemType === 'result') {
      const terminalEntry = buildTerminalEntry(item)
      if (terminalEntry) entries.push(terminalEntry)
    }
  }

  return entries
}

export function pickConversationHeadline(items: ReadonlyArray<ConversationItem>, runStatus?: string) {
  const entries = deriveEntriesFromItems(items, runStatus)
  const latest = [...entries].reverse().find((entry) => entry.kind === 'message' || entry.kind === 'command_batch' || entry.kind === 'error')
  if (!latest) {
    return {
      title: runStatus === 'running' ? '运行中' : '等待输入',
      body: runStatus === 'running' ? 'Agent 正在准备消息流。' : '提交问题后开始分析。',
    }
  }
  return { title: latest.title, body: latest.body || latest.commands?.at(-1)?.body || '' }
}

function buildToolEntry(
  call: ConversationItem | undefined,
  output: ConversationItem | undefined,
  toolLabels: ReadonlyMap<string, string>,
): ConversationEntry {
  const callId = output?.callId ?? call?.callId ?? 'unknown'
  const toolName = call?.name ?? output?.name ?? 'unknown_tool'
  const title = toolLabels.get(toolName) ?? toolName
  const args = safeJsonParse(call?.arguments ?? '')
  const outputText = output?.output ?? output?.body ?? ''
  const status = output ? itemStatus(output) : itemStatus(call)
  const body = output ? outputText || (output.isError ? '工具执行失败。' : '工具执行完成。') : '执行中，等待工具返回...'
  const metadata = output?.metadata ?? call?.metadata ?? {}
  const artifactId = typeof metadata.artifactId === 'string' ? metadata.artifactId : null

  return {
    id: `tool:${callId}`,
    kind: 'command_batch',
    timestamp: output?.timestamp ?? call?.timestamp ?? new Date().toISOString(),
    title,
    body,
    status,
    commands: [{
      id: callId,
      title,
      status,
      body,
      toolName,
      commandText: call?.arguments ?? '',
      details: {
        args,
        result: safeJsonParse(outputText),
        resultId: metadata.resultId ?? null,
        source: metadata.source ?? null,
        artifactId,
        valueRefs: metadata.valueRefs ?? [],
      },
    }],
    artifactId,
    details: metadata,
  }
}

function buildTerminalEntry(item: ConversationItem): ConversationEntry | undefined {
  const resultType = String(item.metadata?.resultType ?? '')
  if (!resultType || resultType === 'success' || resultType === 'completed') {
    return undefined
  }
  const isFailure = resultType === 'failed'
  const body = itemText(item) || (isFailure ? '运行失败。' : '运行已暂停，等待下一步。')
  return {
    id: item.itemId,
    kind: isFailure ? 'error' : 'system',
    timestamp: item.timestamp,
    title: formatResultTitle(resultType),
    body,
    status: isFailure ? 'failed' : 'blocked',
    details: item.metadata ?? null,
  }
}

function upsertToolEntry(entries: ConversationEntry[], entry: ConversationEntry) {
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  if (index >= 0) {
    entries[index] = entry
  } else {
    entries.push(entry)
  }
}

function itemText(item: ConversationItem) {
  return item.body ?? item.output ?? ''
}

function itemStatus(item?: ConversationItem): LedgerEntryStatus {
  if (!item) return 'running'
  if (item.isError || item.status === 'failed') return 'failed'
  if (item.status === 'blocked') return 'blocked'
  if (item.status === 'running') return 'running'
  return 'completed'
}

function formatResultTitle(resultType: string) {
  if (resultType === 'failed') return '运行出错'
  if (resultType === 'waiting_approval') return '等待审批'
  if (resultType === 'waiting_clarification' || resultType === 'clarification_needed') return '需要澄清'
  if (resultType === 'cancelled') return '已中断'
  return '运行状态'
}

function safeJsonParse(s: string): unknown {
  if (!s.trim()) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
