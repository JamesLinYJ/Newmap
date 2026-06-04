// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 消息 Ledger 投影
//
//   文件:       messageLedger.ts
//
//   日期:       2026年06月04日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 只把后端 canonical AgentMessage[] 投影为聊天 UI 可渲染条目。
// 本文件不读取旧 RunEvent，不猜工具参数，也不补造最终摘要。

import type { AgentContentBlock, AgentMessage, AgentMessageFrame, ToolDescriptor } from '@geo-agent-platform/shared-types'

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

export function applyAgentMessageFrame(messages: AgentMessage[], frame: AgentMessageFrame): AgentMessage[] {
  const current = messages.map((message) => ({ ...message, content: message.content.map((block) => ({ ...block })) }))

  const findIndex = (messageId?: string | null) => current.findIndex((message) => message.messageId === messageId)
  const upsert = (message: AgentMessage) => {
    const index = findIndex(message.messageId)
    if (index >= 0) {
      current[index] = message
    } else {
      current.push(message)
    }
  }

  const ensureMessage = () => {
    if (frame.message) {
      upsert(frame.message)
      return frame.message
    }
    const index = findIndex(frame.messageId)
    return index >= 0 ? current[index] : undefined
  }

  if (frame.op === 'message_append' && frame.message) {
    upsert(frame.message)
    return current
  }
  if (frame.op === 'message_start' && frame.message) {
    upsert({ ...frame.message, status: 'streaming' })
    return current
  }
  if (frame.op === 'block_start' && frame.block) {
    const message = ensureMessage()
    if (!message) return current
    if (message.content.some((block) => block.blockId === frame.block!.blockId)) return current
    upsert({ ...message, status: 'streaming', content: [...message.content, frame.block] })
    return current
  }
  if (frame.op === 'block_delta') {
    const message = ensureMessage()
    if (!message) return current
    const content = message.content.map((block) => {
      if (block.blockId !== frame.blockId) return block
      const delta = frame.delta ?? {}
      return {
        ...block,
        text: typeof delta.text === 'string' ? `${block.text ?? ''}${delta.text}` : block.text,
        thinking: typeof delta.thinking === 'string' ? `${block.thinking ?? ''}${delta.thinking}` : block.thinking,
        content: typeof delta.content === 'string' ? `${block.content ?? ''}${delta.content}` : block.content,
        input: isRecord(delta.input) ? { ...(block.input ?? {}), ...delta.input } : block.input,
      }
    })
    upsert({ ...message, status: 'streaming', content })
    return current
  }
  if (frame.op === 'block_stop') {
    const message = ensureMessage()
    if (!message) return current
    upsert({
      ...message,
      content: message.content.map((block) => (
        block.blockId === frame.blockId
          ? { ...block, metadata: { ...(block.metadata ?? {}), done: true } }
          : block
      )),
    })
    return current
  }
  if (frame.op === 'message_stop' && frame.messageId) {
    const index = findIndex(frame.messageId)
    if (index >= 0) {
      current[index] = { ...current[index], status: String(frame.metadata?.status ?? 'completed') }
    }
  }
  return current
}

export function deriveConversationEntriesFromMessages(
  messages: ReadonlyArray<AgentMessage>,
  runStatus?: string,
  tools: ReadonlyArray<ToolDescriptor> = [],
): ConversationEntry[] {
  const toolLabels = new Map(tools.map((tool) => [tool.name, tool.label]))
  const entries: ConversationEntry[] = []
  const toolUses = new Map<string, { message: AgentMessage; block: AgentContentBlock }>()

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        toolUses.set(block.id, { message, block })
        continue
      }
      if (block.type === 'thinking') {
        entries.push({
          id: block.blockId,
          kind: 'message',
          role: 'assistant',
          timestamp: message.timestamp,
          title: '思考',
          body: block.thinking ?? '',
          status: message.status === 'streaming' && !block.metadata?.done ? 'running' : 'completed',
          badge: 'thinking',
        })
        continue
      }
      if (block.type === 'text') {
        const body = block.text?.trim()
        if (!body) continue
        entries.push({
          id: block.blockId,
          kind: 'message',
          role: message.role === 'user' ? 'user' : 'assistant',
          timestamp: message.timestamp,
          title: message.role === 'user' ? '用户' : '回答',
          body,
          status: normalizeStatus(message.status, runStatus),
        })
        continue
      }
      if (block.type === 'tool_result' && block.toolUseId) {
        const use = toolUses.get(block.toolUseId)
        entries.push(buildToolEntry(block.toolUseId, use?.message ?? message, use?.block, block, toolLabels))
      }
    }
  }

  for (const [toolUseId, use] of toolUses.entries()) {
    if (entries.some((entry) => entry.kind === 'command_batch' && entry.id === `tool:${toolUseId}`)) continue
    entries.push(buildToolEntry(toolUseId, use.message, use.block, undefined, toolLabels))
  }

  return entries
}

export function pickMessageLedgerHeadline(messages: ReadonlyArray<AgentMessage>, runStatus?: string) {
  const entries = deriveConversationEntriesFromMessages(messages, runStatus)
  const latest = [...entries].reverse().find((entry) => entry.kind === 'message' || entry.kind === 'command_batch')
  if (!latest) {
    return { title: runStatus === 'running' ? '运行中' : '等待输入', body: runStatus === 'running' ? 'Agent 正在准备消息流。' : '提交问题后开始分析。' }
  }
  return { title: latest.title, body: latest.body || latest.commands?.at(-1)?.body || '' }
}

function buildToolEntry(
  toolUseId: string,
  useMessage: AgentMessage,
  useBlock: AgentContentBlock | undefined,
  resultBlock: AgentContentBlock | undefined,
  toolLabels: ReadonlyMap<string, string>,
): ConversationEntry {
  const toolName = useBlock?.name ?? resultBlock?.name ?? 'unknown_tool'
  const title = toolLabels.get(toolName) ?? toolName
  const args = useBlock?.input ?? {}
  const status: LedgerEntryStatus = resultBlock ? (resultBlock.isError ? 'failed' : 'completed') : 'running'
  const body = resultBlock?.content ?? '执行中，等待工具返回...'
  return {
    id: `tool:${toolUseId}`,
    kind: 'command_batch',
    timestamp: resultBlock ? useMessage.timestamp : useMessage.timestamp,
    title,
    body,
    status,
    commands: [{
      id: toolUseId,
      title,
      status,
      body,
      toolName,
      commandText: JSON.stringify(args, null, 2),
      details: {
        args,
        result: resultBlock?.structuredContent,
        artifactId: resultBlock?.artifactId,
        valueRefs: resultBlock?.valueRefs ?? [],
      },
    }],
    artifactId: resultBlock?.artifactId,
    details: resultBlock?.metadata ?? null,
  }
}

function normalizeStatus(status?: string, runStatus?: string): LedgerEntryStatus {
  if (status === 'streaming') return 'running'
  if (status === 'failed') return 'failed'
  if (runStatus === 'running' && status !== 'completed') return 'running'
  return 'completed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
