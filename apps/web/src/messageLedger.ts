// Codex 风格平铺 ConversationItem → 聊天 UI 条目投影
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

// ---- 主入口：ConversationItem[] → ConversationEntry[] ----

export function deriveEntriesFromItems(
  items: ReadonlyArray<ConversationItem>,
  _runStatus?: string,
  tools: ReadonlyArray<ToolDescriptor> = [],
): ConversationEntry[] {
  const toolLabels = new Map(tools.map((tool) => [tool.name, tool.label]))
  const entries: ConversationEntry[] = []
  const toolCalls = new Map<string, ConversationItem>()

  for (const item of items) {
    switch (item.itemType) {
      case 'message': {
        const body = ((item.body || item.output) ?? '').trim()
        if (!body) break
        entries.push({
          id: item.callId || item.turnId || `msg:${entries.length}`,
          kind: 'message',
          role: (item.role as 'user' | 'assistant') || 'assistant',
          timestamp: item.timestamp,
          title: item.role === 'user' ? '用户' : '回答',
          body,
          status: item.status === 'running' ? 'running' : 'completed',
        })
        break
      }
      case 'reasoning': {
        const body = (item.body || item.output) ?? ''
        if (!body) break
        entries.push({
          id: item.callId || item.turnId || `think:${entries.length}`,
          kind: 'message',
          role: 'assistant',
          timestamp: item.timestamp,
          title: '思考',
          body,
          status: item.status === 'running' ? 'running' : 'completed',
          badge: 'thinking',
        })
        break
      }
      case 'function_call': {
        if (!item.callId) break
        const title = toolLabels.get(item.name ?? '') ?? item.name ?? '工具调用'
        toolCalls.set(item.callId, item)
        entries.push({
          id: `tool:${item.callId}`,
          kind: 'command_batch',
          timestamp: item.timestamp,
          title,
          body: item.output ?? '执行中…',
          status: 'running',
          commands: [{
            id: item.callId,
            title,
            status: 'running',
            body: item.output ?? '执行中，等待工具返回...',
            toolName: item.name ?? undefined,
            commandText: item.arguments ?? '',
            details: { args: safeJsonParse(item.arguments ?? '') },
          }],
        })
        break
      }
      case 'function_call_output': {
        if (!item.callId) break
        const call = toolCalls.get(item.callId)
        const toolName = call?.name ?? 'unknown'
        const title = toolLabels.get(toolName) ?? toolName
        const entryId = `tool:${item.callId}`
        const existingIdx = entries.findIndex(e => e.id === entryId)
        const entry: ConversationEntry = {
          id: entryId,
          kind: 'command_batch',
          timestamp: item.timestamp,
          title,
          body: item.output ?? '',
          status: item.isError ? 'failed' : 'completed',
          commands: [{
            id: item.callId,
            title,
            status: item.isError ? 'failed' : 'completed',
            body: item.output ?? '',
            toolName,
            commandText: call?.arguments ?? '',
            details: { args: safeJsonParse(call?.arguments ?? '') },
          }],
        }
        if (existingIdx >= 0) {
          entries[existingIdx] = entry
        } else {
          entries.push(entry)
        }
        break
      }
      case 'error': {
        entries.push({
          id: item.callId || `err:${entries.length}`,
          kind: 'error',
          timestamp: item.timestamp,
          title: '运行出错',
          body: item.body ?? '',
          status: 'failed',
        })
        break
      }
    }
  }
  return entries
}

function safeJsonParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown> } catch { return {} }
}
