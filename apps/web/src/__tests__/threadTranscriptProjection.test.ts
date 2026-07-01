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

  // Chat Completions 允许 assistant 在同一消息里同时给出正文和 tool_call；
  // canonical transcript 会把这段正文投影到工具卡之前，刷新后顺序不变。
  it('projects assistantContent on tool calls as a normal assistant message before the tool card', () => {
    const projected = transcriptEntriesToConversationItems([
      entry(1, 'entry_user_1', 'run_1', 'user', '查一下杭州短时强降水风险。'),
      toolEntry(2, 'entry_tool_1', 'run_1', 'call_1', 'list_meteorological_files', '我先查找当前线程里的气象文件。'),
    ])

    expect(projected.map(item => [item.itemType, item.body ?? item.name])).toEqual([
      ['message', '查一下杭州短时强降水风险。'],
      ['message', '我先查找当前线程里的气象文件。'],
      ['function_call', 'list_meteorological_files'],
    ])
    expect(projected[1].metadata.assistantContentForCallId).toBe('call_1')
  })

  // Agents SDK 有时在工具 ledger 落盘后才通过 Session 给出完整 assistant 消息；
  // checkpoint 记录 callId 归属，前端仍按协议顺序展示正文和工具卡。
  it('projects assistantContent checkpoints before the referenced tool card', () => {
    const projected = transcriptEntriesToConversationItems([
      entry(1, 'entry_user_1', 'run_1', 'user', '查一下杭州短时强降水风险。'),
      toolEntry(2, 'entry_tool_1', 'run_1', 'call_1', 'list_meteorological_files', ''),
      assistantContentCheckpoint(3, 'entry_checkpoint_1', 'run_1', 'call_1', '我先查找当前线程里的气象文件。'),
    ])

    expect(projected.map(item => [item.itemType, item.body ?? item.name])).toEqual([
      ['message', '查一下杭州短时强降水风险。'],
      ['message', '我先查找当前线程里的气象文件。'],
      ['function_call', 'list_meteorological_files'],
    ])
    expect(projected[1].metadata.assistantContentForCallId).toBe('call_1')
    expect(projected[1].metadata.transcriptEntryId).toBe('entry_checkpoint_1')
  })

  // checkpoint 正文和 live item 使用同一个 transcript 身份；
  // 刷新或重连后不能在主时间线里显示两遍同一句工具前置文案。
  it('deduplicates live assistant content that came from a checkpoint', () => {
    const canonical = transcriptEntriesToConversationItems([
      entry(1, 'entry_user_1', 'run_1', 'user', '做 QPF 统计。'),
      toolEntry(2, 'entry_tool_1', 'run_1', 'call_1', 'meteorological_stats', ''),
      assistantContentCheckpoint(3, 'entry_checkpoint_1', 'run_1', 'call_1', '现在做 QPF 统计。'),
    ])
    const live: ConversationItem[] = [{
      itemId: 'item_live_assistant_content',
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      turnId: 'turn_live',
      callId: null,
      role: 'assistant',
      body: '现在做 QPF 统计。',
      name: null,
      arguments: null,
      output: null,
      isError: false,
      phase: null,
      status: 'completed',
      metadata: { transcriptEntryId: 'entry_checkpoint_1', live: true },
      timestamp: new Date(2026, 5, 22, 8, 0, 2).toISOString(),
    }]

    const merged = mergeConversationItems(canonical, live)

    expect(merged.filter(item => item.body === '现在做 QPF 统计。')).toHaveLength(1)
    expect(merged.find(item => item.body === '现在做 QPF 统计。')?.metadata.live).toBe(true)
  })

  // 文件型 transcript 的 seq 是协议顺序；同一毫秒落盘时，前端不能退回到不稳定字符串排序。
  it('keeps transcript sequence order when several items share one timestamp', () => {
    const timestamp = new Date(2026, 5, 22, 8, 0, 0).toISOString()
    const canonical = transcriptEntriesToConversationItems([
      { ...entry(1, 'entry_user_1', 'run_1', 'user', '查询杭州中心点'), timestamp },
      { ...toolEntry(2, 'entry_tool_1', 'run_1', 'call_1', 'geocode_place', '我先查杭州。'), timestamp },
      { ...entry(3, 'entry_assistant_1', 'run_1', 'assistant', '已找到杭州，下面导出中心点。'), timestamp },
    ])

    const merged = mergeConversationItems([], canonical)
    expect(merged.map(item => item.body ?? item.name)).toEqual([
      '查询杭州中心点',
      '我先查杭州。',
      'geocode_place',
      '已找到杭州，下面导出中心点。',
    ])
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

function toolEntry(
  seq: number,
  entryId: string,
  runId: string,
  callId: string,
  name: string,
  assistantContent: string,
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
    kind: 'tool_call',
    timestamp: new Date(2026, 5, 22, 8, 0, seq).toISOString(),
    payload: { callId, name, arguments: {}, assistantContent },
  }
}

function assistantContentCheckpoint(
  seq: number,
  entryId: string,
  runId: string,
  callId: string,
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
    kind: 'checkpoint',
    timestamp: new Date(2026, 5, 22, 8, 0, seq).toISOString(),
    payload: { type: 'assistant_content_for_tool_call', callId, content },
  }
}
