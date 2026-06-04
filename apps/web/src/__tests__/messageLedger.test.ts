// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 消息 Ledger 测试
//
//   文件:       messageLedger.test.ts
//
//   日期:       2026年06月04日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 测试聊天 UI 的唯一事实源：AgentMessageFrame replay。
// 这里不构造 RunEvent，避免旧事件 transcript 逻辑重新进入主路径。

import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentMessageFrame } from '@geo-agent-platform/shared-types'
import { applyAgentMessageFrame, deriveConversationEntriesFromMessages } from '../messageLedger'

describe('applyAgentMessageFrame', () => {
  it('原地追加 thinking 和 text block delta', () => {
    let messages: AgentMessage[] = []

    for (const item of [
      makeFrame({ frameId: 'f1', op: 'message_start', messageId: 'assistant:run1', message: assistantMessage() }),
      makeFrame({ frameId: 'f2', op: 'block_start', messageId: 'assistant:run1', blockId: 'think', block: { blockId: 'think', type: 'thinking', thinking: '' } }),
      makeFrame({ frameId: 'f3', op: 'block_delta', messageId: 'assistant:run1', blockId: 'think', delta: { thinking: '先看数据。' } }),
      makeFrame({ frameId: 'f4', op: 'block_start', messageId: 'assistant:run1', blockId: 'text', block: { blockId: 'text', type: 'text', text: '' } }),
      makeFrame({ frameId: 'f5', op: 'block_delta', messageId: 'assistant:run1', blockId: 'text', delta: { text: '完成。' } }),
    ]) {
      messages = applyAgentMessageFrame(messages, item)
    }

    expect(messages).toHaveLength(1)
    expect(messages[0].content[0].thinking).toBe('先看数据。')
    expect(messages[0].content[1].text).toBe('完成。')
  })
})

describe('deriveConversationEntriesFromMessages', () => {
  it('按 toolUseId 结构化配对工具调用和结果', () => {
    const messages: AgentMessage[] = [
      {
        ...assistantMessage('tool-use-msg'),
        status: 'completed',
        content: [{ blockId: 'use', type: 'tool_use', id: 'tool_use_1', name: 'geocode_place', input: { query: '杭州' } }],
      },
      {
        messageId: 'tool-result-msg',
        runId: 'run1',
        threadId: 'thread1',
        type: 'user',
        role: 'user',
        timestamp: '2026-06-04T00:00:01Z',
        status: 'completed',
        parentToolUseId: 'tool_use_1',
        content: [{ blockId: 'result', type: 'tool_result', toolUseId: 'tool_use_1', name: 'geocode_place', content: '已解析杭州。', structuredContent: { ok: true } }],
      },
    ]

    const entries = deriveConversationEntriesFromMessages(messages, 'completed', [
      { name: 'geocode_place', label: '地点解析', description: '', group: 'geo', toolKind: 'registry', available: true, tags: [], parameters: [], meta: {} },
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('command_batch')
    expect(entries[0].commands?.[0].id).toBe('tool_use_1')
    expect(entries[0].commands?.[0].title).toBe('地点解析')
    expect(entries[0].commands?.[0].body).toBe('已解析杭州。')
  })
})

function assistantMessage(messageId = 'assistant:run1'): AgentMessage {
  return {
    messageId,
    runId: 'run1',
    threadId: 'thread1',
    type: 'assistant',
    role: 'assistant',
    timestamp: '2026-06-04T00:00:00Z',
    status: 'streaming',
    content: [],
  }
}

function makeFrame(overrides: Partial<AgentMessageFrame>): AgentMessageFrame {
  return {
    frameId: overrides.frameId ?? 'frame',
    runId: 'run1',
    threadId: 'thread1',
    timestamp: '2026-06-04T00:00:00Z',
    op: overrides.op ?? 'message_start',
    messageId: overrides.messageId,
    blockId: overrides.blockId,
    blockIndex: overrides.blockIndex,
    message: overrides.message,
    block: overrides.block,
    delta: overrides.delta ?? {},
    result: overrides.result ?? {},
    metadata: overrides.metadata ?? {},
  }
}
