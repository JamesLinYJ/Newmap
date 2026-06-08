// +-------------------------------------------------------------------------
//
//   地理智能平台 - Turn Runner（SSE stream → ConversationItem）
//
//   文件:       turnRunner.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { RunEvent } from '../schemas/types.js'
import type { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'

type AppendEvent = (event: RunEvent) => void

export class RunEventSink {
  constructor(
    private appendEvent: AppendEvent,
    private runId: string,
    private threadId: string | null,
  ) {}

  emit(type: RunEvent['type'], message: string, payload: Record<string, unknown> = {}): RunEvent {
    const event: RunEvent = {
      eventId: makeId('evt'),
      runId: this.runId,
      threadId: this.threadId,
      type,
      message,
      timestamp: nowUtc(),
      payload,
    }
    this.appendEvent(event)
    return event
  }
}

// TurnFinalizer
//
// 运行终止协调：写入最终状态、发射终端事件。
export class TurnFinalizer {
  constructor(
    private eventSink: RunEventSink,
    private itemSink: ItemSink,
    private onComplete: (status: string) => void,
  ) {}

  complete(todos: unknown[] = []): void {
    this.eventSink.emit('run.completed', '运行完成', { todos })
    this.itemSink.appendResult('success', { todos })
    this.onComplete('completed')
  }

  fail(error: string, errors: string[] = []): void {
    const allErrors = errors.length ? errors : [error]
    this.eventSink.emit('run.failed', '运行失败', { errors: allErrors, message: error })
    this.itemSink.appendResult('failed', { errors: allErrors, message: error })
    this.onComplete('failed')
  }

  cancel(message = '运行已中断'): void {
    this.eventSink.emit('run.failed', message, { cancelled: true, message })
    this.itemSink.appendResult('cancelled', { message })
    this.onComplete('cancelled')
  }
}
