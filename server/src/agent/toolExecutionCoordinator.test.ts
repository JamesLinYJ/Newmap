// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行协调器测试
//
//   文件:       toolExecutionCoordinator.test.ts
//
//   日期:       2026年06月24日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ToolResult } from '../framework/types.js'
import { formatToolResultForModel } from './toolExecutionCoordinator.js'

describe('formatToolResultForModel', () => {
  it('keeps valueRefs visible while summarizing oversized payloads', () => {
    const result: ToolResult = {
      message: 'create_nowcast_sequence 执行完成',
      payload: {
        datasets: Array.from({ length: 60 }, (_, index) => ({
          filename: `lead_${String(index).padStart(3, '0')}.nc`,
          metadata: {
            variables: Array.from({ length: 20 }, (_item, variableIndex) => ({
              name: `QPF_${variableIndex}`,
              bounds: [115.5, 27, 124.5, 32],
            })),
          },
        })),
      },
      warnings: [],
      resultId: 'result_sequence',
      source: 'test',
      valueRefs: [
        { refId: 'ref_dataset', kind: 'meteorological_dataset', label: 'lead_000.nc', value: {} },
        { refId: 'ref_sequence', kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列', value: {} },
      ],
    }

    const formatted = JSON.parse(formatToolResultForModel(result, 1200)) as Record<string, unknown>

    expect(formatted.valueRefs).toEqual([
      { refId: 'ref_dataset', kind: 'meteorological_dataset', label: 'lead_000.nc', unit: null },
      { refId: 'ref_sequence', kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列', unit: null },
    ])
    expect(formatted.payloadSummary).toMatchObject({
      datasets: {
        type: 'array',
        length: 60,
      },
    })
    expect(JSON.stringify(formatted)).not.toContain('lead_059.nc')
  })
})
