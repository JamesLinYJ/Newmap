import { describe, expect, it } from 'vitest'

import type { AnalysisRun, RunEvent } from '@geo-agent-platform/shared-types'
import { deriveRunTranscript } from './runTranscript'

function buildRun(status: AnalysisRun['status'] = 'running'): AnalysisRun {
  return {
    id: 'run_123',
    sessionId: 'session_123',
    userQuery: '查询巴黎地铁站 1 公里范围内的医院',
    modelProvider: 'gemini',
    modelName: 'gemini-2.5-pro',
    status,
    createdAt: '2026-04-16T07:00:00.000Z',
    updatedAt: '2026-04-16T07:00:05.000Z',
    state: {
      sessionId: 'session_123',
      userQuery: '查询巴黎地铁站 1 公里范围内的医院',
      currentStep: 0,
      loopIteration: 1,
      loopPhase: 'act',
      loopTrace: [],
      todos: [],
      subAgents: [],
      approvals: [],
      toolResults: [],
      artifacts: [],
      warnings: [],
      errors: [],
    },
  }
}

describe('deriveRunTranscript', () => {
  it('renders tool invocations as command-like entries', () => {
    const events: RunEvent[] = [
      {
        eventId: 'evt_tool',
        runId: 'run_123',
        type: 'tool.started',
        message: '开始调用工具：buffer',
        timestamp: '2026-04-16T07:00:01.000Z',
        payload: {
          tool: 'buffer',
          args: {
            input: 'artifact_boundary',
            distance_m: 1000,
          },
        },
      },
    ]

    const entries = deriveRunTranscript({ run: buildRun(), events, artifacts: [] })
    const toolEntry = entries.find((entry) => entry.kind === 'tool')

    expect(toolEntry?.title).toBe('buffer')
    expect(toolEntry?.commandText).toContain('> buffer')
    expect(toolEntry?.commandText).toContain('distance_m=1000')
  })

  it('reuses the previous tool arguments when the completion event omits them', () => {
    const events: RunEvent[] = [
      {
        eventId: 'evt_tool_start',
        runId: 'run_123',
        type: 'tool.started',
        message: '开始调用工具：load_boundary',
        timestamp: '2026-04-16T07:00:01.000Z',
        payload: {
          stepId: 'step_boundary',
          tool: 'load_boundary',
          args: {
            name: 'Paris',
          },
        },
      },
      {
        eventId: 'evt_tool_done',
        runId: 'run_123',
        type: 'tool.completed',
        message: '已加载 Paris 的行政区边界。',
        timestamp: '2026-04-16T07:00:02.000Z',
        payload: {
          stepId: 'step_boundary',
          tool: 'load_boundary',
        },
      },
    ]

    const entries = deriveRunTranscript({ run: buildRun('completed'), events, artifacts: [] })
    const completedEntry = entries.find((entry) => entry.id === 'evt_tool_done')

    expect(completedEntry?.commandText).toContain('> load_boundary')
    expect(completedEntry?.commandText).toContain('name="Paris"')
  })

  it('adds a recovery note after a failure when the system continues', () => {
    const events: RunEvent[] = [
      {
        eventId: 'evt_warn',
        runId: 'run_123',
        type: 'warning.raised',
        message: 'QGIS 运行超时，准备切换到备用路径。',
        timestamp: '2026-04-16T07:00:02.000Z',
        payload: {},
      },
      {
        eventId: 'evt_next',
        runId: 'run_123',
        type: 'tool.started',
        message: '开始调用工具：distance_query',
        timestamp: '2026-04-16T07:00:03.000Z',
        payload: {
          tool: 'distance_query',
          args: { source: 'metro', target: 'hospital', distance_m: 1000 },
        },
      },
    ]

    const entries = deriveRunTranscript({ run: buildRun(), events, artifacts: [] })
    const errorEntry = entries.find((entry) => entry.kind === 'error')

    expect(errorEntry?.recoveryNote).toContain('系统已继续尝试下一步')
    expect(errorEntry?.recoveryNote).toContain('distance_query')
  })
})
