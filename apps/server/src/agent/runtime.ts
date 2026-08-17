// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK 运行时
//
//   文件:       runtime.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { errorLogPayload, logger } from '../observability/logger.js'
import type { LocalAgentTracing } from '../observability/agentTracing.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ModelCompletionService } from '../model/modelResultCache.js'
import type { AnalysisRun } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'
import {
  createMemoryRuntime,
  dreamMemories,
  extractMemoriesFromThread,
} from '../memory/service.js'
import {
  createSdkMemoryDreamer,
  createSdkMemoryExtractor,
} from '../memory/sdkMemoryExtractor.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import type { AuthContext } from '../security/types.js'
import {
  errorMessage,
  functionCallId,
  requireString,
  requireThreadId,
} from './runtimeSdkProjection.js'
import { approvalRejectionMessage, resolveDecision } from './runtimeApprovals.js'
import type { SandboxClientFactory } from './runtimeSandbox.js'
import { AgentsCheckpointService } from './agentsCheckpointService.js'
import { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import { RuntimeApprovalPersistence } from './runtimeApprovalPersistence.js'
import { RunSteeringController } from './runSteeringController.js'
import type { RunOptions } from './runtimeTypes.js'
import { runtimeFailure } from './runtimeErrors.js'
import { RuntimeSdkExecutor } from './runtimeSdkExecutor.js'
import { RuntimeAssemblyFactory } from './runtimeAssembly.js'
import { GoalJudge, type GoalJudgePort } from './goalJudge.js'
import { SubAgentControlPlane, type SubAgentControlInput } from './subAgentControlPlane.js'
import { authorizedAttachmentSummaries } from './multimodalInput.js'
import { withToolAuthorizationLease } from './runToolConcurrencyGate.js'

export type { SandboxClientFactory } from './runtimeSandbox.js'
export type { RunOptions } from './runtimeTypes.js'

export interface OpenAIAgentsRuntimeOptions {
  createSandboxClient?: SandboxClientFactory
  agentTracing?: LocalAgentTracing
  goalJudge?: GoalJudgePort
  authorizationLease?: (auth: AuthContext, run: AnalysisRun) => Promise<AuthContext>
}

// OpenAIAgentsRuntime
//
// Runner 是单次 run 内编排的唯一状态机；本类只投影 SDK 事件并维护 平台
// 内容载荷存储、审批边界和通用工具/Automation 入口。
export class OpenAIAgentsRuntime {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly checkpoints: AgentsCheckpointService
  private readonly transcriptProjector: RuntimeTranscriptProjector
  private readonly approvalPersistence: RuntimeApprovalPersistence
  private readonly steering: RunSteeringController
  private readonly sdkExecutor: RuntimeSdkExecutor
  private readonly assemblyFactory: RuntimeAssemblyFactory
  private readonly subAgentControls: SubAgentControlPlane

  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly modelRegistry: ModelAdapterRegistry,
    private readonly runtimeOptions: OpenAIAgentsRuntimeOptions = {},
    modelCompletions?: ModelCompletionService,
  ) {
    this.subAgentControls = new SubAgentControlPlane(store)
    this.checkpoints = new AgentsCheckpointService(store)
    this.transcriptProjector = new RuntimeTranscriptProjector(store, toolRegistry)
    this.approvalPersistence = new RuntimeApprovalPersistence(store, toolRegistry, this.checkpoints)
    this.steering = new RunSteeringController(store)
    this.assemblyFactory = new RuntimeAssemblyFactory({
      store,
      toolRegistry,
      modelRegistry,
      transcriptProjector: this.transcriptProjector,
      runtimeOptions,
      subAgentControls: this.subAgentControls,
      ...(modelCompletions ? { modelCompletions } : {}),
      recordWarning: (runId, message, eventSink) => this.recordWarning(runId, message, eventSink),
    })
    this.sdkExecutor = new RuntimeSdkExecutor({
      store,
      checkpoints: this.checkpoints,
      transcriptProjector: this.transcriptProjector,
      approvalPersistence: this.approvalPersistence,
      steering: this.steering,
      goalJudge: runtimeOptions.goalJudge ?? new GoalJudge(store, modelCompletions),
    })
  }

  async run(options: RunOptions): Promise<AnalysisRun> {
    const threadId = requireThreadId(options.threadId)
    const eventSink = new RunEventSink(event => this.store.appendEvent(options.runId, event), options.runId, threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), options.runId, threadId)
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(options.runId, status))
    const abort = new AbortController()
    const unlinkExternalAbort = linkAbortSignal(options.signal, abort)
    if (this.abortControllers.has(options.runId)) {
      unlinkExternalAbort()
      throw new Error(`运行 '${options.runId}' 已有活动执行器`)
    }
    this.abortControllers.set(options.runId, abort)
    let detachTracing = (): void => {}
    try {
      detachTracing = this.runtimeOptions.agentTracing?.attachRun(options.runId) ?? (() => {})
      await this.refreshAuthorization(options)
      await this.store.updateRunStatus(options.runId, 'running')
      if (!options.resume && (options.executionMode === 'plan' || options.runProfile === 'geospatial_compose')) {
        await this.store.updateRunState(options.runId, {
          runProfile: options.runProfile ?? 'standard',
          planMode: true,
          agentWorkflow: null,
        })
      }

      const turnId = options.resume
        ? await this.checkpoints.requireTurnId(threadId, options.runId)
        : makeId('turn')
      if (!options.resume) {
        const attachmentSummaries = authorizedAttachmentSummaries(this.store.getRun(options.runId))
        const userEntry = await this.store.appendTranscript({
          threadId,
          runId: options.runId,
          turnId,
          kind: 'message',
          payload: {
            role: 'user',
            content: options.query,
            ...(attachmentSummaries.length ? { attachments: attachmentSummaries } : {}),
          },
        })
        itemSink.appendUserMessage(options.query, { transcriptEntryId: userEntry.entryId })
        eventSink.emit('intent.parsed', '开始分析...', {})
      }

      await this.steering.open(options.runId, { recoverLeased: options.resume === true })
      const completed = await withToolAuthorizationLease(
        () => this.refreshAuthorization(options),
        async () => {
          await this.refreshAuthorization(options)
          const assembly = await this.assemblyFactory.create(options, threadId, turnId, eventSink, itemSink, abort.signal)
          const resumeState = options.resume
            ? await this.checkpoints.restore({
              runId: options.runId,
              agent: assembly.agent,
              context: assembly.context,
              sdkVersion: assembly.sdkVersion,
              configDigest: assembly.configDigest,
            })
            : null
          return this.sdkExecutor.execute(
            options,
            assembly,
            resumeState,
            abort.signal,
            eventSink,
            itemSink,
          )
        },
      )
      if (completed === 'waiting_approval') return this.store.getRun(options.runId)
      if (completed === 'clarification_needed') return this.store.getRun(options.runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, threadId, eventSink)
      return this.store.getRun(options.runId)
    } catch (error) {
      const current = this.store.getRun(options.runId)
      const failure = runtimeFailure(error, { failedTool: current.state.failedTool })
      const message = failure.message
      logger.error({
        error: errorLogPayload(error),
        failureSource: failure.source,
        failureCode: failure.code,
      }, 'run failed')
      if (abort.signal.aborted) {
        if (current.state.goal && ['active', 'evaluating'].includes(current.state.goal.status)) {
          const cancelledAt = nowUtc()
          await this.store.updateRunState(options.runId, {
            goal: {
              ...current.state.goal,
              status: 'cancelled',
              failureReason: '运行已取消。',
              updatedAt: cancelledAt,
              completedAt: cancelledAt,
            },
          })
        }
        await finalizer.cancel()
      } else {
        const failedAt = nowUtc()
        await this.store.updateRunState(options.runId, {
          errors: [...current.state.errors, message],
          failure,
          goal: current.state.goal && ['active', 'evaluating'].includes(current.state.goal.status)
            ? {
                ...current.state.goal,
                status: 'failed',
                failureReason: message,
                updatedAt: failedAt,
                completedAt: failedAt,
              }
            : current.state.goal,
        })
        await finalizer.fail(message, [], failure)
      }
      return this.store.getRun(options.runId)
    } finally {
      detachTracing()
      try {
        await eventSink.flush()
      } finally {
        try {
          await this.steering.close(options.runId)
        } finally {
          unlinkExternalAbort()
          this.subAgentControls.finishRun(options.runId)
          this.abortControllers.delete(options.runId)
        }
      }
    }
  }

  async cancel(runId: string): Promise<AnalysisRun> {
    const controller = this.abortControllers.get(runId)
    if (!controller) throw new Error(`运行 '${runId}' 不可取消`)
    controller.abort()
    const run = await this.store.updateRunStatus(runId, 'cancelled')
    if (!run.state.goal || !['active', 'evaluating'].includes(run.state.goal.status)) return run
    const cancelledAt = nowUtc()
    return this.store.updateRunState(runId, {
      goal: {
        ...run.state.goal,
        status: 'cancelled',
        failureReason: '运行已取消。',
        updatedAt: cancelledAt,
        completedAt: cancelledAt,
      },
    })
  }

  steer(runId: string, steeringId: string, content: string) {
    return this.steering.enqueue(runId, steeringId, content)
  }

  followUpSubAgent(input: SubAgentControlInput) {
    return this.subAgentControls.followUp(input)
  }

  cancelSubAgent(input: SubAgentControlInput) {
    return this.subAgentControls.cancel(input)
  }

  async acceptApprovalDecision(
    runId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<{ run: AnalysisRun; accepted: boolean }> {
    const run = this.store.getRun(runId)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    if (approval.payload.consumed === true) {
      return { run, accepted: false }
    }

    const expectedStatus = approved ? 'approved' : 'rejected'
    // WS 在审批已经落盘、后台任务尚未成功登记时断开，可以安全重试同一决定。
    // 只允许 queued 状态重试；一旦续跑进入 running/failed，禁止重放副作用。
    if (approval.status === expectedStatus) {
      return { run, accepted: run.status === 'queued' }
    }
    if (approval.status !== 'pending') return { run, accepted: false }

    const resolvedApproval = {
      ...approval,
      status: approved ? 'approved' as const : 'rejected' as const,
      resolvedAt: nowUtc(),
    }
    await this.store.updateRunState(runId, {
      approvals: run.state.approvals.map(candidate => candidate.approvalId === approvalId
        ? resolvedApproval
        : candidate),
      decisions: resolveDecision(run.state.decisions, approvalId, approved ? 'approved' : 'rejected', { approved }),
    })
    await this.store.updateRunStatus(runId, 'queued')
    return { run: this.store.getRun(runId), accepted: true }
  }

  async continueApprovalDecision(
    runId: string,
    approvalId: string,
    approved: boolean,
    auth?: AuthContext | null,
    signal?: AbortSignal,
  ): Promise<AnalysisRun> {
    const run = this.store.getRun(runId)
    const threadId = requireThreadId(run.threadId)
    if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot`)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    const expectedStatus = approved ? 'approved' : 'rejected'
    if (approval.status !== expectedStatus || approval.payload.consumed === true) {
      throw new Error(`审批 '${approvalId}' 未处于可续跑的 ${expectedStatus} 状态`)
    }
    const eventSink = new RunEventSink(event => this.store.appendEvent(runId, event), runId, threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), runId, threadId)
    const turnId = requireString(approval.payload.turnId, '审批 payload.turnId')
    const options: RunOptions = {
      runId,
      threadId,
      sessionId: run.sessionId,
      query: run.userQuery,
      provider: requireString(run.modelProvider, '运行 modelProvider'),
      modelName: run.modelName,
      runtimeConfig: run.runtimeConfigSnapshot,
      runProfile: run.state.runProfile,
      reasoning: true,
      resume: true,
      auth: auth ?? null,
    }
    const abort = new AbortController()
    const unlinkExternalAbort = linkAbortSignal(signal, abort)
    if (this.abortControllers.has(runId)) {
      unlinkExternalAbort()
      throw new Error(`运行 '${runId}' 已有活动执行器`)
    }
    this.abortControllers.set(runId, abort)
    let detachTracing = (): void => {}
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
    try {
      detachTracing = this.runtimeOptions.agentTracing?.attachRun(runId) ?? (() => {})
      await this.refreshAuthorization(options)
      await this.store.updateRunStatus(runId, 'running')
      await this.steering.open(runId, { recoverLeased: true })
      const result = await withToolAuthorizationLease(
        () => this.refreshAuthorization(options),
        async () => {
          await this.refreshAuthorization(options)
          const assembly = await this.assemblyFactory.create(
            options,
            threadId,
            turnId,
            eventSink,
            itemSink,
            abort.signal,
            false,
          )
          const state = await this.checkpoints.restore({
            runId: options.runId,
            agent: assembly.agent,
            context: assembly.context,
            sdkVersion: assembly.sdkVersion,
            configDigest: assembly.configDigest,
          })
          const callId = requireString(approval.payload.callId, '审批 payload.callId')
          const interruption = state.getInterruptions().find(item => functionCallId(item) === callId)
          if (!interruption) throw new Error(`SDK 状态中不存在待审批调用 '${callId}'`)
          if (approved) state.approve(interruption)
          else state.reject(interruption, { message: approvalRejectionMessage(approval.action) })
          return this.sdkExecutor.execute(options, assembly, state, abort.signal, eventSink, itemSink)
        },
      )
      // SDK 执行器可能在拒绝后立即产生一条新的审批。必须以刚落盘的
      // run state 为事实源，只消费当前审批，不能用恢复前的 approvals 快照
      // 覆盖新审批，否则前端会拿到一个在 approvals 中已经消失的 decisionId。
      const latest = this.store.getRun(runId)
      await this.store.updateRunState(runId, {
        approvals: latest.state.approvals.map(candidate => candidate.approvalId === approvalId
          ? { ...candidate, payload: { ...candidate.payload, consumed: true } }
          : candidate),
        decisions: resolveDecision(latest.state.decisions, approvalId, approved ? 'approved' : 'rejected', { approved, consumed: true }),
      })
      if (result === 'waiting_approval') return this.store.getRun(runId)
      if (result === 'clarification_needed') return this.store.getRun(runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, threadId, eventSink)
      return this.store.getRun(runId)
    } catch (error) {
      const current = this.store.getRun(runId)
      const failure = runtimeFailure(error, { failedTool: current.state.failedTool })
      const message = failure.message
      logger.error({
        error: errorLogPayload(error),
        failureSource: failure.source,
        failureCode: failure.code,
      }, 'approval continuation failed')
      if (abort.signal.aborted) {
        await finalizer.cancel()
      } else {
        await this.store.updateRunState(runId, {
          errors: [...current.state.errors, message],
          failure,
        })
        await finalizer.fail(message, [], failure)
      }
      return this.store.getRun(runId)
    } finally {
      detachTracing()
      try {
        await eventSink.flush()
      } finally {
        try {
          await this.steering.close(runId)
        } finally {
          unlinkExternalAbort()
          this.abortControllers.delete(runId)
        }
      }
    }
  }

  async resolveApproval(runId: string, approvalId: string, approved: boolean, auth?: AuthContext | null): Promise<AnalysisRun> {
    const receipt = await this.acceptApprovalDecision(runId, approvalId, approved)
    if (!receipt.accepted) return receipt.run
    return this.continueApprovalDecision(runId, approvalId, approved, auth)
  }

  private async refreshAuthorization(options: RunOptions): Promise<void> {
    const auth = options.auth
    if (!auth) return
    const lease = this.runtimeOptions.authorizationLease
    if (!lease) throw new Error('Agent 运行缺少持续授权租约。')
    options.auth = await lease(auth, this.store.getRun(options.runId))
  }

  private async maybeExtractLongTermMemories(options: RunOptions, threadId: string, eventSink: RunEventSink): Promise<void> {
    const config = options.runtimeConfig.context
    if (!config.memoryEnabled || !config.memoryAutoExtractEnabled) return
    if (!this.memoryToolsAvailable()) return
    try {
      const adapter = this.modelRegistry.resolveProvider(options.runtimeConfig.context.summaryProvider ?? options.provider)
      const model = options.runtimeConfig.context.summaryModel
        ?? adapter.subagentModel
        ?? options.modelName
        ?? adapter.defaultModel
      if (!model) throw new Error('未配置记忆提取模型')
      const runtimeMemory = createMemoryRuntime(this.store.runtimeRoot, config)
      await extractMemoriesFromThread(
        runtimeMemory,
        this.store,
        threadId,
        options.runId,
        createSdkMemoryExtractor(adapter, model, options.signal),
      )
      if (config.memoryAutoDreamEnabled) {
        await dreamMemories(runtimeMemory, createSdkMemoryDreamer(adapter, model, options.signal))
      }
    } catch (error) {
      await this.recordWarning(options.runId, `长期记忆自动提取失败：${errorMessage(error)}`, eventSink)
    }
  }

  private async recordWarning(runId: string, message: string, eventSink: RunEventSink): Promise<void> {
    const run = this.store.getRun(runId)
    await this.store.updateRunState(runId, { warnings: [...run.state.warnings, message] })
    eventSink.emit('warning.raised', message, {})
  }

  private memoryToolsAvailable(): boolean {
    return Boolean(this.toolRegistry.get('list_memories')
      && this.toolRegistry.get('search_memory')
      && this.toolRegistry.get('read_memory')
      && this.toolRegistry.get('write_memory')
      && this.toolRegistry.get('forget_memory'))
  }
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abortTarget = () => target.abort(source.reason)
  if (source.aborted) {
    abortTarget()
    return () => {}
  }
  source.addEventListener('abort', abortTarget, { once: true })
  return () => source.removeEventListener('abort', abortTarget)
}
