// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行策略测试
//
//   文件:       toolExecutionPolicy.test.ts
//
//   日期:       2026年08月04日
// --------------------------------------------------------------------------

import type { AgentState, SubAgentState } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import type { ToolDef } from '../framework/types.js'
import type { ToolRegistry } from '../framework/registry.js'
import { ToolExecutionPolicy } from './toolExecutionPolicy.js'

describe('ToolExecutionPolicy', () => {
  it('keeps plan mode narrow while leaving normal execution flexible', () => {
    const readOnly = tool('inspect_dataset', { isReadOnly: true, isDestructive: false })
    const write = tool('update_layer', { isReadOnly: false, isDestructive: true })
    const state: AgentState = fakeState({ planMode: true })
    const policy = createPolicy({
      state: () => state,
      tools: { [readOnly.name]: readOnly, [write.name]: write },
    })

    expect(policy.isToolEnabled('inspect_dataset')).toBe(true)
    expect(policy.isToolEnabled('update_layer')).toBe(false)
    expect(() => policy.assertPlanModeAllows('update_layer')).toThrow('计划模式只允许')

    state.planMode = false
    expect(policy.isToolEnabled('update_layer')).toBe(true)
    expect(policy.isSdkExtensionEnabled()).toBe(true)
  })

  it('requires an active external-agent call before exposing platform tools', () => {
    const readOnly = tool('inspect_dataset', { isReadOnly: true, isDestructive: false })
    const externalAgentCalls = new Map<string, string>()
    const policy = createPolicy({
      state: () => fakeState({ planMode: false }),
      tools: { [readOnly.name]: readOnly },
      externalAgentCalls,
    })

    expect(policy.isToolEnabledForSubAgent('spatial_analyst', 'inspect_dataset')).toBe(false)
    externalAgentCalls.set('call_1', 'spatial_analyst')
    expect(policy.isToolEnabledForSubAgent('spatial_analyst', 'inspect_dataset')).toBe(true)
    expect(policy.isToolEnabledForSubAgent('other_agent', 'inspect_dataset')).toBe(false)
  })

  it('revokes handoff tool admission as soon as cancellation is accepted', () => {
    const readOnly = tool('inspect_dataset', { isReadOnly: true, isDestructive: false })
    const owner = {
      agentId: 'weather_handoff',
      status: 'pending',
      activeCallId: null,
    } as SubAgentState
    const state = fakeState({ subAgents: [owner] })
    const policy = createPolicy({
      state: () => state,
      tools: { [readOnly.name]: readOnly },
    })

    policy.activateHandoff(owner.agentId)
    owner.status = 'running'
    owner.activeCallId = 'handoff:weather_handoff'
    expect(policy.isToolEnabledForHandoff(owner.agentId, readOnly.name)).toBe(true)
    expect(() => policy.assertHandoffToolExecutionAllowed(owner.agentId, readOnly.name)).not.toThrow()

    owner.status = 'cancelling'
    expect(policy.isToolEnabledForHandoff(owner.agentId, readOnly.name)).toBe(false)
    expect(() => policy.assertHandoffToolExecutionAllowed(owner.agentId, readOnly.name))
      .toThrow('subagent_cancelled')
    expect(() => policy.assertPlanModeAllows(readOnly.name)).toThrow('subagent_cancelled')
  })
})

function createPolicy(input: {
  state: () => AgentState
  tools: Record<string, ToolDef>
  externalAgentCalls?: Map<string, string>
}): ToolExecutionPolicy {
  const registry = {
    get: (name: string) => input.tools[name],
  } as unknown as ToolRegistry
  return new ToolExecutionPolicy({
    registry,
    state: input.state,
    claimedWorkflowSteps: () => new Set(),
    externalAgentCalls: () => input.externalAgentCalls ?? new Map(),
  })
}

function tool(name: string, flags: Pick<ToolDef, 'isReadOnly' | 'isDestructive'>): ToolDef {
  return {
    name,
    label: name,
    description: name,
    prompt: name,
    group: 'test',
    tags: [],
    ...flags,
    handler: async () => ({
      message: 'ok',
      payload: {},
      warnings: [],
      resultId: 'result_1',
      source: 'test',
    }),
  }
}

function fakeState(overrides: Partial<Pick<AgentState, 'planMode' | 'agentWorkflow' | 'subAgents'>>): AgentState {
  return {
    planMode: false,
    agentWorkflow: null,
    subAgents: [],
    ...overrides,
  } as AgentState
}
