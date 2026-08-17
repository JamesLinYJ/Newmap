// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 决策响应命令
//
//   文件:       decisionCommand.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 处理统一决策协议的响应落盘与续跑。审批恢复和澄清追问都必须更新 run
// state 中的 canonical decisions，不能由前端或 timeline 分散推进状态。

import { WebSocket } from 'ws'

import type { AnalysisRun, DecisionRequest } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import { scopeRuntimeConfigToPrincipal } from '../security/runtimePrincipalScope.js'
import type { RunTaskManager } from '../agent/runTaskManager.js'
import { nowUtc } from '../utils/ids.js'
import type { WsDependencies } from './dependencies.js'
import { optionalString, requiredRunProvider, requiredString } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import { sendRunSnapshot, subscribeToRun } from './subscriptions.js'

export async function respondDecision(
  payload: Record<string, unknown>,
  dependencies: WsDependencies,
  runTasks: RunTaskManager,
  ws: WebSocket,
  subscriptions: Map<string, () => void>,
  auth: AuthContext,
): Promise<AnalysisRun> {
  const { store } = dependencies
  const runId = requiredString(payload, 'runId')
  const decisionId = requiredString(payload, 'decisionId')
  const run = store.getRun(runId)
  const decision = run.state.decisions.find(item => item.decisionId === decisionId)
  if (!decision) throw new Error(`决策 '${decisionId}' 不存在`)
  if (decision.status !== 'pending') return run

  if (decision.kind === 'approval') {
    const approved = selectedApprovalValue(decision, optionalString(payload.optionId))
    const approvalId = typeof decision.payload.approvalId === 'string' ? decision.payload.approvalId : decisionId
    if (approved) dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
    subscribeToRun(ws, runId, store, dependencies.events, subscriptions)
    return runTasks.respondToApproval(runId, approvalId, approved, auth, {
      onComplete: completedRunId => sendRunSnapshot(ws, completedRunId, store),
    })
  }

  if (decision.kind === 'clarification') {
    if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)
    const optionId = optionalString(payload.optionId)
    const answer = selectedDecisionText(decision, optionId, optionalString(payload.text))
    await store.updateRunState(runId, {
      decisions: resolveDecision(run.state.decisions, decisionId, 'answered', { optionId, answer }),
      clarification: run.state.clarification && run.state.clarification.clarificationId === decisionId
        ? { ...run.state.clarification, selectedOptionId: optionId ?? 'free_text' }
        : run.state.clarification,
    })
    const config = run.runtimeConfigSnapshot ?? await scopedRuntimeConfigForAuth(dependencies, auth)
    const provider = requiredRunProvider(run.modelProvider)
    dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
    const nextRun = await store.createRun(run.sessionId, answer, {
      threadId: run.threadId,
      modelProvider: provider,
      modelName: run.modelName,
      runProfile: run.state.runProfile,
      goal: run.state.goal ? {
        condition: run.state.goal.condition,
        acceptanceCriteria: run.state.goal.acceptanceCriteria,
        maxRechecks: run.state.goal.maxRechecks,
        deadlineAt: run.state.goal.deadlineAt,
        maxTokenBudget: run.state.goal.maxTokenBudget,
      } : null,
      runtimeConfigSnapshot: config,
    })
    subscribeToRun(ws, nextRun.id, store, dependencies.events, subscriptions)
    runTasks.startDetached({
      runId: nextRun.id,
      threadId: run.threadId,
      sessionId: run.sessionId,
      query: answer,
      provider,
      modelName: nextRun.modelName,
      runtimeConfig: config,
      executionMode: run.state.planMode ? 'plan' : 'auto',
      runProfile: run.state.runProfile,
      reasoning: true,
      auth,
    }, { onComplete: nextRunId => sendRunSnapshot(ws, nextRunId, store) })
    return nextRun
  }

  throw new Error(`决策 '${decisionId}' 不能通过 run:respond-decision 提交`)
}

async function scopedRuntimeConfigForAuth(dependencies: WsDependencies, auth: AuthContext) {
  const resolved = await resolveRuntimeConfig(
    dependencies.store.runtimeConfiguration,
    dependencies.defaultRuntimeConfig,
  )
  return scopeRuntimeConfigToPrincipal(dependencies.store.runtimeRoot, resolved, auth)
}

function selectedApprovalValue(decision: DecisionRequest, optionId: string | null): boolean {
  const option = optionId ? decision.options.find(item => item.optionId === optionId) : null
  if (!option) throw new Error('审批决策必须选择批准或拒绝')
  if (typeof option.payload.approved !== 'boolean') throw new Error('审批决策选项缺少 approved payload')
  return option.payload.approved
}

function selectedDecisionText(decision: DecisionRequest, optionId: string | null, text: string | null): string {
  if (text) return text
  const option = optionId ? decision.options.find(item => item.optionId === optionId) : null
  if (option?.label?.trim()) return option.label.trim()
  throw new Error('澄清决策必须选择一个选项或输入补充文本')
}

function resolveDecision(
  decisions: DecisionRequest[],
  decisionId: string,
  status: string,
  payload: Record<string, unknown>,
): DecisionRequest[] {
  const resolvedAt = nowUtc()
  return decisions.map(decision => decision.decisionId === decisionId
    ? { ...decision, status, resolvedAt, payload: { ...decision.payload, ...payload } }
    : decision)
}
