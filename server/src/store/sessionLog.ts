// +-------------------------------------------------------------------------
//
//   地理智能平台 - JSONL 会话日志（append-only）
//
//   文件:       sessionLog.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SessionRecord, AgentThreadRecord, AnalysisRun, ConversationItem, RunEvent } from '../schemas/types.js'

type SessionLogRecord =
  | { kind: 'session'; session: SessionRecord }
  | { kind: 'thread'; thread: AgentThreadRecord }
  | { kind: 'thread_deleted'; threadId: string; timestamp: string }
  | { kind: 'run'; run: AnalysisRun }
  | { kind: 'conversation_item'; item: ConversationItem }
  | { kind: 'run_event'; event: RunEvent }

export class SessionLogStore {
  private logPath: string
  private sessionsArr: SessionRecord[] = []
  private threadsArr: AgentThreadRecord[] = []
  private runsArr: AnalysisRun[] = []
  private itemsArr: ConversationItem[] = []
  private eventsArr: RunEvent[] = []
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.logPath = path.join(root, 'sessions.jsonl')
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.logPath), { recursive: true })
    try {
      const text = await readFile(this.logPath, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as Partial<SessionLogRecord> & { kind?: string }
          if (record.kind === 'session' && record.session) this.sessionsArr.push(record.session)
          if (record.kind === 'thread' && record.thread) this.threadsArr.push(record.thread)
          if (record.kind === 'run' && record.run) this.runsArr.push(record.run)
          if (record.kind === 'conversation_item' && record.item) this.itemsArr.push(record.item)
          if (record.kind === 'run_event' && record.event) this.eventsArr.push(record.event)
        } catch { /* skip malformed lines */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  allSessions(): SessionRecord[] { return this.sessionsArr }
  allThreads(): AgentThreadRecord[] { return this.threadsArr }
  allRuns(): AnalysisRun[] { return this.runsArr }
  allItems(): ConversationItem[] { return this.itemsArr }
  allEvents(): RunEvent[] { return this.eventsArr }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private append(line: SessionLogRecord): void {
    const serialized = JSON.stringify(line) + '\n'
    this.writeQueue = this.writeQueue.then(() =>
      appendFile(this.logPath, serialized, 'utf8'),
    )
  }

  appendSession(s: SessionRecord) {
    this.sessionsArr.push(s)
    this.append({ kind: 'session', session: s })
  }

  appendThread(t: AgentThreadRecord) {
    this.threadsArr.push(t)
    this.append({ kind: 'thread', thread: t })
  }

  appendThreadDeleted(threadId: string) {
    this.append({ kind: 'thread_deleted', threadId, timestamp: new Date().toISOString() })
  }

  appendRun(r: AnalysisRun) {
    this.runsArr.push(r)
    this.append({ kind: 'run', run: r })
  }

  appendItem(item: ConversationItem) {
    this.itemsArr.push(item)
    this.append({ kind: 'conversation_item', item })
  }

  appendEvent(event: RunEvent) {
    this.eventsArr.push(event)
    this.append({ kind: 'run_event', event })
  }
}
