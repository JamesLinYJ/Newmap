// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程 transcript 前端投影测试
//
//   文件:       threadTranscriptProjection.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ConversationItem, TranscriptEntry } from '@geo-agent-platform/shared-types'
import { mergeConversationItems, transcriptEntriesToConversationItems } from '../app/bootstrap'

describe('thread transcript projection', () => {
  // 新 run 的 snapshot 只含当前 turn；合并后必须保留前一轮 canonical 消息且不重复当前输入。
  it('keeps prior turns while preferring current-run items for the same transcript entry', () => {
    const canonical = transcriptEntriesToConversationItems([
      entry(1, 'entry_user_1', 'run_1', 'user', '项目代号是西湖。'),
      entry(2, 'entry_assistant_1', 'run_1', 'assistant', '已记住。'),
      entry(3, 'entry_user_2', 'run_2', 'user', '项目代号是什么？'),
    ])
    const current: ConversationItem[] = [{
      ...canonical[2],
      itemId: 'item_live_user_2',
      metadata: { transcriptEntryId: 'entry_user_2', live: true },
    }]

    const merged = mergeConversationItems(canonical, current)
    expect(merged.map(item => item.body)).toEqual(['项目代号是西湖。', '已记住。', '项目代号是什么？'])
    expect(merged.filter(item => item.metadata.transcriptEntryId === 'entry_user_2')).toHaveLength(1)
    expect(merged.at(-1)?.metadata.live).toBe(true)
  })

  // assistant 完成事件必须沿用 transcript 身份；页面刷新恢复 canonical 历史时不得重复正文。
  it('deduplicates a completed assistant item after canonical transcript reload', () => {
    const canonical = transcriptEntriesToConversationItems([
      entry(1, 'entry_user_1', 'run_1', 'user', '只回答：运行正常。'),
      entry(2, 'entry_assistant_1', 'run_1', 'assistant', '运行正常。'),
    ])
    const replayed: ConversationItem[] = [{
      ...canonical[1],
      itemId: 'item_live_assistant_1',
      metadata: { transcriptEntryId: 'entry_assistant_1', live: true },
    }]

    const merged = mergeConversationItems(canonical, replayed)
    expect(merged.map(item => item.body)).toEqual(['只回答：运行正常。', '运行正常。'])
    expect(merged.filter(item => item.body === '运行正常。')).toHaveLength(1)
    expect(merged.at(-1)?.metadata.live).toBe(true)
  })
})

function entry(
  seq: number,
  entryId: string,
  runId: string,
  role: 'user' | 'assistant',
  content: string,
): TranscriptEntry {
  return {
    schemaVersion: 1,
    seq,
    entryId,
    parentEntryId: seq > 1 ? `entry_${seq - 1}` : null,
    logicalParentEntryId: null,
    threadId: 'thread_1',
    runId,
    turnId: `turn_${seq}`,
    kind: 'message',
    timestamp: new Date(2026, 5, 22, 8, 0, seq).toISOString(),
    payload: { role, content },
  }
}
