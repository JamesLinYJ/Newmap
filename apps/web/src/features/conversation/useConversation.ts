// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话派生状态 hook
//
//   文件:       useConversation.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 从 ConversationItem[] 派生聊天展示条目和运行状态文案。
// RunEvent 不进入这里，避免诊断流重新成为用户可见聊天输入。

import { useMemo } from 'react'
import type { ClarificationState, ConversationItem, ToolDescriptor, UserIntent } from '@geo-agent-platform/shared-types'
import { deriveEntriesFromItems } from './items'
import type { ActiveClarification } from './types'

export function useConversationEntries(
  items: ReadonlyArray<ConversationItem>,
  runStatus: string | undefined,
  availableTools: ToolDescriptor[],
) {
  return useMemo(
    () => deriveEntriesFromItems(items, runStatus, availableTools),
    [availableTools, runStatus, items],
  )
}

export function errorCardTitle(message?: string) {
  // 错误标题只描述已知事实。
  //
  // 模型、工具和网络问题要分别呈现，避免把 provider 400 误导成连接失败。
  const normalized = (message ?? '').toLowerCase()
  if (!normalized.trim()) return '运行出错'
  if (normalized.includes('response_format') || normalized.includes('invalid_request_error') || normalized.includes('badrequesterror') || normalized.includes('模型')) {
    return '模型调用失败'
  }
  if (normalized.includes('工具') || normalized.includes('tool')) {
    return '工具执行失败'
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network') || normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('无法连接') || normalized.includes('连接')) {
    return '连接失败'
  }
  return '运行出错'
}

export function buildActiveClarification(
  clarification: ClarificationState | null | undefined,
  intent: UserIntent | undefined,
): ActiveClarification | null {
  // 澄清显示事实源。
  //
  // request_clarification 工具写入 agentState.clarification；解析器早期歧义
  // 写入 intent。UI 优先展示运行态事实，避免工具成功但前端只看 intent 而空白。
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

export function formatStatusLine(status: string | undefined, providerLabel: string, artifactCount: number, uploadedLayerName?: string) {
  const parts = [fmtStatus(status), providerLabel]
  if (artifactCount > 0) {
    parts.push(`${artifactCount} 结果`)
  }
  if (uploadedLayerName) {
    parts.push(uploadedLayerName)
  }
  return parts.join(' · ')
}

export function fmtStatus(status?: string) {
  if (status === 'running') return '运行中'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '就绪'
}

export function fmtElapsed(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

export function formatSessionDate(dateStr: string) {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return dateStr
  }
}
