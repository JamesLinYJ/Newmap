// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制面测试
//
//   文件:       subAgentControlPlane.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { subAgentStateSchema } from '../schemas/types.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { SubAgentControlPlane } from './subAgentControlPlane.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('SubAgentControlPlane', () => {
  it('queues and delivers follow-ups, then aborts only the selected Agent-as-tool invocation', async () => {
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store)
      const signal = controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_agent_1',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      const queued = await controls.followUp({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'follow_up_1',
        content: '请补充 CRS 证据。',
        createdByUserId: 'user_goal',
      })
      expect(queued.controls).toContainEqual(expect.objectContaining({
        controlId: 'follow_up_1',
        kind: 'follow_up',
        status: 'queued',
      }))

      const instructions = await controls.consumeInstructions(fixture.runId, 'spatial_analyst')
      expect(instructions).toEqual(['用户追加追问：请补充 CRS 证据。'])
      expect(fixture.store.getRun(fixture.runId).state.subAgents[0].controls[0].status).toBe('delivered')

      const cancelling = await controls.cancel({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'cancel_1',
        content: '改由主智能体处理。',
        createdByUserId: 'user_goal',
      })
      expect(cancelling.status).toBe('cancelling')
      expect(signal?.aborted).toBe(true)
      expect(fixture.store.getRun(fixture.runId).status).toBe('running')
      expect(await fixture.store.listEvents(fixture.runId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'subagent.updated',
          payload: expect.objectContaining({
            callId: 'call_agent_1',
            controlId: 'cancel_1',
            isolated: true,
          }),
        }),
      ]))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('treats controlId as an idempotency key and rejects conflicting retries', async () => {
    const fixture = await createFixture()
    try {
      const appendAgentTranscript = vi.fn(
        fixture.store.appendAgentTranscript.bind(fixture.store),
      )
      const controls = new SubAgentControlPlane({
        appendAgentTranscript,
        appendEvent: fixture.store.appendEvent.bind(fixture.store),
        getRun: fixture.store.getRun.bind(fixture.store),
        listEvents: fixture.store.listEvents.bind(fixture.store),
        mutateRunState: fixture.store.mutateRunState.bind(fixture.store),
      })
      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_idempotent',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })
      const request = {
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'follow_idempotent',
        content: '补充一个证据。',
        createdByUserId: 'user_goal',
      }

      const first = await controls.followUp(request)
      const retry = await controls.followUp({ ...request, content: '  补充一个证据。  ' })

      expect(first.controls.filter(control => control.controlId === request.controlId)).toHaveLength(1)
      expect(retry.controls.filter(control => control.controlId === request.controlId)).toHaveLength(1)
      expect(appendAgentTranscript).toHaveBeenCalledTimes(1)
      const controlEvents = (await fixture.store.listEvents(fixture.runId)).filter(event => (
        event.payload.controlId === request.controlId
      ))
      expect(controlEvents).toHaveLength(1)
      expect(controlEvents[0]?.payload.callId).toBe('call_idempotent')

      expect(() => controls.followUp({
        ...request,
        content: '冲突的新内容。',
      })).toThrow('已用于不同')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('does not re-abort or rewrite the reason for an identical cancel retry', async () => {
    const fixture = await createFixture()
    try {
      const appendAgentTranscript = vi.fn(
        fixture.store.appendAgentTranscript.bind(fixture.store),
      )
      const controls = new SubAgentControlPlane({
        appendAgentTranscript,
        appendEvent: fixture.store.appendEvent.bind(fixture.store),
        getRun: fixture.store.getRun.bind(fixture.store),
        listEvents: fixture.store.listEvents.bind(fixture.store),
        mutateRunState: fixture.store.mutateRunState.bind(fixture.store),
      })
      const signal = controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_cancel_idempotent',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })
      const request = {
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'cancel_idempotent',
        content: '停止当前检查。',
        createdByUserId: 'user_goal',
      }

      await controls.cancel(request)
      const abortReason = signal?.reason
      await controls.cancel(request)

      expect(signal?.aborted).toBe(true)
      expect(signal?.reason).toBe(abortReason)
      expect(appendAgentTranscript).toHaveBeenCalledTimes(1)
      expect(() => controls.cancel({ ...request, content: '另一个取消原因。' }))
        .toThrow('已用于不同')
      expect(controls.claimTerminalOutcome(
        fixture.runId,
        'spatial_analyst',
        'call_cancel_idempotent',
      )).toEqual({ status: 'cancelled', reason: '停止当前检查。' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('isolates queued controls between sequential invocations of one agent identity', async () => {
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store)
      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_A',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })
      await controls.followUp({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'follow_A',
        content: '只属于 A 的追问。',
        createdByUserId: 'user_goal',
      })
      controls.finish(fixture.runId, 'spatial_analyst', 'call_A')

      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_B',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })
      await controls.followUp({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'follow_B',
        content: '只属于 B 的追问。',
        createdByUserId: 'user_goal',
      })

      await expect(controls.consumeInstructions(fixture.runId, 'spatial_analyst'))
        .resolves.toEqual(['用户追加追问：只属于 B 的追问。'])
      const state = fixture.store.getRun(fixture.runId).state.subAgents[0]
      expect(state.controls.find(control => control.controlId === 'follow_A')?.status).toBe('rejected')
      expect(state.controls.find(control => control.controlId === 'follow_B')?.status).toBe('delivered')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('projects stalled state after an active child stops producing SDK activity', async () => {
    vi.useFakeTimers()
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store, 20, 20)
      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_agent_stalled',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      await vi.advanceTimersByTimeAsync(25)

      expect(fixture.store.getRun(fixture.runId).state.subAgents[0]).toMatchObject({
        status: 'running',
        stalled: true,
        stalledSince: expect.any(String),
      })
      expect(await fixture.store.listEvents(fixture.runId)).toContainEqual(expect.objectContaining({
        message: '空间分析智能体 可能卡顿',
      }))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('arbitrates cancellation and completion to one callId terminal outcome', async () => {
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store)
      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_terminal_race',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      await controls.cancel({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'cancel_terminal_race',
        content: '停止当前检查。',
        createdByUserId: 'user_goal',
      })

      expect(controls.claimTerminalOutcome(
        fixture.runId,
        'spatial_analyst',
        'call_terminal_race',
      )).toEqual({ status: 'cancelled', reason: '停止当前检查。' })
      expect(() => controls.claimTerminalOutcome(
        fixture.runId,
        'spatial_analyst',
        'call_terminal_race',
      )).toThrow('已由其他终态处理')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-subagent-control-'))
  const store = createTestPersistenceFacade(root)
  await store.initialize()
  const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
  const thread = await store.createThread(session.id, '子智能体控制')
  const run = await store.createRun(session.id, '执行空间分析', {
    threadId: thread.id,
    modelProvider: 'fake',
  })
  await store.updateRunStatus(run.id, 'running')
  await store.updateRunState(run.id, {
    subAgents: [subAgentStateSchema.parse({
      agentId: 'spatial_analyst',
      name: '空间分析智能体',
      role: 'analyst',
      status: 'running',
      summary: '检查空间数据。',
      tools: ['query_layer'],
      stepIds: ['step_agent'],
      currentStepId: 'step_agent',
      activeCallId: 'call_agent_1',
    })],
  })
  return { root, store, runId: run.id }
}
