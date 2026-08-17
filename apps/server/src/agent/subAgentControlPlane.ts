// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制面
//
//   文件:       subAgentControlPlane.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 控制面只管理同一 Runner 内已经由 Agent.asTool()/handoff() 创建的子智能体。
// 它不会自行启动模型循环。追问通过动态 instructions 在子智能体下一次模型调用
// 前注入；Agent-as-tool 取消只中止对应嵌套调用，不触碰根 Run 的 AbortController。

import type { SubAgentState } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { StoreConflictError } from '../store/storeErrors.js'
import { makeId, nowUtc } from '../utils/ids.js'

type SubAgentControlStore = Pick<AgentRuntimeStore,
  | 'appendAgentTranscript'
  | 'appendEvent'
  | 'getRun'
  | 'listEvents'
  | 'mutateRunState'
>

type SubAgentControlKind = 'follow_up' | 'cancel'

interface ActiveSubAgentInvocation {
  runId: string
  agentId: string
  callId: string
  delegationMode: 'as_tool' | 'handoff'
  controller: AbortController | null
  stallAfterMs: number
  stallTimer: ReturnType<typeof setTimeout> | null
  lastPersistedActivityAt: number
  cancellationReason: string | null
  terminalClaimed: boolean
}

interface ControlBinding {
  callId: string
  kind: SubAgentControlKind
  createdByUserId: string
}

interface PendingControlOperation {
  callId: string
  fingerprint: string
  promise: Promise<SubAgentState>
}

export interface BeginSubAgentInvocationInput {
  runId: string
  agentId: string
  callId: string
  delegationMode: 'as_tool' | 'handoff'
  timeoutMs: number
}

export interface SubAgentControlInput {
  runId: string
  agentId: string
  controlId: string
  content: string
  createdByUserId: string
}

export class SubAgentControlPlane {
  private readonly active = new Map<string, ActiveSubAgentInvocation>()
  private readonly pendingControls = new Map<string, PendingControlOperation>()

  constructor(
    private readonly store: SubAgentControlStore,
    private readonly minimumStallMs = 5_000,
    private readonly maximumStallMs = 30_000,
  ) {}

  begin(input: BeginSubAgentInvocationInput): AbortSignal | null {
    const key = activeKey(input.runId, input.agentId)
    if (this.active.has(key)) {
      throw new Error(`子 Agent '${input.agentId}' 已有活动调用，不能并发复用同一身份。`)
    }
    const controller = input.delegationMode === 'as_tool' ? new AbortController() : null
    const stallAfterMs = Math.min(
      this.maximumStallMs,
      Math.max(this.minimumStallMs, Math.floor(input.timeoutMs / 3)),
    )
    const invocation: ActiveSubAgentInvocation = {
      ...input,
      controller,
      stallAfterMs,
      stallTimer: null,
      lastPersistedActivityAt: 0,
      cancellationReason: null,
      terminalClaimed: false,
    }
    this.active.set(key, invocation)
    this.scheduleStallCheck(invocation)
    return controller?.signal ?? null
  }

  finish(runId: string, agentId: string, callId: string): void {
    const key = activeKey(runId, agentId)
    const invocation = this.active.get(key)
    if (!invocation || invocation.callId !== callId) return
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    this.active.delete(key)
    void this.rejectQueuedControls(runId, agentId, callId).catch(error => {
      logger.warn({
        error: errorLogPayload(error),
        runId,
        agentId,
        callId,
      }, 'subagent queued control expiration failed')
    })
  }

  claimTerminalOutcome(
    runId: string,
    agentId: string,
    callId: string,
  ): { status: 'completed' } | { status: 'cancelled'; reason: string } {
    const invocation = this.active.get(activeKey(runId, agentId))
    if (!invocation || invocation.callId !== callId) {
      throw new Error(`子 Agent '${agentId}' 的活动调用 '${callId}' 不存在。`)
    }
    if (invocation.terminalClaimed) {
      throw new Error(`子 Agent '${agentId}' 的调用 '${callId}' 已由其他终态处理。`)
    }
    invocation.terminalClaimed = true
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    return invocation.cancellationReason
      ? { status: 'cancelled', reason: invocation.cancellationReason }
      : { status: 'completed' }
  }

  finishRun(runId: string): void {
    const prefix = `${runId}\u0000`
    const finished: ActiveSubAgentInvocation[] = []
    for (const [key, invocation] of this.active) {
      if (!key.startsWith(prefix)) continue
      if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
      this.active.delete(key)
      finished.push(invocation)
    }
    void Promise.all(finished.map(invocation => this.rejectQueuedControls(
      invocation.runId,
      invocation.agentId,
      invocation.callId,
    ))).catch(error => {
      logger.warn({ error: errorLogPayload(error), runId }, 'subagent run control expiration failed')
    })
  }

  isCancellationRequested(runId: string, agentId: string, callId: string): boolean {
    const invocation = this.active.get(activeKey(runId, agentId))
    return invocation?.callId === callId && invocation.cancellationReason !== null
  }

  cancellationReason(runId: string, agentId: string, callId: string): string {
    const invocation = this.active.get(activeKey(runId, agentId))
    return invocation?.callId === callId && invocation.cancellationReason
      ? invocation.cancellationReason
      : '用户取消了子智能体任务。'
  }

  followUp(input: SubAgentControlInput): Promise<SubAgentState> {
    const content = input.content.trim()
    if (!content) throw new Error('子智能体追问内容不能为空。')
    return this.submitControl(input, 'follow_up', content)
  }

  cancel(input: SubAgentControlInput): Promise<SubAgentState> {
    const reason = input.content.trim() || '用户取消了子智能体任务。'
    return this.submitControl(input, 'cancel', reason)
  }

  async consumeInstructions(runId: string, agentId: string): Promise<string[]> {
    const invocation = this.requireActive(runId, agentId)
    const bindings = await this.controlBindings(runId, agentId)
    const deliveredAt = nowUtc()
    const messages: string[] = []
    const rejectedControlIds: string[] = []
    await this.store.mutateRunState(runId, state => ({
      subAgents: state.subAgents.map(agent => {
        if (agent.agentId !== agentId) return agent
        const queued = agent.controls.filter(control => control.status === 'queued')
        if (!queued.length) return agent
        const deliverableIds = new Set(queued.flatMap(control => {
          const binding = bindings.get(control.controlId)
          if (binding?.callId === invocation.callId) return [control.controlId]
          rejectedControlIds.push(control.controlId)
          return []
        }))
        const delivered = queued.filter(control => deliverableIds.has(control.controlId))
        for (const control of delivered) {
          messages.push(control.kind === 'cancel'
            ? `平台控制：用户请求取消当前子智能体任务。原因：${control.content}。请停止继续调用工具，并立即如实结束当前交付。`
            : `用户追加追问：${control.content}`)
        }
        return {
          ...agent,
          controls: agent.controls.map(control => {
            if (deliverableIds.has(control.controlId)) {
              return { ...control, status: 'delivered' as const, deliveredAt }
            }
            if (control.status === 'queued' && rejectedControlIds.includes(control.controlId)) {
              return { ...control, status: 'rejected' as const }
            }
            return control
          }),
          lastActivityAt: delivered.length ? deliveredAt : agent.lastActivityAt,
          latestMessage: delivered.some(control => control.kind === 'cancel')
            ? '取消请求已送达子智能体'
            : delivered.length
              ? '用户追问已送达子智能体'
              : rejectedControlIds.length
                ? '已拒绝不属于当前调用的历史控制消息'
                : agent.latestMessage,
        }
      }),
    }))
    if (rejectedControlIds.length) {
      await this.appendControlEvent(runId, `已隔离 ${rejectedControlIds.length} 条历史子智能体控制消息`, {
        agentId,
        callId: invocation.callId,
        rejectedControlIds,
        reason: 'invocation_mismatch',
      })
    }
    return messages
  }

  async touch(runId: string, agentId: string, currentStep: string): Promise<void> {
    const invocation = this.active.get(activeKey(runId, agentId))
    if (!invocation) return
    this.scheduleStallCheck(invocation)
    const now = Date.now()
    if (now - invocation.lastPersistedActivityAt < 500) return
    invocation.lastPersistedActivityAt = now
    const timestamp = new Date(now).toISOString()
    await this.store.mutateRunState(runId, state => ({
      subAgents: state.subAgents.map(agent => agent.agentId === agentId
        ? {
            ...agent,
            currentStep,
            activityCount: agent.activityCount + 1,
            progressPercent: agent.status === 'running'
              ? Math.min(90, Math.max(10, (agent.progressPercent ?? 0) + 5))
              : agent.progressPercent,
            lastActivityAt: timestamp,
            stalled: false,
            stalledSince: null,
          }
        : agent),
    }))
  }

  private submitControl(
    input: SubAgentControlInput,
    kind: SubAgentControlKind,
    content: string,
  ): Promise<SubAgentState> {
    const currentAgent = requireSubAgent(
      this.store.getRun(input.runId).state.subAgents,
      input.agentId,
    )
    const key = controlKey(input.runId, input.agentId, input.controlId)
    const activeInvocation = this.active.get(activeKey(input.runId, input.agentId))
    const pending = this.pendingControls.get(key)
    if (pending) {
      const fingerprint = controlFingerprint(
        input,
        activeInvocation?.callId ?? pending.callId,
        kind,
        content,
      )
      if (pending.fingerprint !== fingerprint) {
        throw new StoreConflictError(`controlId '${input.controlId}' 已用于不同的子智能体控制请求。`)
      }
      return pending.promise
    }

    const persisted = currentAgent.controls.find(control => control.controlId === input.controlId)
    if (persisted) {
      const matched = assertMatchingControl(currentAgent, persisted, input, kind, content)
      return this.resolvePersistedControl(input, matched, persisted, activeInvocation)
    }

    const invocation = activeInvocation ?? this.requireActive(input.runId, input.agentId)
    if (invocation.terminalClaimed) {
      throw new Error(`子 Agent '${input.agentId}' 已进入终态处理，不能再接收控制消息。`)
    }
    if (invocation.cancellationReason !== null) {
      throw new StoreConflictError(`子 Agent '${input.agentId}' 已收到取消请求，不能再接收新的控制消息。`)
    }

    const fingerprint = controlFingerprint(input, invocation.callId, kind, content)
    let resolveOperation!: (state: SubAgentState) => void
    let rejectOperation!: (error: unknown) => void
    const promise = new Promise<SubAgentState>((resolve, reject) => {
      resolveOperation = resolve
      rejectOperation = reject
    })
    this.pendingControls.set(key, { callId: invocation.callId, fingerprint, promise })

    if (kind === 'cancel') {
      invocation.cancellationReason = content
      if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
      invocation.controller?.abort(new SubAgentCancelledError(content))
    }

    void this.persistControl(input, invocation, kind, content)
      .then(resolveOperation, rejectOperation)
      .finally(() => {
        if (this.pendingControls.get(key)?.promise === promise) this.pendingControls.delete(key)
      })
    return promise
  }

  private async resolvePersistedControl(
    input: SubAgentControlInput,
    agent: SubAgentState,
    control: SubAgentState['controls'][number],
    activeInvocation: ActiveSubAgentInvocation | undefined,
  ): Promise<SubAgentState> {
    const binding = (await this.controlBindings(input.runId, input.agentId)).get(input.controlId)
    if (!binding) {
      throw new StoreConflictError(`controlId '${input.controlId}' 缺少持久化调用绑定，不能作为安全重试处理。`)
    }
    if (binding.kind !== control.kind || binding.createdByUserId !== control.createdByUserId) {
      throw new StoreConflictError(`controlId '${input.controlId}' 的状态与事件绑定不一致。`)
    }
    if (activeInvocation && binding.callId !== activeInvocation.callId) {
      throw new StoreConflictError(`controlId '${input.controlId}' 已绑定到调用 '${binding.callId}'，不能用于当前调用 '${activeInvocation.callId}'。`)
    }
    return agent
  }

  private async persistControl(
    input: SubAgentControlInput,
    invocation: ActiveSubAgentInvocation,
    kind: SubAgentControlKind,
    content: string,
  ): Promise<SubAgentState> {
    const createdAt = nowUtc()
    let created = false
    const run = await this.store.mutateRunState(input.runId, state => ({
      subAgents: state.subAgents.map(agent => {
        if (agent.agentId !== input.agentId) return agent
        const existing = agent.controls.find(control => control.controlId === input.controlId)
        if (existing) return assertMatchingControl(agent, existing, input, kind, content)
        const current = this.active.get(activeKey(input.runId, input.agentId))
        if (current !== invocation || current.callId !== invocation.callId) {
          throw new StoreConflictError(`子 Agent '${input.agentId}' 的目标调用已经结束。`)
        }
        if (agent.status !== 'running') {
          throw new Error(`子 Agent '${input.agentId}' 当前不可${kind === 'cancel' ? '取消' : '追问'}。`)
        }
        created = true
        return {
          ...agent,
          ...(kind === 'cancel' ? { status: 'cancelling' as const } : {}),
          controls: [...agent.controls, {
            controlId: input.controlId,
            kind,
            content,
            status: kind === 'cancel' && invocation.controller ? 'delivered' as const : 'queued' as const,
            createdByUserId: input.createdByUserId,
            createdAt,
            deliveredAt: kind === 'cancel' && invocation.controller ? createdAt : null,
          }],
          latestMessage: kind === 'cancel' ? '正在取消当前子智能体调用' : '已收到用户追问，等待下一次模型调用处理',
          lastActivityAt: createdAt,
          stalled: false,
          stalledSince: null,
        }
      }),
    }))
    const agent = requireSubAgent(run.state.subAgents, input.agentId)
    if (!created) return agent

    await this.store.appendAgentTranscript(input.runId, input.agentId, {
      type: 'control',
      callId: invocation.callId,
      controlId: input.controlId,
      kind,
      content,
      createdByUserId: input.createdByUserId,
    })
    await this.appendControlEvent(input.runId, kind === 'cancel' ? `${agent.name} 收到取消请求` : `${agent.name} 收到用户追问`, {
      agentId: input.agentId,
      callId: invocation.callId,
      controlId: input.controlId,
      controlKind: kind,
      controlContent: content,
      createdByUserId: input.createdByUserId,
      isolated: invocation.delegationMode === 'as_tool',
    })
    return agent
  }

  private async controlBindings(runId: string, agentId: string): Promise<Map<string, ControlBinding>> {
    const bindings = new Map<string, ControlBinding>()
    for (const event of await this.store.listEvents(runId)) {
      if (event.type !== 'subagent.updated') continue
      const payload = event.payload
      if (payload.agentId !== agentId || typeof payload.controlId !== 'string' || typeof payload.callId !== 'string'
        || (payload.controlKind !== 'follow_up' && payload.controlKind !== 'cancel') || typeof payload.createdByUserId !== 'string') continue
      const binding: ControlBinding = { callId: payload.callId, kind: payload.controlKind, createdByUserId: payload.createdByUserId }
      const existing = bindings.get(payload.controlId)
      if (existing && (existing.callId !== binding.callId || existing.kind !== binding.kind || existing.createdByUserId !== binding.createdByUserId)) {
        throw new StoreConflictError(`controlId '${payload.controlId}' 存在冲突的持久化调用绑定。`)
      }
      bindings.set(payload.controlId, binding)
    }
    return bindings
  }

  private async rejectQueuedControls(runId: string, agentId: string, callId: string): Promise<void> {
    const bindings = await this.controlBindings(runId, agentId)
    const rejectedControlIds: string[] = []
    await this.store.mutateRunState(runId, state => ({
      subAgents: state.subAgents.map(agent => agent.agentId !== agentId ? agent : {
        ...agent,
        controls: agent.controls.map(control => {
          if (control.status !== 'queued' || bindings.get(control.controlId)?.callId !== callId) return control
          rejectedControlIds.push(control.controlId)
          return { ...control, status: 'rejected' as const }
        }),
      }),
    }))
    if (!rejectedControlIds.length) return
    await this.appendControlEvent(runId, `子智能体调用结束，${rejectedControlIds.length} 条未送达控制消息已失效`, {
      agentId,
      callId,
      rejectedControlIds,
      reason: 'invocation_finished_before_delivery',
    })
  }

  private requireActive(runId: string, agentId: string): ActiveSubAgentInvocation {
    const invocation = this.active.get(activeKey(runId, agentId))
    if (!invocation) throw new Error(`子 Agent '${agentId}' 当前没有活动调用。`)
    return invocation
  }

  private scheduleStallCheck(invocation: ActiveSubAgentInvocation): void {
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    invocation.stallTimer = setTimeout(() => {
      void this.markStalled(invocation).catch(error => logger.warn({ error: errorLogPayload(error), runId: invocation.runId, agentId: invocation.agentId }, 'subagent stalled state update failed'))
    }, invocation.stallAfterMs)
    invocation.stallTimer.unref?.()
  }

  private async markStalled(invocation: ActiveSubAgentInvocation): Promise<void> {
    const current = this.active.get(activeKey(invocation.runId, invocation.agentId))
    if (current !== invocation || current.cancellationReason) return
    const stalledSince = nowUtc()
    const run = await this.store.mutateRunState(invocation.runId, state => ({
      subAgents: state.subAgents.map(agent => agent.agentId === invocation.agentId && agent.status === 'running' ? {
        ...agent,
        stalled: true,
        stalledSince,
        latestMessage: `超过 ${invocation.stallAfterMs}ms 未观察到新活动`,
      } : agent),
    }))
    const agent = requireSubAgent(run.state.subAgents, invocation.agentId)
    if (!agent.stalled) return
    await this.appendControlEvent(invocation.runId, `${agent.name} 可能卡顿`, {
      agentId: invocation.agentId,
      callId: invocation.callId,
      stalledSince,
      stallAfterMs: invocation.stallAfterMs,
    })
  }

  private async appendControlEvent(runId: string, message: string, payload: Record<string, unknown>): Promise<void> {
    const run = this.store.getRun(runId)
    await this.store.appendEvent(runId, {
      eventId: makeId('evt'),
      runId,
      threadId: run.threadId,
      type: 'subagent.updated',
      message,
      timestamp: nowUtc(),
      payload,
    })
  }
}

export class SubAgentCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubAgentCancelledError'
  }
}

function activeKey(runId: string, agentId: string): string {
  return `${runId}\u0000${agentId}`
}

function controlKey(runId: string, agentId: string, controlId: string): string {
  return `${runId}\u0000${agentId}\u0000${controlId}`
}

function controlFingerprint(input: SubAgentControlInput, callId: string, kind: SubAgentControlKind, content: string): string {
  return JSON.stringify({ callId, kind, content, createdByUserId: input.createdByUserId })
}

function assertMatchingControl(agent: SubAgentState, existing: SubAgentState['controls'][number], input: SubAgentControlInput, kind: SubAgentControlKind, content: string): SubAgentState {
  if (existing.kind !== kind || existing.content.trim() !== content || existing.createdByUserId !== input.createdByUserId) {
    throw new StoreConflictError(`controlId '${input.controlId}' 已用于不同的子智能体控制请求。`)
  }
  return agent
}

function requireSubAgent(subAgents: SubAgentState[], agentId: string): SubAgentState {
  const agent = subAgents.find(candidate => candidate.agentId === agentId)
  if (!agent) throw new Error(`子 Agent '${agentId}' 不存在。`)
  return agent
}
