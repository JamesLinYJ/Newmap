// +-------------------------------------------------------------------------
//
//   地理智能平台 - Thread 标题派生
//
//   文件:       threadTitles.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'

const DEFAULT_THREAD_TITLES = new Set(['新对话', '新的对话', 'Untitled', 'New Thread', ''])
const MAX_TITLE_LENGTH = 32

// 标题展示只做纯文本派生，不回写服务端。
//
// 默认标题遇到最新用户输入时在 UI 层生成可读名称，避免历史列表全是“新对话”。
export function formatThreadDisplayTitle(thread: AgentThreadRecord): string {
  const explicit = normalizeTitle(thread.title)
  if (explicit && !DEFAULT_THREAD_TITLES.has(explicit)) {
    return explicit
  }
  return deriveThreadTitleFromText(thread.latestUserQuery ?? thread.historyPreview ?? thread.latestAssistantSummary ?? explicit)
}

export function deriveThreadTitleFromText(value?: string | null): string {
  const normalized = normalizeTitle(value)
  if (!normalized) return '新对话'
  return normalized.length > MAX_TITLE_LENGTH
    ? normalized.slice(0, MAX_TITLE_LENGTH)
    : normalized
}

function normalizeTitle(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}
