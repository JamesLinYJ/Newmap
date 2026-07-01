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
import { parametersForAgentsSdk, parametersFromJsonSchema, stripNullObjectValues } from './schema.js'
import { validateToolProvider } from './validation.js'
import type { PostGisRepository } from '../gis/postgis.js'
import chartProvider from '../tools/chart/index.js'
import geocodeProvider from '../tools/geocode/index.js'
import mediaProvider from '../tools/media/index.js'
import memoryProvider from '../tools/memory/index.js'
import planProvider from '../tools/plan/index.js'
import developerProvider from '../tools/developer/index.js'
import meteorologyProvider from '../tools/meteorology/index.js'
import { createSpatialProvider } from '../tools/spatial/index.js'
import { createRoutingProvider } from '../tools/routing/index.js'

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

  it('requires every builtin tool to expose a Chinese tool prompt contract', () => {
    // 工具 prompt 是 Agent 运行时可见的工具级契约；这里覆盖所有内置 Provider，
    // 防止新增工具绕过中文说明、valueRef 边界和 approval 规则。
    const providers = builtinProviders()
    for (const currentProvider of providers) {
      expect(() => validateToolProvider(currentProvider)).not.toThrow()
      for (const tool of currentProvider.tools()) {
        expect(tool.prompt.trim(), `${tool.name} prompt`).toBeTruthy()
        expect(tool.prompt, `${tool.name} prompt`).toMatch(/[\u4e00-\u9fff]/)
      }
    }
  })

  it('rejects unsupported artifact display surfaces at execution boundary', async () => {
    const registry = new ToolRegistry()
    registry.register(artifactProvider({ displaySurfaces: ['miniapp'] }))
    await expect(registry.execute('artifact_example', {}, context())).rejects.toThrow('不支持的展示面')
  })

  it('hard-fails unknown value references', () => {
    expect(() => context().resolveValueRef('missing')).toThrow('未知 valueRef')
  })

  it('keeps runtime optional fields while exposing nullable fields to Agents SDK', () => {
    // OpenAI strict tool schemas require all properties to be required; GeoForge handlers
    // still use omission as the internal optional-argument contract. Compatible providers
    // may omit nullable optional fields, so the SDK parser must accept both shapes.
    const schema = {
      type: 'object',
      properties: {
        layerKey: { type: 'string' },
        bbox: { type: 'array', items: { type: 'number' } },
        options: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            color: { type: 'string' },
          },
          required: ['label'],
        },
      },
      required: ['layerKey'],
    }

    expect(parametersFromJsonSchema(schema).safeParse({ layerKey: 'districts' }).success).toBe(true)
    expect(parametersFromJsonSchema(schema).safeParse({ layerKey: 'districts', bbox: null }).success).toBe(false)

    const agentsParameters = parametersForAgentsSdk(schema)
    expect(agentsParameters.safeParse({ layerKey: 'districts' }).success).toBe(true)
    expect(agentsParameters.safeParse({
      layerKey: 'districts',
      bbox: null,
      options: { label: '区划', color: null },
    }).success).toBe(true)
    expect(stripNullObjectValues({
      layerKey: 'districts',
      bbox: null,
      options: { label: '区划', color: null },
    })).toEqual({
      layerKey: 'districts',
      options: { label: '区划' },
    })
  })
})

function builtinProviders(): ToolProvider[] {
  process.env.API_PORT ??= '0'
  process.env.API_HOST ??= '127.0.0.1'
  process.env.DATABASE_URL ??= 'postgres://user:password@127.0.0.1:5432/geoforge_test'
  process.env.RUNTIME_ROOT ??= 'runtime-test'
  process.env.ENABLED_TOOL_PROVIDERS ??= 'geo-platform-spatial'
  const fakePostgis = {} as unknown as PostGisRepository
  return [
    chartProvider as ToolProvider,
    geocodeProvider as ToolProvider,
    mediaProvider as ToolProvider,
    memoryProvider as ToolProvider,
    planProvider as ToolProvider,
    developerProvider as ToolProvider,
    meteorologyProvider as ToolProvider,
    createSpatialProvider(fakePostgis),
    createRoutingProvider(),
  ]
}

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
      prompt: '用于测试工具注册和执行边界。',
      isReadOnly: true, isDestructive: false, jsonSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (fails) throw new Error('真实失败')
        return { message: '成功', payload: {}, warnings: [], resultId: 'result_1', source: 'test' }
      },
    }],
  }
}

function artifactProvider(metadata: Record<string, unknown>): ToolProvider {
  const definition = {
    name: 'artifact_example',
    label: 'Artifact 示例',
    description: '验证 artifact 展示面契约',
    prompt: '用于测试 artifact 展示面校验。',
    group: '测试',
    tags: [],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: { type: 'object', properties: {} },
  }
  return {
    manifest: {
      id: 'artifact-provider', name: 'Artifact 测试', version: '1', author: 'test', language: 'typescript', description: 'Artifact 测试',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => ({
        message: '成功',
        payload: {},
        warnings: [],
        resultId: 'result_artifact',
        source: 'test',
        artifacts: [{
          artifactId: 'artifact_1',
          artifactType: 'raster_png',
          name: '预览图',
          uri: '/api/v1/results/artifact_1/file',
          relativePath: 'artifacts/run_1/artifact_1.png',
          metadata,
        }],
      }),
    }],
  }
}

function nestedProvider(): ToolProvider {
  const definition = {
    name: 'nested', label: '嵌套参数', description: '嵌套参数校验', prompt: '用于测试嵌套参数 schema 校验。', group: '测试', tags: [],
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
