// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 文件会话投影
//
//   文件:       fileAgentsSession.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AgentInputItem, Session } from '@openai/agents'

export type SessionItemProjector = (items: AgentInputItem[]) => Promise<void>

// FileAgentsSession
//
// canonical transcript 仍是事实源；Session 只向 Runner 提供当前活动链快照，
// 并把本次运行新增的语义项交给同一个幂等 projector。
export class FileAgentsSession implements Session {
  private readonly appended: AgentInputItem[] = []

  constructor(
    private readonly sessionId: string,
    private readonly history: AgentInputItem[],
    private readonly projectItems: SessionItemProjector,
  ) {}

  async getSessionId(): Promise<string> {
    return this.sessionId
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = [...this.history, ...this.appended]
    const selected = typeof limit === 'number' ? items.slice(-Math.max(0, limit)) : items
    return structuredClone(selected)
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const replayableItems = items.filter(isReplayableSessionItem)
    if (!replayableItems.length) return
    await this.projectItems(replayableItems)
    this.appended.push(...structuredClone(replayableItems))
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.appended.pop()
  }

  async clearSession(): Promise<void> {
    this.appended.length = 0
  }
}

function isReplayableSessionItem(item: AgentInputItem): boolean {
  return item.type !== 'reasoning'
}
