// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 运行时契约测试
//
//   文件:       runtime.test.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolDef, ToolProvider, ToolResult, ValueRef } from '../framework/types.js'
import type { Env } from '../framework/env.js'
import { makeCapabilities, ModelAdapterRegistry, type ModelAdapter } from '../model/registry.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { GeoAgentRuntime } from './runtime.js'

describe('GeoAgentRuntime delivery boundaries', () => {
  it('rebuilds the visible transcript after restart and sends the current user message once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-continuation-'))
    try {
      const firstStore = new PostgresPlatformStore(noOpDb(), root)
      await firstStore.initialize()
      const session = await firstStore.createSession()
      const thread = await firstStore.createThread(session.id, '连续对话')
      const captured: Array<Array<{ role: string; content: string | null }>> = []
      const adapter: ModelAdapter = {
        ...fakeAdapter(),
        async *chatStream(messages) {
          captured.push(messages.map(message => ({ role: message.role, content: message.content })))
          yield { content: captured.length === 1 ? '项目代号是西湖。' : '我记得，项目代号是西湖。', finishReason: 'stop' }
        },
      }
      const models = new ModelAdapterRegistry(testEnv())
      models.register(adapter)
      const firstRun = await firstStore.createRun(session.id, '记住项目代号是西湖', {
        threadId: thread.id,
        modelProvider: adapter.provider,
        runtimeConfigSnapshot: defaultRuntimeConfig(),
      })
      await new GeoAgentRuntime(firstStore, new ToolRegistry(), models).run({
        runId: firstRun.id,
        threadId: thread.id,
        sessionId: session.id,
        query: firstRun.userQuery,
        provider: adapter.provider,
        runtimeConfig: defaultRuntimeConfig(),
      })
      await firstStore.conversationStore.flush()

      const restoredStore = new PostgresPlatformStore(noOpDb(), root)
      await restoredStore.initialize()
      const secondRun = await restoredStore.createRun(session.id, '刚才的项目代号是什么？', {
        threadId: thread.id,
        modelProvider: adapter.provider,
        runtimeConfigSnapshot: defaultRuntimeConfig(),
      })
      await new GeoAgentRuntime(restoredStore, new ToolRegistry(), models).run({
        runId: secondRun.id,
        threadId: thread.id,
        sessionId: session.id,
        query: secondRun.userQuery,
        provider: adapter.provider,
        runtimeConfig: defaultRuntimeConfig(),
      })

      const secondMessages = captured[1]
      expect(secondMessages.some(message => message.content === '记住项目代号是西湖')).toBe(true)
      expect(secondMessages.some(message => message.content === '项目代号是西湖。')).toBe(true)
      expect(secondMessages.filter(message => message.content === secondRun.userQuery)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists an approval boundary and resumes it once without duplicating the user item', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-'))
    try {
      const store = new PostgresPlatformStore(noOpDb(), root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '审批测试')
      const config = defaultRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['sensitive_tool']
      const run = await store.createRun(session.id, '执行敏感工具', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      let executions = 0
      tools.register(provider(() => { executions += 1 }))
      const models = new ModelAdapterRegistry(testEnv())
      models.register(fakeAdapter())
      const runtime = new GeoAgentRuntime(store, tools, models)

      const waiting = await runtime.run({
        runId: run.id,
        threadId: thread.id,
        sessionId: session.id,
        query: run.userQuery,
        provider: 'fake',
        runtimeConfig: config,
      })

      expect(waiting.status).toBe('waiting_approval')
      expect(executions).toBe(0)
      expect(waiting.state.approvals).toHaveLength(1)

      // 模拟服务在等待审批时重启；批准后必须执行原 callId，而不是再次向模型索取工具调用。
      await store.conversationStore.flush()
      const restoredStore = new PostgresPlatformStore(noOpDb(), root)
      await restoredStore.initialize()
      const completed = await new GeoAgentRuntime(restoredStore, tools, models)
        .resolveApproval(run.id, waiting.state.approvals[0].approvalId, true)

      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(completed.state.approvals[0].payload.consumed).toBe(true)
      expect((await restoredStore.listItems(run.id)).filter(item => item.role === 'user')).toHaveLength(1)
      const transcript = await restoredStore.activeTranscript(thread.id)
      expect(transcript.filter(entry => entry.kind === 'tool_call')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_result')).toHaveLength(1)
      await restoredStore.conversationStore.flush()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries a transient model disconnect before the first streamed delta', async () => {
    let attempts = 0
    const result = await executeTextRun({
      ...fakeAdapter(),
      async *chatStream() {
        attempts += 1
        if (attempts === 1) throw new Error('terminated')
        yield { content: '连接恢复后的回答。', finishReason: 'stop' }
      },
    })

    expect(attempts).toBe(2)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.body === '连接恢复后的回答。')).toBe(true)
  })

  it('persists a readable error after the transient model retry also fails', async () => {
    const result = await executeTextRun({
      ...fakeAdapter(),
      async *chatStream() {
        throw new Error('terminated')
      },
    })

    expect(result.run.status).toBe('failed')
    expect(result.run.state.errors[0]).toContain('模型连接被中断')
    expect(result.items.at(-1)?.metadata.message).toContain('模型连接被中断')
  })

  it('keeps tool preambles as visible commentary and stops at the deterministic nowcast answer tool', async () => {
    let turn = 0
    const definition = {
      name: 'answer_nowcast_question',
      label: '回答短临问题',
      description: '返回确定性短临答案',
      group: '气象',
      tags: ['meteorology'],
      isReadOnly: true,
      isDestructive: false,
      jsonSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    }
    const tools = new ToolRegistry()
    tools.register({
      manifest: {
        id: 'nowcast-test', name: '短临测试', version: '1', author: 'test', language: 'typescript', description: '短临测试',
        tools: [definition],
      },
      tools: () => [{
        ...definition,
        handler: async () => ({
          message: '回答完成',
          payload: { answer: '未来3小时不会下雨，您可以放心出门。' },
          warnings: [],
          resultId: 'answer_1',
          source: 'test',
        }),
      }],
    })
    const adapter: ModelAdapter = {
      ...fakeAdapter(),
      async *chatStream() {
        turn += 1
        yield { content: '我先分析一下。' }
        yield {
          toolCalls: [{ id: 'answer_call', index: 0, name: 'answer_nowcast_question', arguments: '{"question":"市民中心天气怎么样？"}' }],
          finishReason: 'tool_calls',
        }
      },
    }
    const result = await executeTextRun(adapter, tools)

    expect(turn).toBe(1)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.itemType === 'reasoning' && item.body === '我先分析一下。')).toBe(false)
    expect(result.items.some(item => item.itemType === 'message' && item.role === 'assistant' && item.body === '我先分析一下。' && item.metadata.messageKind === 'commentary')).toBe(true)
    const itemIds = result.items.map(item => item.itemId)
    expect(new Set(itemIds).size).toBe(itemIds.length)
  })

  // 线程已有气象序列时，标准天气问句必须绕过模型并执行固定 valueRef 工具链。
  it('routes uploaded meteorological files through the deterministic nowcast chain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-nowcast-'))
    try {
      const store = new PostgresPlatformStore(noOpDb(), root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '短临确定性路由')
      const files = new RuntimeFileStore(root)
      const ncFile = (name: string) => ({ name, arrayBuffer: async () => Uint8Array.from([1]).buffer })
      await files.save(ncFile('lead_005.nc'), thread.id)
      await files.save(ncFile('lead_010.nc'), thread.id)

      const calls: string[] = []
      const tools = new ToolRegistry()
      tools.register(deterministicNowcastProvider(calls))
      let modelCalls = 0
      const models = new ModelAdapterRegistry(testEnv())
      models.register({
        ...fakeAdapter(),
        async *chatStream() {
          modelCalls += 1
          yield { content: '不应调用模型。', finishReason: 'stop' }
        },
      })
      const config = defaultRuntimeConfig()
      const run = await store.createRun(session.id, '接下来天气怎么样？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })

      const completed = await new GeoAgentRuntime(store, tools, models).run({
        runId: run.id,
        threadId: thread.id,
        sessionId: session.id,
        query: run.userQuery,
        provider: 'fake',
        runtimeConfig: config,
      })

      expect(completed.status).toBe('completed')
      expect(modelCalls).toBe(0)
      expect(calls).toEqual([
        'list_meteorological_files',
        'create_nowcast_sequence',
        'prepare_hangzhou_nowcast_scope',
        'analyze_nowcast_precipitation',
        'answer_nowcast_question',
      ])
      expect(completed.state.toolValueRefs.some(ref => ref.kind === 'nowcast_answer')).toBe(true)
      await store.conversationStore.flush()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// 文本运行夹具隔离每个 runtime 场景的 JSONL 状态，避免重试次数互相污染。
async function executeTextRun(adapter: ModelAdapter, tools = new ToolRegistry()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-stream-'))
  try {
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '模型流测试')
    const run = await store.createRun(session.id, '回答测试问题', {
      threadId: thread.id,
      modelProvider: adapter.provider,
      runtimeConfigSnapshot: defaultRuntimeConfig(),
    })
    const models = new ModelAdapterRegistry(testEnv())
    models.register(adapter)
    const runtime = new GeoAgentRuntime(store, tools, models)
    const completed = await runtime.run({
      runId: run.id,
      threadId: thread.id,
      sessionId: session.id,
      query: run.userQuery,
      provider: adapter.provider,
      runtimeConfig: defaultRuntimeConfig(),
    })
    await store.conversationStore.flush()
    return { run: structuredClone(completed), items: structuredClone(await store.listItems(run.id)) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function provider(onExecute: () => void): ToolProvider {
  const definition = {
    name: 'sensitive_tool',
    label: '敏感工具',
    description: '需要审批的测试工具',
    group: '测试',
    tags: ['test'],
    isReadOnly: false,
    isDestructive: false,
    jsonSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
  }
  return {
    manifest: {
      id: 'approval-test-provider',
      name: '审批测试 Provider',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: '审批测试',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => {
        onExecute()
        return { message: '执行完成', payload: { ok: true }, warnings: [], resultId: 'result_1', source: 'test' }
      },
    }],
  }
}

function deterministicNowcastProvider(calls: string[]): ToolProvider {
  const tool = (
    name: string,
    required: string[],
    handler: ToolDef['handler'],
  ): ToolDef => ({
    name,
    label: name,
    description: `${name} test tool`,
    group: '气象',
    tags: ['meteorology'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])),
      required,
    },
    handler: async (args, context) => {
      calls.push(name)
      return handler(args, context)
    },
  })
  const ref = (refId: string, kind: string, value: unknown): ValueRef => ({ refId, kind, label: kind, value })
  const result = (name: string, valueRefs: ValueRef[], payload: Record<string, unknown> = {}): ToolResult => ({
    message: `${name} completed`,
    payload,
    warnings: [],
    resultId: `result_${name}`,
    source: 'test',
    valueRefs,
  })
  const tools: ToolDef[] = [
    tool('list_meteorological_files', [], async () => result('list', [
      ref('ref_collection', 'meteorological_file_collection', { files: [{ name: 'a.nc' }, { name: 'b.nc' }] }),
    ])),
    tool('create_nowcast_sequence', ['file_collection_ref'], async () => result('sequence', [
      ref('ref_sequence', 'nowcast_sequence', { entries: [] }),
    ])),
    tool('prepare_hangzhou_nowcast_scope', ['question'], async () => result('scope', [
      ref('ref_scope', 'nowcast_area', { type: 'FeatureCollection', features: [] }),
    ])),
    tool('analyze_nowcast_precipitation', ['sequence_ref', 'scope_ref'], async () => result('analysis', [
      ref('ref_analysis', 'nowcast_analysis', { scope: {} }),
    ])),
    tool('answer_nowcast_question', ['nowcast_analysis_ref', 'question'], async () => result('answer', [
      ref('ref_answer', 'nowcast_answer', { answer: '未来三小时不会下雨，您可以放心出门。' }),
    ], { answer: '未来三小时不会下雨，您可以放心出门。' })),
  ]
  return {
    manifest: {
      id: 'deterministic-nowcast-test',
      name: '确定性短临测试',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: '确定性短临路由测试',
      tools: tools.map(({ handler: _handler, ...definition }) => definition),
    },
    tools: () => tools,
  }
}

function fakeAdapter(): ModelAdapter {
  return {
    provider: 'fake',
    displayName: 'Fake',
    defaultModel: 'fake-model',
    isConfigured: () => true,
    capabilities: () => ['stream'],
    agentsSdkCapabilities: () => makeCapabilities(),
    chat: async () => ({ content: '{}' }),
    async *chatStream(messages) {
      if (messages.some(message => message.role === 'tool')) {
        yield { content: '工具已执行。', finishReason: 'stop' }
        return
      }
      yield {
        toolCalls: [{ id: 'call_1', index: 0, name: 'sensitive_tool', arguments: '{"value":1}' }],
        finishReason: 'tool_calls',
      }
    },
  }
}

function noOpDb(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}

function testEnv(): Env {
  return {
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    DATABASE_URL: 'postgres://unused',
    RUNTIME_ROOT: 'runtime',
    ENABLED_TOOL_PROVIDERS: '',
  }
}
