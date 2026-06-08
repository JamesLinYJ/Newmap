// +-------------------------------------------------------------------------
//
//   地理智能平台 - Thread 标题派生
//
//   文件:       threadTitles.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// Thread 标题展示属于前端 UI 派生逻辑。后端只保存事实字段：
// title、latestUserQuery、historyPreview；这里负责把它们整理为用户可读标题。

import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'

const SYSTEM_TITLES = new Set(['新对话', 'GIS 智能分析线程'])

export function formatThreadDisplayTitle(thread: AgentThreadRecord | null | undefined) {
  if (!thread) {
    return '新对话'
  }

  const explicitTitle = normalizeTitleText(thread.title)
  if (explicitTitle && !SYSTEM_TITLES.has(explicitTitle)) {
    return truncateTitle(explicitTitle)
  }

  return deriveThreadTitleFromText(thread.latestUserQuery ?? thread.historyPreview ?? '')
}

export function deriveThreadTitleFromText(value: string | null | undefined) {
  const normalized = normalizeTitleText(value)
  return normalized ? truncateTitle(normalized) : '新对话'
}

function normalizeTitleText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

function truncateTitle(value: string) {
  return value.length > 32 ? value.slice(0, 32) : value
}
