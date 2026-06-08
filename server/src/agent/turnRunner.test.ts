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
