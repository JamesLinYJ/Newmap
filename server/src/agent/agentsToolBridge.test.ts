// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 工具桥接测试
//
//   文件:       agentsToolBridge.test.ts
//
//   日期:       2026年06月24日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolDef, ToolProvider } from '../framework/types.js'
import { createAgentsTools } from './agentsToolBridge.js'

describe('createAgentsTools', () => {
  it('makes valueRef kind constraints visible to the model', () => {
    const registry = new ToolRegistry()
    registry.register(providerFromTools([{
      name: 'render_rainfall_risk_map',
      label: '生成降雨风险区划图',
      description: '生成风险区划图',
      group: '气象',
      tags: ['meteorology'],
      isReadOnly: true,
      isDestructive: false,
      jsonSchema: {
        type: 'object',
        properties: {
          dataset_ref: {
            type: 'string',
            description: '必须使用当前 run 中已存在的 valueRef ID',
            'x-source': 'value_ref',
            'x-value-ref-kinds': ['meteorological_dataset'],
          },
          boundary_ref: {
            type: 'string',
            description: '必须使用当前 run 中已存在的 valueRef ID',
            'x-source': 'value_ref',
            'x-value-ref-kinds': ['feature_collection', 'layer'],
          },
        },
        required: ['dataset_ref', 'boundary_ref'],
      },
      handler: async () => ({
        message: 'ok',
        payload: {},
        warnings: [],
        resultId: 'result_1',
        source: 'test',
      }),
    }]))

    const [tool] = createAgentsTools(registry, new Set())
    const properties = tool.parameters.properties as Record<string, Record<string, unknown>>

    expect(tool.description).toContain('dataset_ref 只接受 meteorological_dataset')
    expect(tool.description).toContain('boundary_ref 只接受 feature_collection / layer')
    expect(properties.dataset_ref.description).toContain('允许的 valueRef kind: meteorological_dataset')
    expect(properties.dataset_ref.description).toContain('禁止传入其它 kind')
  })
})

function providerFromTools(tools: ToolDef[]): ToolProvider {
  return {
    manifest: {
      id: 'agent-bridge-test',
      name: 'Agent Bridge Test',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: 'Agent Bridge Test',
      tools: tools.map(({ handler: _handler, providerId: _providerId, language: _language, ...definition }) => definition),
    },
    tools: () => tools,
  }
}
