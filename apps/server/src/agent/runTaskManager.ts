// +-------------------------------------------------------------------------
//
//   地理智能平台 - 后台运行任务管理器
//
//   文件:       runTaskManager.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { AnalysisRun } from '../schemas/types.js'
import type { RunLookupStore } from '../store/runtimePorts.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import type { OpenAIAgentsRuntime, RunOptions } from './runtime.js'
import type { BackgroundTaskRegistry } from '../automations/backgroundTaskRegistry.js'
import type { AuthContext } from '../security/types.js'

export interface RunTaskCompletionTarget {
  onComplete?: (runId: string) => Promise<void> | void
}

// RunTaskManager 是所有“后台 run”的唯一启动入口。WS、未来的定时任务和
// automation 调度器都只创建 run 事实，再委托这里执行，避免散落 fire-and-forget。
export class RunTaskManager {
  private readonly activeTasks = new Map<string, Promise<AnalysisRun>>()
  private readonly activeBackgroundTaskIds = new Map<string, string>()
  private readonly launchingRunIds = new Set<string>()

  constructor(
    private readonly runtime: OpenAIAgentsRuntime,
    private readonly store: RunLookupStore,
    private readonly backgroundTasks?: BackgroundTaskRegistry,
  ) {}

  start(options: RunOptions, target: RunTaskCompletionTarget = {}): Promise<AnalysisRun> {
    const runTask = (signal?: AbortSignal) => this.runtime.run(signal ? { ...options, signal } : options)
    return this.startManagedTask({
      runId: options.runId,
      backgroundTaskId: options.runId,
      label: options.query.slice(0, 80) || `运行 ${options.runId}`,
      metadata: { runId: options.runId, threadId: options.threadId ?? null, sessionId: options.sessionId },
      run: runTask,
      target,
    })
  }

  async respondToApproval(
    runId: string,
    approvalId: string,
    approved: boolean,
    auth: AuthContext | null,
    target: RunTaskCompletionTarget = {},
  ): Promise<AnalysisRun> {
    this.assertAvailable(runId)
    this.launchingRunIds.add(runId)
    try {
      const receipt = await this.runtime.acceptApprovalDecision(runId, approvalId, approved)
      if (!receipt.accepted) return receipt.run
      this.startManagedTask({
        runId,
        backgroundTaskId: `${runId}:approval:${approvalId}`,
        label: `${approved ? '批准' : '拒绝'}审批后继续运行 ${runId}`,
        metadata: { runId, approvalId, approved },
        run: signal => this.runtime.continueApprovalDecision(runId, approvalId, approved, auth, signal),
        target,
        claimedLaunch: true,
      }).catch(error => {
        // startManagedTask owns runtime failures. This catch only protects task creation.
        logger.error({ error: errorLogPayload(error), runId, approvalId }, 'approval continuation launch failed')
      })
      return receipt.run
    } finally {
      this.launchingRunIds.delete(runId)
    }
  }

  private startManagedTask(input: {
    runId: string
    backgroundTaskId: string
    label: string
    metadata: Record<string, unknown>
    run: (signal?: AbortSignal) => Promise<AnalysisRun>
    target: RunTaskCompletionTarget
    claimedLaunch?: boolean
  }): Promise<AnalysisRun> {
    this.assertAvailable(input.runId, input.claimedLaunch === true)
    const task = (this.backgroundTasks
      ? this.backgroundTasks.start({
        taskId: input.backgroundTaskId,
        label: input.label,
        kind: 'agent_run',
        workspaceId: this.store.getRun(input.runId).workspaceId,
        userId: this.store.getRun(input.runId).createdByUserId,
        metadata: input.metadata,
        run: signal => input.run(signal),
      })
      : input.run())
      .then(async run => {
        await this.sendSnapshotIfConnected(input.runId, input.target)
        return run
      })
      .catch(async error => {
        logger.error({ error: errorLogPayload(error), runId: input.runId }, 'background run task failed')
        await this.sendSnapshotIfConnected(input.runId, input.target)
        return this.store.getRun(input.runId)
      })
      .finally(() => {
        this.activeTasks.delete(input.runId)
        this.activeBackgroundTaskIds.delete(input.runId)
      })
    this.activeTasks.set(input.runId, task)
    this.activeBackgroundTaskIds.set(input.runId, input.backgroundTaskId)
    return task
  }

  startDetached(options: RunOptions, target: RunTaskCompletionTarget = {}): void {
    this.start(options, target).catch(error => {
      // start() already owns run failure persistence and snapshot emission.
      // This catch only protects the Node event loop from an unhandled rejection
      // if the task creation path itself fails synchronously.
      logger.error({ error: errorLogPayload(error), runId: options.runId }, 'background run task launch failed')
    })
  }

  /**
   * Idempotent admission for durable continuation workflows. The check and task
   * registration execute synchronously in the same event-loop turn, so two
   * retries cannot both acquire one run identity. Returning false means the
   * exact run is already active; it never redirects to another run.
   */
  startDetachedIfIdle(options: RunOptions, target: RunTaskCompletionTarget = {}): boolean {
    if (this.activeTasks.has(options.runId) || this.launchingRunIds.has(options.runId)) return false
    this.startDetached(options, target)
    return true
  }

  cancel(runId: string): Promise<AnalysisRun> {
    const backgroundTaskId = this.activeBackgroundTaskIds.get(runId) ?? runId
    if (this.backgroundTasks?.get(backgroundTaskId)?.status === 'running') this.backgroundTasks.cancel(backgroundTaskId)
    return this.runtime.cancel(runId)
  }

  steer(runId: string, steeringId: string, content: string) {
    if (!this.activeTasks.has(runId)) throw new Error(`运行 '${runId}' 当前没有活动任务`)
    return this.runtime.steer(runId, steeringId, content)
  }

  activeRunIds(): string[] {
    return [...new Set([...this.activeTasks.keys(), ...this.launchingRunIds])]
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.activeTasks.values())
  }

  private async sendSnapshotIfConnected(runId: string, target: RunTaskCompletionTarget): Promise<void> {
    if (!target.onComplete) return
    try {
      await target.onComplete(runId)
    } catch (error) {
      logger.warn({ error: errorLogPayload(error), runId }, 'background run completion callback failed')
    }
  }

  private assertAvailable(runId: string, claimedLaunch = false): void {
    if (this.activeTasks.has(runId) || (!claimedLaunch && this.launchingRunIds.has(runId))) {
      throw new Error(`运行 '${runId}' 已在后台执行中`)
    }
  }
}
