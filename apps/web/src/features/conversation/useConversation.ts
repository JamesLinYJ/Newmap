// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话投影 Hook
//
//   文件:       useConversation.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useMemo } from 'react'
import type {
  ClarificationState,
  ConversationItem,
  ToolDescriptor,
  UserIntent,
} from '@geo-agent-platform/shared-types'
import { deriveEntriesFromItems } from './items'
import type { ActiveClarification } from './types'

// 聊天 UI 的事实入口是 ConversationItem[]。
//
// Hook 只做稳定 memo 和状态文案投影，不从事件流补造回答。
export function useConversationEntries(
  items: ReadonlyArray<ConversationItem>,
  runStatus?: string,
  tools: ReadonlyArray<ToolDescriptor> = [],
) {
  return useMemo(() => deriveEntriesFromItems(items, runStatus, tools), [items, runStatus, tools])
}

export function errorCardTitle(message?: string) {
  const lower = (message ?? '').toLowerCase()
  if (!lower.trim()) return '运行出错'
  if (lower.includes('response_format') || lower.includes('invalid_request_error') || lower.includes('badrequesterror') || lower.includes('模型')) {
    return '模型调用失败'
  }
  if (lower.includes('tool') || lower.includes('工具')) {
    return '工具执行失败'
  }
  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('timeout') || lower.includes('连接')) {
    return '连接失败'
  }
  return '运行出错'
}

export function buildActiveClarification(
  clarification?: ClarificationState | null,
  intent?: UserIntent,
): ActiveClarification | null {
  if (clarification && !clarification.selectedOptionId) {
    return {
      key: clarification.clarificationId,
      question: clarification.question,
      options: clarification.options,
      allowFreeText: clarification.allowFreeText,
    }
  }

  if (intent?.clarificationRequired) {
    return {
      key: `intent:${intent.clarificationQuestion ?? 'clarification'}`,
      question: intent.clarificationQuestion ?? '请确认下一步。',
      options: intent.clarificationOptions ?? [],
      allowFreeText: true,
    }
  }

  return null
}

export function formatStatusLine(
  runStatus: string | undefined,
  providerLabel: string,
  artifactCount: number,
  uploadedLayerName?: string,
) {
  const parts = [formatRunStatus(runStatus), providerLabel]
  if (artifactCount > 0) parts.push(`${artifactCount} 结果`)
  if (uploadedLayerName) parts.push(uploadedLayerName)
  return parts.join(' · ')
}

export function fmtElapsed(startedAt: string) {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return '0秒'
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}分${seconds % 60}秒`
}

export function formatSessionDate(value?: string | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatRunStatus(status?: string) {
  if (status === 'running' || status === 'queued') return '运行中'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'clarification_needed') return '待澄清'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'requires_action') return '待处理'
  return '就绪'
}
