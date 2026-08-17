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

import type { AnalysisRun, ContextReference, DecisionRequest } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import { scopeRuntimeConfigToPrincipal } from '../security/runtimePrincipalScope.js'
import type { RunTaskManager } from '../agent/runTaskManager.js'
import { StoreConflictError } from '../store/storeErrors.js'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'
import { reauthorizeContinuationAttachments } from '../conversation/runAttachmentAuthorization.js'
import { nowUtc } from '../utils/ids.js'
import type { WsDependencies } from './dependencies.js'
import { optionalString, requiredRunProvider, requiredString } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import { sendRunSnapshot, subscribeToRun } from './subscriptions.js'

const CLARIFICATION_CONTINUATION_KIND = 'clarification_continuation'
const ATTACHMENT_REFERENCE_KINDS = new Set(['image_attachment', 'map_screenshot'])
const clarificationContinuationTails = new Map<string, Promise<void>>()

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
  const initialRun = store.getRun(runId)
  const initialDecision = requireDecision(initialRun, decisionId)

  if (initialDecision.kind === 'approval') {
    if (initialDecision.status !== 'pending') return initialRun
    const approved = selectedApprovalValue(initialDecision, optionalString(payload.optionId))
    const approvalId = typeof initialDecision.payload.approvalId === 'string'
      ? initialDecision.payload.approvalId
      : decisionId
    if (approved) dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
    subscribeToRun(ws, runId, store, dependencies.events, subscriptions)
    return runTasks.respondToApproval(runId, approvalId, approved, auth, {
      onComplete: completedRunId => sendRunSnapshot(ws, completedRunId, store),
    })
  }

  if (initialDecision.kind === 'clarification') {
    const optionId = optionalString(payload.optionId)
    const answer = selectedDecisionText(initialDecision, optionId, optionalString(payload.text))
    return serializeClarificationContinuation(`${runId}\u0000${decisionId}`, async () => {
      const sourceRun = store.getRun(runId)
      const decision = requireDecision(sourceRun, decisionId)
      if (decision.kind !== 'clarification') {
        throw new StoreConflictError(`决策 '${decisionId}' 已不再是澄清决策。`)
      }
      assertSameClarificationAnswer(decision, optionId, answer)
      if (!sourceRun.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)
      const threadId = sourceRun.threadId

      let continuation = findClarificationContinuation(
        store.listRunsForThread(threadId),
        sourceRun.id,
        decisionId,
      )
      if (!continuation) {
        dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
        await reserveClarificationDecision(dependencies, sourceRun.id, decisionId, optionId, answer)
        const reservedRun = store.getRun(sourceRun.id)
        const config = reservedRun.runtimeConfigSnapshot
          ?? await scopedRuntimeConfigForAuth(dependencies, auth)
        const provider = requiredRunProvider(reservedRun.modelProvider)
        const contextReferences = await inheritContinuationContext(
          store.fileLifecycle,
          threadId,
          reservedRun.state.contextReferences,
          reservedRun.id,
          decisionId,
        )
        continuation = await store.createRun(reservedRun.sessionId, answer, {
          threadId,
          modelProvider: provider,
          modelName: reservedRun.modelName,
          runProfile: reservedRun.state.runProfile,
          goal: reservedRun.state.goal ? {
            condition: reservedRun.state.goal.condition,
            acceptanceCriteria: reservedRun.state.goal.acceptanceCriteria,
            maxRechecks: reservedRun.state.goal.maxRechecks,
            deadlineAt: reservedRun.state.goal.deadlineAt,
            maxTokenBudget: reservedRun.state.goal.maxTokenBudget,
          } : null,
          runtimeConfigSnapshot: config,
          contextReferences,
        })
      }

      await finalizeClarificationDecision(
        dependencies,
        sourceRun.id,
        decisionId,
        optionId,
        answer,
        continuation.id,
      )
      subscribeToRun(ws, continuation.id, store, dependencies.events, subscriptions)
      await launchClarificationContinuationIfNeeded(
        dependencies,
        runTasks,
        continuation,
        auth,
        ws,
      )
      return store.getRun(continuation.id)
    })
  }

  throw new Error(`决策 '${decisionId}' 不能通过 run:respond-decision 提交`)
}

async function reserveClarificationDecision(
  dependencies: WsDependencies,
  runId: string,
  decisionId: string,
  optionId: string | null,
  answer: string,
): Promise<void> {
  await dependencies.store.mutateRunState(runId, state => {
    const decision = state.decisions.find(candidate => candidate.decisionId === decisionId)
    if (!decision) throw new Error(`决策 '${decisionId}' 不存在`)
    assertSameClarificationAnswer(decision, optionId, answer)
    if (decision.status === 'preparing' || decision.status === 'answered') return {}
    if (decision.status !== 'pending') {
      throw new StoreConflictError(`决策 '${decisionId}' 当前状态为 '${decision.status}'，不能创建澄清续跑。`)
    }
    return {
      decisions: state.decisions.map(candidate => candidate.decisionId === decisionId
        ? {
            ...candidate,
            status: 'preparing',
            payload: {
              ...candidate.payload,
              optionId: optionId ?? null,
              answer,
              continuationState: 'reserved',
            },
          }
        : candidate),
      clarification: state.clarification?.clarificationId === decisionId
        ? { ...state.clarification, selectedOptionId: optionId ?? 'free_text' }
        : state.clarification,
    }
  })
}

async function finalizeClarificationDecision(
  dependencies: WsDependencies,
  runId: string,
  decisionId: string,
  optionId: string | null,
  answer: string,
  continuationRunId: string,
): Promise<void> {
  await dependencies.store.mutateRunState(runId, state => {
    const decision = state.decisions.find(candidate => candidate.decisionId === decisionId)
    if (!decision) throw new Error(`决策 '${decisionId}' 不存在`)
    assertSameClarificationAnswer(decision, optionId, answer)
    const existingRunId = typeof decision.payload.continuationRunId === 'string'
      ? decision.payload.continuationRunId
      : null
    if (existingRunId && existingRunId !== continuationRunId) {
      throw new StoreConflictError(
        `决策 '${decisionId}' 已绑定续跑 '${existingRunId}'，不能改绑到 '${continuationRunId}'。`,
      )
    }
    if (decision.status === 'answered' && existingRunId === continuationRunId) return {}
    if (decision.status !== 'preparing' && decision.status !== 'pending' && decision.status !== 'answered') {
      throw new StoreConflictError(`决策 '${decisionId}' 当前状态为 '${decision.status}'，不能完成澄清续跑。`)
    }
    return {
      decisions: state.decisions.map(candidate => candidate.decisionId === decisionId
        ? {
            ...candidate,
            status: 'answered',
            resolvedAt: candidate.resolvedAt ?? nowUtc(),
            payload: {
              ...candidate.payload,
              optionId: optionId ?? null,
              answer,
              continuationState: 'created',
              continuationRunId,
            },
          }
        : candidate),
      clarification: state.clarification?.clarificationId === decisionId
        ? { ...state.clarification, selectedOptionId: optionId ?? 'free_text' }
        : state.clarification,
    }
  })
}

async function launchClarificationContinuationIfNeeded(
  dependencies: WsDependencies,
  runTasks: RunTaskManager,
  continuation: AnalysisRun,
  auth: AuthContext,
  ws: WebSocket,
): Promise<void> {
  let launchable = continuation
  if (launchable.status === 'interrupted') {
    const checkpoint = await dependencies.store.getRunCheckpoint(launchable.id)
    const neverStarted = checkpoint.activeEntryId === null
      && checkpoint.sdkStateContentHash === null
      && checkpoint.pendingToolCallIds.length === 0
    if (neverStarted) launchable = await dependencies.store.updateRunStatus(launchable.id, 'queued')
  }
  if (launchable.status !== 'queued') return
  if (!launchable.threadId) throw new Error(`澄清续跑 '${launchable.id}' 缺少 threadId`)
  if (!launchable.runtimeConfigSnapshot) {
    throw new Error(`澄清续跑 '${launchable.id}' 缺少 runtimeConfigSnapshot`)
  }
  const provider = requiredRunProvider(launchable.modelProvider)
  runTasks.startDetachedIfIdle({
    runId: launchable.id,
    threadId: launchable.threadId,
    sessionId: launchable.sessionId,
    query: launchable.userQuery,
    provider,
    modelName: launchable.modelName,
    runtimeConfig: launchable.runtimeConfigSnapshot,
    executionMode: launchable.state.planMode ? 'plan' : 'auto',
    runProfile: launchable.state.runProfile,
    reasoning: true,
    auth,
  }, { onComplete: nextRunId => sendRunSnapshot(ws, nextRunId, dependencies.store) })
}

async function inheritContinuationContext(
  fileLifecycle: Pick<FileLifecyclePort, 'list'>,
  threadId: string,
  source: readonly ContextReference[],
  sourceRunId: string,
  decisionId: string,
): Promise<ContextReference[]> {
  const attachments = await reauthorizeContinuationAttachments(
    fileLifecycle,
    threadId,
    sourceRunId,
    source,
  )
  const inherited = source
    .filter(reference => !ATTACHMENT_REFERENCE_KINDS.has(reference.kind)
      && reference.kind !== CLARIFICATION_CONTINUATION_KIND)
    .map(reference => structuredClone(reference))
  const marker: ContextReference = {
    referenceId: `clarification:${sourceRunId}:${decisionId}`,
    kind: CLARIFICATION_CONTINUATION_KIND,
    label: '澄清续跑来源',
    description: '当前运行由上一运行的澄清决策继续。',
    sourceRunId,
    artifactId: null,
    collectionRef: null,
    layerKey: null,
    confidence: 1,
    usableAs: ['continuation_lineage'],
    metadata: { decisionId, internal: true },
  }
  return [...inherited, ...attachments, marker]
}

function findClarificationContinuation(
  runs: readonly AnalysisRun[],
  sourceRunId: string,
  decisionId: string,
): AnalysisRun | null {
  const matches = runs.filter(run => run.id !== sourceRunId && run.state.contextReferences.some(reference => (
    reference.kind === CLARIFICATION_CONTINUATION_KIND
    && reference.sourceRunId === sourceRunId
    && reference.metadata.decisionId === decisionId
  )))
  if (matches.length > 1) {
    throw new StoreConflictError(
      `澄清决策 '${decisionId}' 关联了多个续跑：${matches.map(run => run.id).join('、')}。`,
    )
  }
  return matches[0] ?? null
}

function assertSameClarificationAnswer(
  decision: DecisionRequest,
  optionId: string | null,
  answer: string,
): void {
  if (decision.status === 'pending') return
  const storedAnswer = typeof decision.payload.answer === 'string' ? decision.payload.answer : null
  const storedOptionId = typeof decision.payload.optionId === 'string' ? decision.payload.optionId : null
  if (storedAnswer !== answer || storedOptionId !== optionId) {
    throw new StoreConflictError(`决策 '${decision.decisionId}' 已使用不同答案处理，control retry 被拒绝。`)
  }
}

async function serializeClarificationContinuation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = clarificationContinuationTails.get(key) ?? Promise.resolve()
  let current!: Promise<T>
  current = previous.then(operation, operation)
  const tail = current.then(() => undefined, () => undefined)
  clarificationContinuationTails.set(key, tail)
  try {
    return await current
  } finally {
    if (clarificationContinuationTails.get(key) === tail) clarificationContinuationTails.delete(key)
  }
}

async function scopedRuntimeConfigForAuth(dependencies: WsDependencies, auth: AuthContext) {
  const resolved = await resolveRuntimeConfig(
    dependencies.store.runtimeConfiguration,
    dependencies.defaultRuntimeConfig,
  )
  return scopeRuntimeConfigToPrincipal(dependencies.store.runtimeRoot, resolved, auth)
}

function requireDecision(run: AnalysisRun, decisionId: string): DecisionRequest {
  const decision = run.state.decisions.find(item => item.decisionId === decisionId)
  if (!decision) throw new Error(`决策 '${decisionId}' 不存在`)
  return decision
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
