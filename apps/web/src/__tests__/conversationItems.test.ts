// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 投影测试
//
//   文件:       conversationItems.test.ts
//
//   日期:       2026年06月04日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 测试聊天 UI 的唯一事实源：ConversationItem。
// 这里不构造 RunEvent 或旧 message frame，防止诊断流重新进入聊天主路径。

import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { deriveEntriesFromItems, pickConversationHeadline } from '../features/conversation/items'

describe('deriveEntriesFromItems', () => {
  it('按 item 顺序渲染 user、reasoning 和 assistant message', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'user:run1', itemType: 'message', role: 'user', body: '查询杭州天气' }),
      item({ itemId: 'reasoning:run1', itemType: 'reasoning', body: '先检查数据。', status: 'running' }),
      item({ itemId: 'assistant:run1', itemType: 'message', role: 'assistant', body: '杭州今天有雨。' }),
    ])

    expect(entries.map((entry) => entry.title)).toEqual(['用户', '思考', '回答'])
    expect(entries[1].status).toBe('running')
    expect(entries[2].body).toBe('杭州今天有雨。')
  })

  it('按 callId 配对工具调用和工具输出', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'toolcall:run1:call1',
        itemType: 'function_call',
        callId: 'call1',
        name: 'geocode_place',
        arguments: '{"query":"杭州"}',
        status: 'running',
      }),
      item({
        itemId: 'toolout:run1:call1',
        itemType: 'function_call_output',
        callId: 'call1',
        output: '已解析杭州。',
        metadata: { resultId: 'res_1', artifactId: 'artifact_1' },
      }),
    ], 'completed', [
      { name: 'geocode_place', label: '地点解析', description: '', group: 'geo', toolKind: 'registry', available: true, tags: [], parameters: [], meta: {} },
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('command_batch')
    expect(entries[0].title).toBe('地点解析')
    expect(entries[0].status).toBe('completed')
    expect(entries[0].artifactId).toBe('artifact_1')
    expect(entries[0].commands?.[0].details?.args).toEqual({ query: '杭州' })
    expect(entries[0].commands?.[0].details?.resultId).toBe('res_1')
  })

  it('不把成功 terminal result 重复渲染为最终回答', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'assistant:run1', itemType: 'message', role: 'assistant', body: '最终回答。' }),
      item({ itemId: 'result:run1:success', itemType: 'result', body: null, metadata: { resultType: 'success' } }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0].body).toBe('最终回答。')
  })

  it('把 failed terminal result 渲染为错误条目', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'result:run1:failed', itemType: 'result', body: '', metadata: { resultType: 'failed', errors: ['工具失败'] } }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('error')
    expect(entries[0].status).toBe('failed')
    expect(entries[0].body).toBe('运行失败。')
  })
})

describe('pickConversationHeadline', () => {
  it('从最新 message 或 command 中取标题', () => {
    const headline = pickConversationHeadline([
      item({ itemId: 'user:run1', itemType: 'message', role: 'user', body: '查询杭州天气' }),
      item({ itemId: 'assistant:run1', itemType: 'message', role: 'assistant', body: '杭州今天有雨。' }),
    ], 'completed')

    expect(headline.title).toBe('回答')
    expect(headline.body).toBe('杭州今天有雨。')
  })
})

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: overrides.itemId ?? 'item:run1',
    itemType: overrides.itemType ?? 'message',
    runId: overrides.runId ?? 'run1',
    threadId: overrides.threadId ?? 'thread1',
    turnId: overrides.turnId ?? 'run1',
    callId: overrides.callId ?? null,
    role: overrides.role ?? null,
    body: overrides.body ?? null,
    name: overrides.name ?? null,
    arguments: overrides.arguments ?? null,
    output: overrides.output ?? null,
    isError: overrides.isError ?? false,
    phase: overrides.phase ?? null,
    status: overrides.status ?? 'completed',
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? '2026-06-04T00:00:00Z',
  }
}
