// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry 契约测试
//
//   文件:       registry.test.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './registry.js'
import type { ToolContext, ToolProvider } from './types.js'

describe('ToolRegistry contract', () => {
  it('rejects manifest and runtime descriptor drift', () => {
    const registry = new ToolRegistry()
    const drifted = provider()
    drifted.manifest.tools[0].jsonSchema = {
      type: 'object',
      properties: { hidden_parameter: { type: 'string' } },
    }
    expect(() => registry.register(drifted)).toThrow('jsonSchema 与 manifest 不一致')
  })

  it('rejects unknown parameters before execution', async () => {
    const registry = new ToolRegistry()
    registry.register(provider())
    await expect(registry.execute('example', { unknown: true }, context())).rejects.toThrow('未知参数')
  })

  it('validates nested parameter types and ranges before execution', async () => {
    const registry = new ToolRegistry()
    registry.register(nestedProvider())
    await expect(registry.execute('nested', { points: [{ lat: 91, lon: 120 }] }, context())).rejects.toThrow('不能大于 90')
    await expect(registry.execute('nested', { points: 'invalid' }, context())).rejects.toThrow('必须是数组')
  })

  it('exposes management metadata for tools and provider statuses', () => {
    const registry = new ToolRegistry()
    registry.register(provider())
    registry.markUnavailable('missing-provider', '缺少依赖')

    expect(registry.descriptors()[0]).toMatchObject({
      name: 'example',
      providerId: 'test-provider',
      language: 'typescript',
      isReadOnly: true,
      isDestructive: false,
      meta: {
        providerId: 'test-provider',
        language: 'typescript',
        approvalRecommended: false,
      },
    })
    expect(registry.providerStatuses()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'test-provider',
        version: '1',
        author: 'test',
        language: 'typescript',
        toolCount: 1,
        available: true,
      }),
      expect.objectContaining({
        providerId: 'missing-provider',
        toolCount: 0,
        available: false,
        error: '缺少依赖',
      }),
    ]))
  })

  it('surfaces tool failures instead of returning synthetic success', async () => {
    const registry = new ToolRegistry()
    registry.register(provider(true))
    await expect(registry.execute('example', {}, context())).rejects.toThrow('真实失败')
  })

  it('hard-fails unknown value references', () => {
    expect(() => context().resolveValueRef('missing')).toThrow('未知 valueRef')
  })
})

function provider(fails = false): ToolProvider {
  return {
    manifest: {
      id: 'test-provider', name: '测试', version: '1', author: 'test', language: 'typescript', description: '测试',
      tools: [{
        name: 'example', label: '示例', description: '示例工具', group: '测试', tags: [],
        isReadOnly: true, isDestructive: false, jsonSchema: { type: 'object', properties: {} },
      }],
    },
    tools: () => [{
      name: 'example', label: '示例', description: '示例工具', group: '测试', tags: [],
      isReadOnly: true, isDestructive: false, jsonSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (fails) throw new Error('真实失败')
        return { message: '成功', payload: {}, warnings: [], resultId: 'result_1', source: 'test' }
      },
    }],
  }
}

function nestedProvider(): ToolProvider {
  const definition = {
    name: 'nested', label: '嵌套参数', description: '嵌套参数校验', group: '测试', tags: [],
    isReadOnly: true, isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        points: {
          type: 'array', minItems: 1, items: {
            type: 'object',
            properties: {
              lat: { type: 'number', minimum: -90, maximum: 90 },
              lon: { type: 'number', minimum: -180, maximum: 180 },
            },
            required: ['lat', 'lon'],
          },
        },
      },
      required: ['points'],
    },
  }
  return {
    manifest: {
      id: 'nested-provider', name: '嵌套测试', version: '1', author: 'test', language: 'typescript', description: '嵌套测试',
      tools: [definition],
    },
    tools: () => [{ ...definition, handler: async () => ({ message: '成功', payload: {}, warnings: [], resultId: 'result_nested', source: 'test' }) }],
  }
}

function context(): ToolContext {
  return {
    runId: 'run_1', sessionId: 'session_1', threadId: 'thread_1', state: new Map(),
    resolveValueRef: refId => { throw new Error(`未知 valueRef：${refId}`) },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}
