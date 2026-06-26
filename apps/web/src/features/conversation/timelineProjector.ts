// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线投影器
//
//   文件:       timelineProjector.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 服务端 transcript 是完整 thread 基线，当前 run stream 是实时 overlay。
// 这里集中处理去重和排序，避免 AppShell 根据局部状态临时拼出错序时间线。

import type { ConversationItem } from '@geo-agent-platform/shared-types'

export function projectTimeline(canonical: ConversationItem[], liveOverlay: ConversationItem[]): ConversationItem[] {
  const overlayEntryIds = new Set(liveOverlay.flatMap(item => {
    const entryId = item.metadata?.transcriptEntryId
    return typeof entryId === 'string' ? [entryId] : []
  }))
  const combined = [
    ...canonical.filter(item => {
      const entryId = item.metadata?.transcriptEntryId
      return typeof entryId !== 'string' || !overlayEntryIds.has(entryId)
    }),
    ...liveOverlay,
  ]
  const latest = new Map<string, ConversationItem>()
  for (const item of combined) latest.set(item.itemId, item)
  return [...latest.values()].sort(compareConversationItems)
}

export const mergeConversationItems = projectTimeline

function compareConversationItems(left: ConversationItem, right: ConversationItem): number {
  const leftTime = Date.parse(left.timestamp || '')
  const rightTime = Date.parse(right.timestamp || '')
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0
  if (safeLeftTime !== safeRightTime) return safeLeftTime - safeRightTime

  const leftSeq = metadataNumber(left, 'transcriptSeq')
  const rightSeq = metadataNumber(right, 'transcriptSeq')
  if (leftSeq !== rightSeq) return leftSeq - rightSeq

  const rank = itemRank(left) - itemRank(right)
  if (rank !== 0) return rank

  return left.itemId.localeCompare(right.itemId)
}

function metadataNumber(item: ConversationItem, key: string): number {
  const value = item.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function itemRank(item: ConversationItem): number {
  if (item.itemType === 'message' && item.role === 'user') return 10
  if (item.itemType === 'reasoning') return 20
  if (item.itemType === 'message' && item.role === 'assistant') return 30
  if (item.itemType === 'function_call') return 40
  if (item.itemType === 'function_call_output') return 50
  if (item.itemType === 'result') return 60
  if (item.itemType === 'error') return 70
  return 80
}
