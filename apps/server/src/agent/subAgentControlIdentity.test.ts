// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制调用身份测试
//
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { subAgentStateSchema } from '../schemas/types.js'
import { SubAgentControlPlane } from './subAgentControlPlane.js'

describe('SubAgentControlPlane invocation identity', () => {
  it('rejects the same controlId on a later invocation even when the payload is identical', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-subagent-control-identity-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({
        workspaceId: 'workspace_goal',
        userId: 'user_goal',
      })
      const thread = await store.createThread(session.id, '子智能体控制身份')
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
          activeCallId: 'call_A',
        })],
      })

      const controls = new SubAgentControlPlane(store)
      const request = {
        runId: run.id,
        agentId: 'spatial_analyst',
        controlId: 'follow_same_id',
        content: '请补充 CRS 证据。',
        createdByUserId: 'user_goal',
      }
      controls.begin({
        runId: run.id,
        agentId: 'spatial_analyst',
        callId: 'call_A',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })
      await controls.followUp(request)
      await controls.consumeInstructions(run.id, 'spatial_analyst')
      controls.finish(run.id, 'spatial_analyst', 'call_A')

      controls.begin({
        runId: run.id,
        agentId: 'spatial_analyst',
        callId: 'call_B',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      await expect(controls.followUp(request)).rejects.toThrow(
        "已绑定到调用 'call_A'，不能用于当前调用 'call_B'",
      )
      const controlEvents = (await store.listEvents(run.id)).filter(event => (
        event.payload.controlId === request.controlId
      ))
      expect(controlEvents).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
