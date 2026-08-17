// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent checkpoint 恢复策略测试
//
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { AnalysisRun, RunCheckpoint } from '../schemas/types.js'
import { assertRunCheckpointResumable } from './runResumePolicy.js'

describe('assertRunCheckpointResumable', () => {
  it('accepts only an interrupted run with a complete clean recovery checkpoint', () => {
    expect(() => assertRunCheckpointResumable(
      run('interrupted'),
      checkpoint(),
    )).not.toThrow()
  })

  it.each([
    'completed',
    'cancelled',
    'failed',
    'clarification_needed',
    'waiting_approval',
    'requires_action',
    'queued',
    'running',
  ] as const)('rejects the non-recoverable %s lifecycle state', status => {
    expect(() => assertRunCheckpointResumable(run(status), checkpoint()))
      .toThrow('不能通过 run:resume')
  })

  it('rejects interrupted runs that still belong to a decision flow', () => {
    const decisionBound = run('interrupted')
    decisionBound.state.decisions = [{
      decisionId: 'decision_1',
      kind: 'clarification',
      title: '需要澄清',
      question: '选择区域',
      description: '',
      options: [],
      allowFreeText: true,
      status: 'pending',
      payload: {},
      createdAt: '2026-08-17T00:00:00.000Z',
      resolvedAt: null,
    }]

    expect(() => assertRunCheckpointResumable(decisionBound, checkpoint()))
      .toThrow('仍有待处理决策')
  })

  it('rejects unsafe, incomplete, and non-interrupted checkpoints', () => {
    expect(() => assertRunCheckpointResumable(
      run('interrupted'),
      checkpoint({ recoveryStatus: 'requires_action' }),
    )).toThrow('不是可恢复的中断状态')

    expect(() => assertRunCheckpointResumable(
      run('interrupted'),
      checkpoint({ pendingToolCallIds: ['call_unknown'] }),
    )).toThrow('状态未知的工具调用')

    expect(() => assertRunCheckpointResumable(
      run('interrupted'),
      checkpoint({ sdkStateContentHash: null }),
    )).toThrow('缺少完整的 Agents SDK checkpoint')

    expect(() => assertRunCheckpointResumable(
      run('interrupted'),
      checkpoint({ activeEntryId: null }),
    )).toThrow('缺少完整的 Agents SDK checkpoint')
  })
})

function run(status: AnalysisRun['status']): AnalysisRun {
  return {
    id: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'private',
    userQuery: '继续执行',
    modelProvider: 'fake',
    modelName: 'fake-model',
    status,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    conversationPath: null,
    runtimeConfigSnapshot: null,
    state: {
      decisions: [],
      approvals: [],
    } as AnalysisRun['state'],
  }
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    schemaVersion: 2,
    run: run('interrupted'),
    activeEntryId: 'entry_1',
    pendingToolCallIds: [],
    lastPersistedAt: '2026-08-17T00:00:00.000Z',
    recoveryStatus: 'interrupted',
    orchestrationEngine: 'openai_agents',
    sdkStateContentHash: 'a'.repeat(64),
    agentsSdkVersion: '0.0.0-test',
    runtimeConfigDigest: 'b'.repeat(64),
    sdkStateSchemaVersion: 5,
    sdkStateUpdatedAt: '2026-08-17T00:00:00.000Z',
    nextInputSequence: 1,
    checkpointInputCursor: 0,
    activeInputLeaseId: null,
    activeInputLeaseFrom: null,
    activeInputLeaseTo: null,
    ...overrides,
  }
}
