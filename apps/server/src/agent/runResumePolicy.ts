// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent checkpoint 恢复策略
//
// --------------------------------------------------------------------------

import type { AnalysisRun, RunCheckpoint } from '../schemas/types.js'
import { StoreConflictError } from '../store/storeErrors.js'

/**
 * Generic run:resume is a crash-recovery operation, not a retry button.
 * It can consume only an interrupted Agents SDK checkpoint whose tool ledger
 * is known and whose decision flow is not waiting for a dedicated response.
 */
export function assertRunCheckpointResumable(
  run: AnalysisRun,
  checkpoint: RunCheckpoint,
): void {
  if (run.status !== 'interrupted') {
    throw new StoreConflictError(
      `运行 '${run.id}' 当前状态为 '${run.status}'，不能通过 run:resume 重新执行。${resumeGuidance(run.status)}`,
    )
  }

  const pendingDecision = run.state.decisions.find(decision => (
    decision.status === 'pending' || decision.status === 'preparing'
  ))
  const pendingApproval = run.state.approvals.find(approval => approval.status === 'pending')
  if (pendingDecision || pendingApproval) {
    throw new StoreConflictError(
      `运行 '${run.id}' 仍有待处理决策，必须使用对应的 decision/approval 流程，不能 generic resume。`,
    )
  }

  if (checkpoint.recoveryStatus !== 'interrupted') {
    throw new StoreConflictError(
      `运行 '${run.id}' 的 checkpoint 恢复状态为 '${checkpoint.recoveryStatus}'，不是可恢复的中断状态。`,
    )
  }
  if (checkpoint.pendingToolCallIds.length) {
    throw new StoreConflictError(
      `运行包含状态未知的工具调用，禁止自动重放：${checkpoint.pendingToolCallIds.join(', ')}`,
    )
  }
  if (!checkpoint.sdkStateContentHash || !checkpoint.activeEntryId) {
    throw new StoreConflictError(
      `运行 '${run.id}' 缺少完整的 Agents SDK checkpoint，不能安全恢复。`,
    )
  }
}

function resumeGuidance(status: AnalysisRun['status']): string {
  if (status === 'clarification_needed') return '请通过 run:respond-decision 回答澄清。'
  if (status === 'waiting_approval') return '请通过 run:respond-decision 处理审批。'
  if (status === 'requires_action') return '请先人工处理状态未知的工具调用。'
  if (status === 'completed' || status === 'cancelled' || status === 'failed') {
    return '如需重试，应创建带 lineage 的新运行，不能改写终态运行。'
  }
  return '该运行不是可恢复的中断状态。'
}
