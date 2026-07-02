// +-------------------------------------------------------------------------
//
//   地理智能平台 - Thread 标题派生测试
//
//   文件:       threadTitles.test.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'
import { deriveThreadTitleFromText, formatThreadDisplayTitle } from '../features/conversation/threadTitles'

describe('thread title derivation', () => {
  it('使用用户显式标题', () => {
    expect(formatThreadDisplayTitle(thread({ title: '城市降雨复盘' }))).toBe('城市降雨复盘')
  })

  it('系统默认标题由 latestUserQuery 在 TS 层派生展示', () => {
    expect(formatThreadDisplayTitle(thread({
      title: '新对话',
      latestUserQuery: '  分析 杭州 今天 的 暴雨 风险  ',
    }))).toBe('分析 杭州 今天 的 暴雨 风险')
  })

  it('截断过长标题', () => {
    expect(deriveThreadTitleFromText('012345678901234567890123456789012345')).toBe('01234567890123456789012345678901')
  })
})

function thread(overrides: Partial<AgentThreadRecord>): AgentThreadRecord {
  return {
    id: overrides.id ?? 'thread_1',
    sessionId: overrides.sessionId ?? 'session_1',
    workspaceId: overrides.workspaceId ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    visibility: overrides.visibility ?? 'workspace',
    title: overrides.title ?? '新对话',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? '2026-06-05T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-05T00:00:00Z',
    latestRunId: overrides.latestRunId ?? null,
    latestUserQuery: overrides.latestUserQuery ?? null,
    latestAssistantSummary: overrides.latestAssistantSummary ?? null,
    latestRunStatus: overrides.latestRunStatus ?? null,
    latestArtifactId: overrides.latestArtifactId ?? null,
    latestArtifactName: overrides.latestArtifactName ?? null,
    historyPreview: overrides.historyPreview ?? null,
    runCount: overrides.runCount ?? 0,
    conversationPath: overrides.conversationPath ?? null,
  }
}
