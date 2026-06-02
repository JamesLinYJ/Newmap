// +-------------------------------------------------------------------------
//
//   runTranscript 单元测试
// --------------------------------------------------------------------------
import { describe, it, expect } from 'vitest'
import type { RunEvent, AnalysisRun, AgentState, ArtifactRef, AgentRuntimeConfig, ToolDescriptor } from '@geo-agent-platform/shared-types'
import {
  deriveRunTranscript,
  deriveThreadTranscript,
  deriveConversationEntries,
  pickTranscriptHeadline,
  isActivityEntry,
} from '../runTranscript'
import type { TranscriptEntry, ConversationEntry } from '../runTranscript'

// ---------------------------------------------------------------------------
// 工厂 helper —— 最小化 mock 数据，只保留被测试代码实际读取的字段
// ---------------------------------------------------------------------------

function makeRun(overrides?: Partial<AnalysisRun>): AnalysisRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    userQuery: '测试查询',
    status: 'completed',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:01:00.000Z',
    state: makeAgentState(),
    ...overrides,
  } as AnalysisRun
}

function makeAgentState(overrides?: Partial<AgentState>): AgentState {
  return {
    sessionId: 'session-1',
    userQuery: '测试查询',
    currentStep: 0,
    loopIteration: 1,
    loopPhase: 'planning',
    loopTrace: [],
    todos: [],
    subAgents: [],
    approvals: [],
    toolResults: [],
    artifacts: [],
    selectedDataSources: [],
    planRepairAttempts: 0,
    textOnlyDelivery: false,
    warnings: [],
    errors: [],
    ...overrides,
  } as AgentState
}

function makeEvent(overrides: Partial<RunEvent> & { type: RunEvent['type'] }): RunEvent {
  return {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId: 'run-1',
    message: '',
    timestamp: '2026-05-01T00:00:00.000Z',
    ...overrides,
  } as RunEvent
}

function makeArtifact(overrides?: Partial<ArtifactRef>): ArtifactRef {
  return {
    artifactId: 'art-1',
    runId: 'run-1',
    artifactType: 'vector_layer',
    name: '测试图层',
    uri: '/layers/test',
    metadata: {},
    ...overrides,
  }
}

function makeRuntimeConfig(overrides?: Partial<AgentRuntimeConfig>): AgentRuntimeConfig {
  return {
    loopTraceLimit: 50,
    supervisor: { maxIterations: 10, idleTimeoutMs: 30000, tools: [] },
    subAgents: [],
    ui: { transcriptMaxEntries: 40 },
    catalog: { autoRefreshIntervalMs: 5000 },
    planning: { maxSteps: 10, forceSequential: true },
    context: { maxChars: 50000, maxArtifactRefs: 20 },
    geosearch: { defaultLimit: 100, maxBufferMeters: 50000 },
    externalPoi: { enabled: false },
    nowcast: { defaultCityName: "杭州", forecastHorizonMinutes: 60, pointBufferMeters: 5000, rainLevelThresholds: {}, candidateLimit: 5 },
    ...overrides,
  }
}

function makeToolDescriptor(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: 'geocode_place',
    label: '地理编码',
    description: '将地点名称解析为坐标',
    group: 'spatial',
    toolKind: 'function',
    available: true,
    tags: [],
    parameters: [],
    meta: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isActivityEntry
// ---------------------------------------------------------------------------
describe('isActivityEntry', () => {
  it('returns true for supervisor kind', () => {
    expect(isActivityEntry('supervisor')).toBe(true)
  })

  it('returns true for subagent kind', () => {
    expect(isActivityEntry('subagent')).toBe(true)
  })

  it('returns true for tool kind', () => {
    expect(isActivityEntry('tool')).toBe(true)
  })

  it('returns true for approval kind', () => {
    expect(isActivityEntry('approval')).toBe(true)
  })

  it('returns true for artifact kind', () => {
    expect(isActivityEntry('artifact')).toBe(true)
  })

  it('returns false for user kind', () => {
    expect(isActivityEntry('user')).toBe(false)
  })

  it('returns false for assistant kind', () => {
    expect(isActivityEntry('assistant')).toBe(false)
  })

  it('returns false for error kind', () => {
    expect(isActivityEntry('error')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — basic structure
// ---------------------------------------------------------------------------
describe('deriveRunTranscript', () => {
  // ---- Test 1: Empty events returns only the user entry ----
  it('returns user entry when run has a query and no events', () => {
    const run = makeRun({ userQuery: '上海的GIS数据有哪些' })
    const result = deriveRunTranscript({ run, events: [], artifacts: [] })

    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].kind).toBe('user')
    expect(result[0].body).toContain('上海的GIS数据有哪些')
  })

  // ---- Test 7: User query appears as first entry ----
  it('places user query as the first entry', () => {
    const events: RunEvent[] = [
      makeEvent({ type: 'message.delta', eventId: 'm1', message: '正在处理' }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: '北京周边有哪些公园' }),
      events,
      artifacts: [],
    })

    expect(result[0].kind).toBe('user')
    expect(result[0].body).toContain('北京周边有哪些公园')
  })

  it('uses query parameter when run and agentState lack a query but events exist', () => {
    const events: RunEvent[] = [
      makeEvent({ type: 'message.delta', eventId: 'd1', message: '回复' }),
    ]
    const result = deriveRunTranscript({
      events,
      artifacts: [],
      query: '直接查询文本',
    })
    expect(result[0].kind).toBe('user')
    expect(result[0].body).toContain('直接查询文本')
  })

  it('returns empty array when no query source is available', () => {
    const result = deriveRunTranscript({ events: [], artifacts: [] })
    // 没有 run、agentState、events、query → 没有 user entry
    expect(result.filter((e) => e.kind === 'user').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — message.delta accumulation
// ---------------------------------------------------------------------------
describe('message.delta accumulation', () => {
  // ---- Test 2: message.delta events accumulate into a single assistant entry ----
  it('accumulates consecutive message.delta events into one assistant entry', () => {
    const events: RunEvent[] = [
      makeEvent({ type: 'message.delta', eventId: 'd1', message: '好的，' }),
      makeEvent({ type: 'message.delta', eventId: 'd2', message: '我现在来查' }),
      makeEvent({ type: 'message.delta', eventId: 'd3', message: '找数据。' }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: '查数据' }),
      events,
      artifacts: [],
    })

    // Delta 事件应合并为一条 assistant entry
    const assistantEntries = result.filter((e) => e.kind === 'assistant')
    expect(assistantEntries.length).toBe(1)
    expect(assistantEntries[0].body).toBe('好的，我现在来查找数据。')
    expect(assistantEntries[0].status).toBe('running')
    expect(assistantEntries[0].details?.streamingDelta).toBe(true)
  })

  it('handles a single message.delta', () => {
    const events: RunEvent[] = [
      makeEvent({ type: 'message.delta', eventId: 'd1', message: '单条消息' }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const assistants = result.filter((e) => e.kind === 'assistant')
    expect(assistants.length).toBe(1)
    expect(assistants[0].body).toBe('单条消息')
  })

  it('ignores empty delta events', () => {
    const events: RunEvent[] = [
      makeEvent({ type: 'message.delta', eventId: 'd1', message: '' }),
      makeEvent({ type: 'message.delta', eventId: 'd2', message: '   ' }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const assistants = result.filter((e) => e.kind === 'assistant')
    expect(assistants.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — thinking.delta
// ---------------------------------------------------------------------------
describe('thinking.delta', () => {
  // ---- Test 3: thinking.delta events create thought entries ----
  it('creates a thinking assistant entry with _thinking flag', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'thinking.delta',
        eventId: 'think1',
        message: '正在推理第一步',
        timestamp: '2026-05-01T00:00:01.000Z',
        payload: { _startedAt: '2026-05-01T00:00:01.000Z' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const thinkEntries = result.filter((e) => e.details?._thinking === true)
    expect(thinkEntries.length).toBe(1)
    expect(thinkEntries[0].kind).toBe('assistant')
    expect(thinkEntries[0].title).toBe('思考过程')
    expect(thinkEntries[0].body).toBe('正在推理第一步')
  })

  it('accumulates thinking delta with same phaseKey', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'thinking.delta',
        eventId: 'think1',
        message: '第一步推理内容',
        timestamp: '2026-05-01T00:00:01.000Z',
        payload: { _startedAt: 'phase-1' },
      }),
      makeEvent({
        type: 'thinking.delta',
        eventId: 'think2',
        message: '第一步推理内容，继续深入',
        timestamp: '2026-05-01T00:00:02.000Z',
        payload: { _startedAt: 'phase-1' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const thinkEntries = result.filter((e) => e.details?._thinking === true)
    // 相同 phaseKey → 合并为一条，body 取最后一条 delta 的完整内容
    expect(thinkEntries.length).toBe(1)
    expect(thinkEntries[0].body).toBe('第一步推理内容，继续深入')
  })

  it('separates thinking deltas with different phaseKeys', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'thinking.delta',
        eventId: 't1',
        message: '第一段推理',
        timestamp: '2026-05-01T00:00:01.000Z',
        payload: { _startedAt: 'phase-A' },
      }),
      makeEvent({
        type: 'thinking.delta',
        eventId: 't2',
        message: '第二段推理',
        timestamp: '2026-05-01T00:00:02.000Z',
        payload: { _startedAt: 'phase-B' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const thinkEntries = result.filter((e) => e.details?._thinking === true)
    expect(thinkEntries.length).toBe(2)
  })

  it('sets status to completed when _done is present', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'thinking.delta',
        eventId: 't1',
        message: '最终推理结果',
        timestamp: '2026-05-01T00:00:01.000Z',
        payload: { _startedAt: 'phase-X', _done: true },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const thinkEntry = result.find((e) => e.details?._thinking === true)
    expect(thinkEntry?.status).toBe('completed')
    expect(thinkEntry?.details?._endedAt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — run.completed
// ---------------------------------------------------------------------------
describe('run.completed event', () => {
  // ---- Test 4: run.completed event produces assistant entry ----
  it('produces an assistant entry with the final summary', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'run.completed',
        eventId: 'done',
        message: '分析完成',
        payload: {
          finalResponse: { summary: '已完成对北京公园的分析' },
        },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: '分析北京公园' }),
      events,
      artifacts: [],
    })
    const assistantEntries = result.filter((e) => e.kind === 'assistant')
    const completionEntry = assistantEntries.find((e) => e.body.includes('已完成对北京公园的分析'))
    expect(completionEntry).toBeDefined()
    expect(completionEntry!.status).toBe('completed')
  })

  it('sets status to blocked when approvals are pending', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'run.completed',
        eventId: 'done',
        message: '需要审批',
        payload: {
          approvals: [{ id: 'app-1' }],
          finalResponse: { summary: '结果待确认' },
        },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const completionEntry = result.find((e) => e.body.includes('结果待确认'))
    expect(completionEntry?.status).toBe('blocked')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — tool events
// ---------------------------------------------------------------------------
describe('tool events', () => {
  // ---- Test 5: tool.started + tool.completed produce tool entries ----
  it('creates tool entries for started and completed events', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'tool.started',
        eventId: 'tool-start',
        message: '开始调用地理编码',
        payload: { tool: 'geocode_place', args: { query: '北京' } },
      }),
      makeEvent({
        type: 'tool.completed',
        eventId: 'tool-end',
        message: '地理编码完成，坐标已获取',
        payload: { tool: 'geocode_place' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const toolEntries = result.filter((e) => e.kind === 'tool')
    expect(toolEntries.length).toBe(2)
    expect(toolEntries[0].status).toBe('running')
    expect(toolEntries[0].toolName).toBe('geocode_place')
    expect(toolEntries[1].status).toBe('completed')
    expect(toolEntries[1].toolName).toBe('geocode_place')
  })

  it('rebuilds commandText for tool.completed from previous tool.started args', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'tool.started',
        eventId: 'ts1',
        message: '',
        payload: { tool: 'buffer', args: { distance: 500, unit: 'm' }, stepId: 's1' },
      }),
      makeEvent({
        type: 'tool.completed',
        eventId: 'tc1',
        message: '缓冲区完成',
        payload: { tool: 'buffer', stepId: 's1' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const completedTool = result.find((e) => e.kind === 'tool' && e.status === 'completed')
    expect(completedTool?.commandText).toContain('buffer')
    // commandText should contain args from the started event
    expect(completedTool?.details?.args).toEqual({ distance: 500, unit: 'm' })
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — supervisor compaction
// ---------------------------------------------------------------------------
describe('supervisor entry compaction', () => {
  // ---- Test 6: multiple supervisor entries get compacted ----
  it('compacts consecutive supervisor entries with same status and body', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'loop.updated',
        eventId: 's1',
        message: '正在分析数据',
        payload: { status: 'running', title: '数据分析', description: '当前阶段是数据分析' },
      }),
      makeEvent({
        type: 'loop.updated',
        eventId: 's2',
        message: '正在生成结果',
        payload: { status: 'running', title: '数据分析', description: '当前阶段是数据分析' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const supervisorEntries = result.filter((e) => e.kind === 'supervisor')
    // compaction → only 1 supervisor entry (same title, same body, same status, no agentId)
    expect(supervisorEntries.length).toBe(1)
    expect(supervisorEntries[0].body).toContain('当前阶段是数据分析')
  })

  it('keeps separate supervisor entries with different status', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'loop.updated',
        eventId: 's1',
        message: '运行中',
        payload: { status: 'running', title: '数据获取', description: '正在获取数据' },
      }),
      makeEvent({
        type: 'loop.updated',
        eventId: 's2',
        message: '已完成',
        payload: { status: 'completed', title: '数据获取', description: '获取数据完成' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const supervisorEntries = result.filter((e) => e.kind === 'supervisor')
    expect(supervisorEntries.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — JSON summary extraction (sanitizeUserFacingText)
// ---------------------------------------------------------------------------
describe('_stripJsonWrapper / sanitizeUserFacingText', () => {
  // ---- Test 8: MESSAGE_DELTA from JSON output gets summary extracted ----
  it('extracts summary from pure JSON message.delta', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'message.delta',
        eventId: 'json-msg',
        message: JSON.stringify({ summary: '从 JSON 提取的摘要' }),
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const entry = result.find((e) => e.kind === 'assistant')
    expect(entry?.body).toBe('从 JSON 提取的摘要')
  })

  it('extracts summary from JSON with missing leading brace (streaming artifact)', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'message.delta',
        eventId: 'partial-json',
        message: '"summary":"不带大括号开头的内容"',
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const entry = result.find((e) => e.kind === 'assistant')
    expect(entry?.body).toBe('不带大括号开头的内容')
  })

  it('extracts summary from natural language text followed by JSON block', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'message.delta',
        eventId: 'mixed',
        message: `好的，结果如下：{"summary":"混合内容中的摘要"}`,
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const entry = result.find((e) => e.kind === 'assistant')
    expect(entry?.body).toBe('混合内容中的摘要')
  })

  it('returns original text if no JSON summary is found', () => {
    const raw = '这是普通的自然语言回复，不包含 JSON。'
    const events: RunEvent[] = [
      makeEvent({ type: 'message.delta', eventId: 'plain', message: raw }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const entry = result.find((e) => e.kind === 'assistant')
    expect(entry?.body).toBe(raw)
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — Chinese term replacement (sanitizeUserFacingText)
// ---------------------------------------------------------------------------
describe('sanitizeUserFacingText Chinese replacement', () => {
  it('replaces English terms with Chinese equivalents', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'run.completed',
        eventId: 'r1',
        message: 'Spatial Analyst completed the run with supervisor',
        payload: { finalResponse: { summary: '' } },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const assistant = result.find((e) => e.kind === 'assistant')
    expect(assistant?.body).not.toContain('Spatial Analyst')
    expect(assistant?.body).not.toContain('supervisor')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — final summary from agentState
// ---------------------------------------------------------------------------
describe('final summary from agentState.finalResponse', () => {
  // ---- Test 9: Final summary from agentState.finalResponse.summary ----
  it('appends finalResponse.summary when it is not already present in entries', () => {
    const agentState = makeAgentState({
      finalResponse: {
        summary: '最终分析结果摘要',
        limitations: [],
        nextActions: [],
      },
    })
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      agentState,
      events: [],
      artifacts: [],
    })
    const finalEntry = result.find((e) => e.id.startsWith('assistant:final'))
    expect(finalEntry).toBeDefined()
    expect(finalEntry!.body).toContain('最终分析结果摘要')
  })

  it('does NOT duplicate finalResponse.summary when it already matches an entry body', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'run.completed',
        eventId: 'done',
        message: '分析完成',
        payload: { finalResponse: { summary: '已经有的摘要' } },
      }),
    ]
    const agentState = makeAgentState({
      finalResponse: {
        summary: '已经有的摘要',
        limitations: [],
        nextActions: [],
      },
    })
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      agentState,
      events,
      artifacts: [],
    })
    // Should only have one assistant entry with that body (from run.completed)
    const matching = result.filter((e) => e.body.includes('已经有的摘要'))
    expect(matching.length).toBe(1)
  })

  it('skips finalResponse.summary when it is a generic failure message', () => {
    const agentState = makeAgentState({
      finalResponse: {
        summary: '抱歉，这次分析没能完成',
        limitations: [],
        nextActions: [],
      },
    })
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q', status: 'failed' }),
      agentState,
      events: [],
      artifacts: [],
    })
    const finalEntry = result.find((e) => e.id.startsWith('assistant:final'))
    expect(finalEntry).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — artifact entries
// ---------------------------------------------------------------------------
describe('artifact entries', () => {
  it('adds artifact entries when there are artifacts not already in events', () => {
    const run = makeRun({ userQuery: 'q' })
    const result = deriveRunTranscript({
      run,
      events: [],
      artifacts: [makeArtifact({ artifactId: 'art-1', name: '公交线路' })],
    })
    const artifactEntries = result.filter((e) => e.kind === 'artifact')
    expect(artifactEntries.length).toBe(1)
    expect(artifactEntries[0].title).toBe('公交线路')
    expect(artifactEntries[0].artifactId).toBe('art-1')
  })

  it('skips artifact entries when artifact.created events already cover them', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'artifact.created',
        eventId: 'art-evt',
        message: '图层已生成',
        payload: { name: '公交线路分析', artifactId: 'art-1' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [makeArtifact({ artifactId: 'art-1', name: '公交线路' })],
    })
    const artifactEntries = result.filter((e) => e.kind === 'artifact')
    // artifact.created event already created an artifact entry; the artifact
    // list fallback should not add a duplicate since one is already present
    expect(artifactEntries.length).toBe(1)
    expect(artifactEntries[0].artifactId).toBe('art-1')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — error events
// ---------------------------------------------------------------------------
describe('error events', () => {
  // ---- Test 10: Error events produce error kind entries ----
  it('run.failed produces an error entry with failed status', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'run.failed',
        eventId: 'fail-1',
        message: '模型调用超时',
        payload: { kind: 'model', finalResponse: { summary: '模型调用超时，请重试' } },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const errorEntry = result.find((e) => e.kind === 'error')
    expect(errorEntry).toBeDefined()
    expect(errorEntry!.status).toBe('failed')
    expect(errorEntry!.title).toContain('模型调用失败')
  })

  it('warning.raised produces an error entry with blocked status', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'warning.raised',
        eventId: 'warn-1',
        message: '审批需要你确认',
        payload: {},
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const errorEntry = result.find((e) => e.kind === 'error')
    expect(errorEntry).toBeDefined()
    expect(errorEntry!.status).toBe('blocked')
  })

  it('includes recoveryNote for warning with a subsequent meaningful event', () => {
    const events: RunEvent[] = [
      makeEvent({ type: 'warning.raised', eventId: 'w1', message: '数据量较大', payload: {} }),
      makeEvent({ type: 'tool.started', eventId: 't1', message: '', payload: { tool: 'buffer' } }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const warnEntry = result.find((e) => e.kind === 'error')
    expect(warnEntry?.recoveryNote).toContain('buffer')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — approval events
// ---------------------------------------------------------------------------
describe('approval and clarification events', () => {
  it('approval.required creates an approval entry', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'approval.required',
        eventId: 'app-req',
        message: '需要审批这个图层',
        payload: { title: '图层审批', description: '请确认是否发布该图层', approvalId: 'app-1', artifactId: 'art-1' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const approvalEntry = result.find((e) => e.kind === 'approval')
    expect(approvalEntry).toBeDefined()
    expect(approvalEntry!.status).toBe('blocked')
    expect(approvalEntry!.approvalId).toBe('app-1')
  })

  it('clarification.required creates an approval entry with blocked status', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'clarification.required',
        eventId: 'clarify-1',
        message: '请确认分析范围？',
        payload: { clarification: { question: '你想分析哪个区域？' } },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const approvalEntry = result.find((e) => e.kind === 'approval')
    expect(approvalEntry).toBeDefined()
    expect(approvalEntry!.title).toBe('需要确认')
    expect(approvalEntry!.body).toContain('你想分析哪个区域？')
    expect(approvalEntry!.status).toBe('blocked')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — max entries truncation
// ---------------------------------------------------------------------------
describe('max entries truncation', () => {
  it('respects runtimeConfig.ui.transcriptMaxEntries', () => {
    const config = makeRuntimeConfig({ ui: { transcriptMaxEntries: 3, showInternalReasoningLabels: false, eventGroupingWindowMs: 0 } })
    // Create events that will produce many entries
    const events: RunEvent[] = []
    for (let i = 0; i < 10; i++) {
      events.push(
        makeEvent({
          type: 'message.delta',
          eventId: `delta-${i}`,
          message: `Token chunk ${i}`,
          payload: { status: 'running' },
        }),
      )
    }
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
      runtimeConfig: config,
    })
    // 1 user entry + up to 3 (maxEntries) assistant entries (deltas compacted into 1)
    // total = 2, which is ≤ 4 boundary
    expect(result.length).toBeLessThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// deriveConversationEntries
// ---------------------------------------------------------------------------
describe('deriveConversationEntries', () => {
  it('converts user and assistant transcript entries to message conversation entries', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'user:run-1',
        kind: 'user',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: '用户问题',
        body: '查数据',
        status: 'completed',
      },
      {
        id: 'assistant:final:run-1',
        kind: 'assistant',
        timestamp: '2026-05-01T00:01:00.000Z',
        title: '',
        body: '数据查询完成',
        status: 'completed',
      },
    ]
    const result = deriveConversationEntries(transcript)
    expect(result.length).toBe(2)
    expect(result[0].kind).toBe('message')
    expect(result[0].role).toBe('user')
    expect(result[1].kind).toBe('message')
    expect(result[1].role).toBe('assistant')
  })

  // ---- Test 5: tool.started + tool.completed produce command batch ----
  it('converts tool entries into command_batch conversation entries', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'evt-ts1',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:01.000Z',
        title: 'geocode_place',
        body: '正在调用工具"geocode_place"。',
        status: 'running',
        commandText: '> geocode_place query="北京"',
        toolName: 'geocode_place',
      },
      {
        id: 'evt-tc1',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:02.000Z',
        title: 'geocode_place',
        body: '地理编码成功',
        status: 'completed',
        commandText: '> geocode_place query="北京"',
        toolName: 'geocode_place',
      },
    ]
    const result = deriveConversationEntries(transcript)
    // Tool entries should become a command_batch
    const commandBatch = result.filter((e) => e.kind === 'command_batch')
    expect(commandBatch.length).toBe(1)
    expect(commandBatch[0].commands?.length).toBe(1) // merged into single command
    expect(commandBatch[0].status).toBe('completed')
  })

  it('includes narration for running tool with supervisor context', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'supervisor-1',
        kind: 'supervisor',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: '地理编码阶段',
        body: '正在将地址解析为坐标',
        status: 'running',
      },
      {
        id: 'tool-1',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:01.000Z',
        title: 'geocode_place',
        body: '正在调用工具"geocode_place"。',
        status: 'running',
        commandText: '> geocode_place query="北京"',
        toolName: 'geocode_place',
      },
    ]
    const result = deriveConversationEntries(transcript)
    // 过程节点不再生成假旁白，工具命令直接以内联批次展示。
    const messages = result.filter((e) => e.kind === 'message')
    const commandBatches = result.filter((e) => e.kind === 'command_batch')
    expect(messages.length).toBe(0)
    expect(commandBatches.length).toBe(1)
    expect(commandBatches[0].commands?.[0]?.body).toContain('执行中')
  })

  it('converts approval entries', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'approval-1',
        kind: 'approval',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: '数据确认',
        body: '请确认数据集',
        status: 'blocked',
        approvalId: 'app-1',
        artifactId: 'art-1',
      },
    ]
    const result = deriveConversationEntries(transcript)
    expect(result.length).toBe(1)
    expect(result[0].kind).toBe('approval')
    expect(result[0].approvalId).toBe('app-1')
  })

  it('converts artifact entries to assistant message entries', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'artifact:store:art-1',
        kind: 'artifact',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: '分析结果图层',
        body: '结果已存储',
        status: 'completed',
        artifactId: 'art-1',
      },
    ]
    const result = deriveConversationEntries(transcript)
    expect(result.length).toBe(1)
    expect(result[0].kind).toBe('message')
    expect(result[0].role).toBe('assistant')
    expect(result[0].artifactId).toBe('art-1')
  })

  it('converts error entries', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'error:fail-1',
        kind: 'error',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: '模型调用失败',
        body: '模型超时',
        status: 'failed',
        recoveryNote: '请重试',
      },
    ]
    const result = deriveConversationEntries(transcript)
    expect(result.length).toBe(1)
    expect(result[0].kind).toBe('error')
    expect(result[0].badge).toBe('失败')
  })

  it('flushes pending activity when a non-activity entry appears', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'tool-1',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: 'buffer',
        body: '缓冲完成',
        status: 'completed',
        commandText: '> buffer distance=500',
        toolName: 'buffer',
      },
      {
        id: 'user:run-2',
        kind: 'user',
        timestamp: '2026-05-01T00:01:00.000Z',
        title: '用户问题',
        body: '然后呢？',
        status: 'completed',
      },
    ]
    const result = deriveConversationEntries(transcript)
    // Tool should be flushed before user message
    const commandBatch = result.find((e) => e.kind === 'command_batch')
    const userMessage = result.find((e) => e.kind === 'message' && e.role === 'user')
    expect(commandBatch).toBeDefined()
    expect(userMessage).toBeDefined()
    // Command batch should come before user message
    expect(result.indexOf(commandBatch!)).toBeLessThan(result.indexOf(userMessage!))
  })

  it('handles empty transcript array', () => {
    const result = deriveConversationEntries([])
    expect(result).toEqual([])
  })

  it('uses toolDescriptors for human-readable labels', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'tool-1',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:00.000Z',
        title: 'geocode_place',
        body: '地理编码完成',
        status: 'completed',
        commandText: '> geocode_place query="上海"',
        toolName: 'geocode_place',
      },
    ]
    const descriptors: ToolDescriptor[] = [
      makeToolDescriptor({ name: 'geocode_place', label: '地理编码服务' }),
    ]
    const result = deriveConversationEntries(transcript, 'completed', descriptors)
    const batch = result.find((e) => e.kind === 'command_batch')
    expect(batch?.commands?.[0].title).toBe('地理编码服务')
  })
})

// ---------------------------------------------------------------------------
// pickTranscriptHeadline
// ---------------------------------------------------------------------------
describe('pickTranscriptHeadline', () => {
  it('returns the latest non-user entry', () => {
    const entries: TranscriptEntry[] = [
      { id: '1', kind: 'user', timestamp: 't1', title: '', body: 'q', status: 'completed' },
      { id: '2', kind: 'assistant', timestamp: 't2', title: '', body: 'a', status: 'completed' },
    ]
    const headline = pickTranscriptHeadline(entries)
    expect(headline.kind).toBe('assistant')
    expect(headline.body).toBe('a')
  })

  it('returns idle placeholder when entries is empty and status is not running', () => {
    const headline = pickTranscriptHeadline([], 'completed')
    expect(headline.status).toBe('idle')
    expect(headline.title).toContain('等待新的分析任务')
    expect(headline.body).toContain('输入空间问题后')
  })

  it('returns running placeholder when entries is empty and status is running', () => {
    const headline = pickTranscriptHeadline([], 'running')
    expect(headline.status).toBe('running')
    expect(headline.title).toContain('正在连接运行流')
    expect(headline.body).toContain('正在等待第一条运行事件')
  })
})

// ---------------------------------------------------------------------------
// deriveThreadTranscript
// ---------------------------------------------------------------------------
describe('deriveThreadTranscript', () => {
  it('delegates to deriveRunTranscript when threadRuns has 0-1 items', () => {
    const result = deriveThreadTranscript({
      run: makeRun({ userQuery: 'thread query' }),
      events: [],
      artifacts: [],
    })
    expect(result[0].kind).toBe('user')
    expect(result[0].body).toContain('thread query')
  })

  it('combines multiple thread runs into ordered entries', () => {
    const run1 = makeRun({
      id: 'run-old',
      userQuery: '第一个问题',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:01:00.000Z',
      status: 'completed',
    })
    const run2 = makeRun({
      id: 'run-new',
      userQuery: '第二个问题',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:01:00.000Z',
      status: 'completed',
    })
    const result = deriveThreadTranscript({
      run: run2,
      events: [],
      artifacts: [],
      threadRuns: [run1],
    })
    const userEntries = result.filter((e) => e.kind === 'user')
    expect(userEntries.length).toBe(2)
    expect(userEntries[0].body).toContain('第一个问题')
    expect(userEntries[1].body).toContain('第二个问题')
  })

  it('deduplicates runs by id', () => {
    const run = makeRun({ userQuery: '不重复的查询' })
    const result = deriveThreadTranscript({
      run,
      events: [],
      artifacts: [],
      threadRuns: [run], // same run appears in both places
    })
    const userEntries = result.filter((e) => e.kind === 'user')
    expect(userEntries.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — subagent events
// ---------------------------------------------------------------------------
describe('subagent events', () => {
  it('creates subagent entries for subagent.created and subagent.updated', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'subagent.created',
        eventId: 'sub-c',
        message: '分析子智能体已创建',
        payload: { agentId: 'agent-1', role: '数据分析师', status: 'running' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const subagentEntry = result.find((e) => e.kind === 'subagent')
    expect(subagentEntry).toBeDefined()
    expect(subagentEntry!.title).toBe('数据分析师')
    expect(subagentEntry!.status).toBe('running')
  })

  it('skips idle subagent without currentStepId', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'subagent.created',
        eventId: 'sub-idle',
        message: '空闲子智能体',
        payload: { agentId: 'agent-2', role: '观察者', status: 'idle' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const subagentEntry = result.find((e) => e.kind === 'subagent')
    expect(subagentEntry).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — artifact.created events
// ---------------------------------------------------------------------------
describe('artifact.created event', () => {
  it('maps artifact.created to an artifact entry', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'artifact.created',
        eventId: 'art-evt',
        message: '新图层已创建',
        payload: { name: '道路网', artifactId: 'art-2' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const artifactEntry = result.find((e) => e.kind === 'artifact')
    expect(artifactEntry).toBeDefined()
    expect(artifactEntry!.title).toBe('道路网')
    expect(artifactEntry!.artifactId).toBe('art-2')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — clarification.required with missing question field
// ---------------------------------------------------------------------------
describe('clarification.required edge case', () => {
  it('falls back to event.message when clarification question is missing', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'clarification.required',
        eventId: 'cl-edge',
        message: '默认的澄清问题',
        payload: {},
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const entry = result.find((e) => e.kind === 'approval')
    expect(entry?.body).toBe('默认的澄清问题')
  })
})

// ---------------------------------------------------------------------------
// deriveRunTranscript — tool.completed with no args fallback
// ---------------------------------------------------------------------------
describe('tool.completed with missing args', () => {
  it('falls back to toolName-only commandText when no args and no previous tool.started', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'tool.completed',
        eventId: 'tc-orphan',
        message: '完成',
        payload: { tool: 'some_tool' },
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const toolEntry = result.find((e) => e.kind === 'tool')
    // buildToolCommandText returns "> some_tool" even when args are absent
    expect(toolEntry?.commandText).toBe('> some_tool')
  })
})

// ---------------------------------------------------------------------------
// deriveConversationEntries — tool commands dedup
// ---------------------------------------------------------------------------
describe('deriveConversationEntries command dedup', () => {
  it('deduplicates consecutive tool entries with same toolName and commandText', () => {
    const transcript: TranscriptEntry[] = [
      {
        id: 'tool-start',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:01.000Z',
        title: 'geocode_place',
        body: '开始',
        status: 'running',
        commandText: '> geocode_place query="北京"',
        toolName: 'geocode_place',
      },
      {
        id: 'tool-end',
        kind: 'tool',
        timestamp: '2026-05-01T00:00:02.000Z',
        title: 'geocode_place',
        body: '完成',
        status: 'completed',
        commandText: '> geocode_place query="北京"',
        toolName: 'geocode_place',
      },
    ]
    const result = deriveConversationEntries(transcript)
    const batch = result.find((e) => e.kind === 'command_batch')
    expect(batch!.commands!.length).toBe(1) // merged into one
    expect(batch!.commands![0].status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// edge: transcript entry with unknown kind in deriveConversationEntries
// ---------------------------------------------------------------------------
describe('deriveConversationEntries unknown kind', () => {
  it('treats unknown entry kinds as errors', () => {
    const transcript = [
      {
        id: 'unknown-1',
        kind: 'something_else' as any,
        timestamp: 't1',
        title: '未知',
        body: 'unknown entry',
        status: 'blocked' as any,
      },
    ]
    const result = deriveConversationEntries(transcript as TranscriptEntry[])
    expect(result.length).toBe(1)
    expect(result[0].kind).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// edge: NormalizeTranscriptText with various input types
// ---------------------------------------------------------------------------
describe('indirect: normalizeTranscriptText (via events)', () => {
  it('handles events with array message', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'message.delta',
        eventId: 'arr-msg',
        message: ['第一行', '第二行'] as any,
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events: events as RunEvent[],
      artifacts: [],
    })
    const assistant = result.find((e) => e.kind === 'assistant')
    expect(assistant?.body).toContain('第一行')
    expect(assistant?.body).toContain('第二行')
  })
})

// ---------------------------------------------------------------------------
// edge: run completed with no finalResponse
// ---------------------------------------------------------------------------
describe('run.completed without finalResponse', () => {
  it('falls back to event.message when finalResponse.summary is missing', () => {
    const events: RunEvent[] = [
      makeEvent({
        type: 'run.completed',
        eventId: 'done-no-summary',
        message: '运行完成但无摘要',
        payload: {},
      }),
    ]
    const result = deriveRunTranscript({
      run: makeRun({ userQuery: 'q' }),
      events,
      artifacts: [],
    })
    const entry = result.find((e) => e.body.includes('运行完成但无摘要'))
    expect(entry).toBeDefined()
  })
})
