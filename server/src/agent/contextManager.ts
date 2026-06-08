// +-------------------------------------------------------------------------
//
//   地理智能平台 - 上下文管理器
//
//   文件:       contextManager.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { RuntimeContextConfig, AgentState } from '../schemas/types.js'
import type { ConversationDigest } from '../conversation/items.js'

export interface ContextPacket {
  projectContext: string
  memoryContext: string
  toolDescriptions: string
  historySummary: string
  estimatedTokens: number
}

// buildContextPacket
//
// 收集当前运行所需的全部上下文。
export function buildContextPacket(
  state: AgentState,
  config: RuntimeContextConfig,
  recentTurns: ConversationDigest[],
  toolDescriptions: string,
): ContextPacket {
  const packet: ContextPacket = {
    projectContext: '',
    memoryContext: '',
    toolDescriptions,
    historySummary: buildHistorySummary(recentTurns, config.historyRunLimit),
    estimatedTokens: 0,
  }

  // Estimate token count (rough: 4 chars ≈ 1 token)
  const totalText = packet.historySummary + toolDescriptions
  packet.estimatedTokens = Math.ceil(totalText.length / 4)

  return packet
}

// buildHistorySummary
//
// 从最近的运行中构建历史摘要。
function buildHistorySummary(turns: ConversationDigest[], limit: number): string {
  const recent = turns.slice(0, limit)
  if (recent.length === 0) return ''

  return recent
    .map(turn => `[${turn.createdAt}] 查询: "${turn.userQuery}" → ${turn.assistantSummary}`)
    .join('\n')
}

// buildCompactionBoundary
//
// 返回当前上下文窗口是否接近极限，以及是否需要触发压缩。
export function checkCompaction(estimatedTokens: number, maxTokens: number): {
  needsCompaction: boolean
  severity: 'none' | 'mild' | 'severe'
} {
  const ratio = estimatedTokens / maxTokens
  if (ratio > 0.9) return { needsCompaction: true, severity: 'severe' }
  if (ratio > 0.7) return { needsCompaction: true, severity: 'mild' }
  return { needsCompaction: false, severity: 'none' }
}

// isContextLengthExceeded
export function isContextLengthExceeded(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return msg.includes('context_length_exceeded') ||
    msg.includes('too long') ||
    msg.includes('maximum context length') ||
    msg.includes('token limit')
}
