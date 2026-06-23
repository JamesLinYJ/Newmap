// +-------------------------------------------------------------------------
//
//   地理智能平台 - 单轮运行投影测试
//
//   文件:       turnRunner.test.ts
//
//   日期:       2026年06月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 这些测试约束 ConversationItem 的 UI 时间线语义。timestamp 表示首次出现
// 的位置，流式完成和 transcript 身份回填不得把旧消息移动到工具后面。

import { describe, expect, it } from 'vitest'
import type { ConversationItem, RunEvent } from '../schemas/types.js'
import { InMemoryEventBus } from '../store/eventBus.js'
import { ItemSink } from '../conversation/itemSink.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'

describe('ItemSink', () => {
  it('publishes started, delta, and completed ConversationItem updates', () => {
    const bus = new InMemoryEventBus<ConversationItem>()
    const items: ConversationItem[] = []
    bus.subscribe('run_1', (item) => items.push(item))

    const sink = new ItemSink((item) => bus.publish(item.runId, item), 'run_1', 'thread_1')
    sink.startItem('message', { itemId: 'item_1', role: 'assistant' })
    sink.deltaItem('item_1', '你')
    sink.deltaItem('item_1', '好')
    sink.completeItem('item_1')

    expect(items).toHaveLength(4)
    expect(items[0].status).toBe('running')
    expect(items[1].body).toBe('你')
    expect(items[2].body).toBe('你好')
    expect(items[3].status).toBe('completed')
    expect(items[3].body).toBe('你好')
    expect(new Set(items.map(item => item.timestamp)).size).toBe(1)
  })

  it('keeps item order stable when metadata is linked after completion', () => {
    const items: ConversationItem[] = []
    const sink = new ItemSink((item) => items.push(item), 'run_1', 'thread_1')

    const assistant = sink.startItem('message', { itemId: 'assistant_1', role: 'assistant' })
    sink.deltaItem(assistant.itemId, '先说明。')
    sink.completeItem(assistant.itemId)
    const tool = sink.startItem('function_call', { itemId: 'tool_1', role: 'assistant', name: 'map_export', callId: 'call_1' })
    sink.completeItem(tool.itemId, { output: '{"ok":true}' })
    sink.completeItem(assistant.itemId, {
      body: '先说明。',
      metadata: { transcriptEntryId: 'entry_1' },
    })

    const latest = new Map(items.map(item => [item.itemId, item]))
    const sorted = [...latest.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    expect(sorted.map(item => item.itemId)).toEqual(['assistant_1', 'tool_1'])
    expect(sorted[0].metadata.transcriptEntryId).toBe('entry_1')
    expect(sorted[0].timestamp).toBe(items[0].timestamp)
  })
})

describe('TurnFinalizer', () => {
  it('marks terminal result items with a resultType for the web run state', () => {
    const eventBus = new InMemoryEventBus<RunEvent>()
    const itemBus = new InMemoryEventBus<ConversationItem>()
    const items: ConversationItem[] = []
    itemBus.subscribe('run_1', (item) => items.push(item))

    const finalizer = new TurnFinalizer(
      new RunEventSink((event) => eventBus.publish(event.runId, event), 'run_1', 'thread_1'),
      new ItemSink((item) => itemBus.publish(item.runId, item), 'run_1', 'thread_1'),
      () => undefined,
    )

    finalizer.complete()

    expect(items).toHaveLength(1)
    expect(items[0].itemType).toBe('result')
    expect(items[0].body).toBeNull()
    expect(items[0].metadata.resultType).toBe('success')
  })
})
