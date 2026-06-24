// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行时契约测试
//
//   文件:       runtime.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import type { Env } from '../framework/env.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolDef, ToolProvider, ToolResult, ValueRef } from '../framework/types.js'
import { ModelAdapterRegistry, type ModelAdapter } from '../model/registry.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { OpenAIAgentsRuntime } from './runtime.js'

describe('OpenAIAgentsRuntime delivery boundaries', () => {
  it('rebuilds the visible transcript after restart and sends the current user message once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-continuation-'))
    try {
      const requests: ModelRequest[] = []
      let responseNumber = 0
      const model = scriptedModel(request => {
        requests.push(request)
        responseNumber += 1
        return { text: responseNumber === 1 ? '项目代号是西湖。' : '我记得，项目代号是西湖。' }
      })
      const models = registryWith(fakeAdapter(model))
      const firstStore = new PostgresPlatformStore(noOpDb(), root)
      await firstStore.initialize()
      const session = await firstStore.createSession()
      const thread = await firstStore.createThread(session.id, '连续对话')
      const firstRun = await firstStore.createRun(session.id, '记住项目代号是西湖', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await new OpenAIAgentsRuntime(firstStore, new ToolRegistry(), models).run(runOptions(firstRun, thread.id))
      await firstStore.conversationStore.flush()

      const restoredStore = new PostgresPlatformStore(noOpDb(), root)
      await restoredStore.initialize()
      const secondRun = await restoredStore.createRun(session.id, '刚才的项目代号是什么？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await new OpenAIAgentsRuntime(restoredStore, new ToolRegistry(), models).run(runOptions(secondRun, thread.id))

      const secondTexts = requestTexts(requests[1])
      expect(secondTexts).toContain('记住项目代号是西湖')
      expect(secondTexts).toContain('项目代号是西湖。')
      expect(secondTexts.filter(text => text === secondRun.userQuery)).toHaveLength(1)
      const transcript = await restoredStore.activeTranscript(thread.id)
      const assistantEntries = transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'assistant')
      expect(assistantEntries.map(entry => entry.payload.content)).toEqual([
        '项目代号是西湖。',
        '我记得，项目代号是西湖。',
      ])
      const secondItems = await restoredStore.listItems(secondRun.id)
      expect(secondItems.filter(item => item.role === 'assistant' && item.body === '我记得，项目代号是西湖。'))
        .toHaveLength(1)
      expect(secondItems.find(item => item.body === '我记得，项目代号是西湖。')?.metadata.transcriptEntryId)
        .toBe(assistantEntries[1].entryId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists an SDK approval interruption and resumes it once after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-approval-'))
    try {
      const store = new PostgresPlatformStore(noOpDb(), root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '审批测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['sensitive_tool']
      const run = await store.createRun(session.id, '执行敏感工具', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(approvalProvider(() => { executions += 1 }))
      const model = scriptedModel(request => hasToolResult(request)
        ? { text: '工具已执行。' }
        : { toolCalls: [{ id: 'call_1', name: 'sensitive_tool', arguments: '{"value":1}' }] })
      const models = registryWith(fakeAdapter(model))

      const waiting = await new OpenAIAgentsRuntime(store, tools, models).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })
      expect(waiting.status).toBe('waiting_approval')
      expect(executions).toBe(0)
      expect(waiting.state.approvals).toHaveLength(1)
      await store.conversationStore.flush()

      const restoredStore = new PostgresPlatformStore(noOpDb(), root)
      await restoredStore.initialize()
      const completed = await new OpenAIAgentsRuntime(restoredStore, tools, models)
        .resolveApproval(run.id, waiting.state.approvals[0].approvalId, true)

      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(completed.state.approvals[0].payload.consumed).toBe(true)
      const transcript = await restoredStore.activeTranscript(thread.id)
      expect(transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'user')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_call')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_result')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries a replay-safe model disconnect before the first semantic event', async () => {
    let attempts = 0
    const result = await executeTextRun(scriptedModel(() => {
      attempts += 1
      if (attempts === 1) throw new ReplaySafeTestError('terminated')
      return { text: '连接恢复后的回答。' }
    }))
    expect(attempts).toBe(2)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.body === '连接恢复后的回答。')).toBe(true)
  })

  it('persists the concrete model error after the only safe retry also fails', async () => {
    const result = await executeTextRun(scriptedModel(() => {
      throw new ReplaySafeTestError('terminated')
    }))
    expect(result.run.status).toBe('failed')
    expect(result.run.state.errors[0]).toContain('terminated')
    expect(result.items.at(-1)?.metadata.message).toContain('terminated')
  })

  it('keeps normal tool preambles out of reasoning and delivers terminal tool output', async () => {
    let turns = 0
    const tools = new ToolRegistry()
    tools.register(nowcastAnswerProvider())
    const model = scriptedModel(() => {
      turns += 1
      return {
        text: '我先分析一下。',
        toolCalls: [{ id: 'answer_call', name: 'answer_nowcast_question', arguments: '{"question":"市民中心天气怎么样？"}' }],
      }
    })
    const result = await executeTextRun(model, tools)
    expect(turns).toBe(1)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.itemType === 'reasoning' && item.body === '我先分析一下。')).toBe(false)
    expect(result.items.some(item => item.itemType === 'message' && item.body === '我先分析一下。')).toBe(true)
    expect(result.items.some(item => item.itemType === 'message' && item.body === '未来3小时不会下雨，您可以放心出门。')).toBe(true)
    const preambleIndex = result.items.findIndex(item => item.itemType === 'message' && item.body === '我先分析一下。')
    const toolIndex = result.items.findIndex(item => item.itemType === 'function_call' && item.name === 'answer_nowcast_question')
    const finalIndex = result.items.findIndex(item => item.itemType === 'message' && item.body === '未来3小时不会下雨，您可以放心出门。')
    expect(preambleIndex).toBeLessThan(toolIndex)
    expect(toolIndex).toBeLessThan(finalIndex)
    const transcriptToolIndex = result.transcript.findIndex(entry => entry.kind === 'tool_call' && entry.payload.name === 'answer_nowcast_question')
    const transcriptPreambleIndex = result.transcript.findIndex(entry => (
      entry.kind === 'checkpoint'
      && entry.payload.type === 'assistant_content_for_tool_call'
      && entry.payload.callId === 'answer_call'
    ))
    const transcriptResultIndex = result.transcript.findIndex(entry => entry.kind === 'tool_result' && entry.payload.name === 'answer_nowcast_question')
    const transcriptFinalIndex = result.transcript.findIndex(entry => entry.kind === 'message' && entry.payload.content === '未来3小时不会下雨，您可以放心出门。')
    expect(result.transcript[transcriptPreambleIndex].payload.content).toBe('我先分析一下。')
    expect(transcriptToolIndex).toBeLessThan(transcriptResultIndex)
    expect(transcriptToolIndex).toBeLessThan(transcriptPreambleIndex)
    expect(transcriptResultIndex).toBeLessThan(transcriptFinalIndex)
  })

  it('keeps provider reasoning UI-only while completing a tool continuation', async () => {
    const tools = new ToolRegistry()
    tools.register(providerFromTools('reasoning-replay-test', [{
      ...toolDefinition('lookup_context', ['query']),
      handler: async () => result('lookup', [], { ok: true }),
    }]))
    let turns = 0
    let secondTurnInput: unknown[] = []
    const model = scriptedModel(request => {
      turns += 1
      if (hasToolResult(request)) {
        secondTurnInput = Array.isArray(request.input) ? request.input : []
        return { text: '工具后总结。' }
      }
      return {
        reasoning: '这里是 provider reasoning，只能用于 UI 折叠区。',
        text: '我先查询上下文。',
        toolCalls: [{ id: 'call_lookup', name: 'lookup_context', arguments: '{"query":"杭州"}' }],
      }
    })

    const outcome = await executeTextRun(model, tools)

    expect(outcome.run.status).toBe('completed')
    expect(turns).toBe(2)
    // Agents SDK 会把 reasoning 带到同一 run 的下一次 Model 请求；Chat Completions
    // 的不可重放边界在 CompatibleChatCompletionsModel 中统一执行。
    expect(secondTurnInput.some(item => isRecord(item) && item.type === 'reasoning')).toBe(true)
    expect(outcome.items.some(item => item.itemType === 'reasoning' && item.body?.includes('provider reasoning'))).toBe(true)
    expect(outcome.items.some(item => item.itemType === 'message' && item.body === '工具后总结。')).toBe(true)
  })

  it('runs configured subagents as Agent tools with inherited model and persisted transcript', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-'))
    try {
      const store = new PostgresPlatformStore(noOpDb(), root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子 Agent 测试')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'spatial_analyst',
        name: '空间分析助手',
        role: 'spatial_analyst',
        summary: '执行空间分析',
        systemPrompt: '你是空间子智能体。',
        model: null,
        tools: ['query_layer'],
      }]
      const tools = new ToolRegistry()
      tools.register(providerFromTools('subagent-tools', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => result('query', [], { rows: [] }),
      }]))
      let subAgentCalls = 0
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('空间子智能体')) {
          subAgentCalls += 1
          return { text: '子分析完成。' }
        }
        if (hasToolResult(request)) return { text: '主智能体已汇总子分析。' }
        return { toolCalls: [{ id: 'sub_call_1', name: 'spatial_analyst', arguments: '{"input":"分析当前图层"}' }] }
      })
      const run = await store.createRun(session.id, '请分析当前图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const completed = await new OpenAIAgentsRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id), runtimeConfig: config,
      })
      await store.conversationStore.flush()

      expect(completed.status).toBe('completed')
      expect(subAgentCalls).toBe(1)
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'spatial_analyst', status: 'completed',
      }))
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript.some(entry => entry.kind === 'tool_call' && entry.payload.name === 'spatial_analyst')).toBe(true)
      expect(transcript.some(entry => entry.kind === 'tool_result' && entry.payload.name === 'spatial_analyst')).toBe(true)
      const agentLog = await readFile(path.join(
        root, 'sessions', session.id, 'threads', thread.id,
        'runs', run.id, 'agents', 'spatial_analyst', 'transcript.jsonl',
      ), 'utf8')
      expect(agentLog).toContain('completed_item')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores previous run valueRefs for continuous thread tool calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-thread-values-'))
    try {
      const store = new PostgresPlatformStore(noOpDb(), root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '连续 valueRef 测试')
      const tools = new ToolRegistry()
      tools.register(providerFromTools('thread-value-test', [{
        ...toolDefinition('use_dataset_ref', ['dataset_ref']),
        jsonSchema: {
          type: 'object',
          properties: {
            dataset_ref: {
              type: 'string',
              description: '必须使用 valueRef ID',
              'x-source': 'value_ref',
              'x-value-ref-kinds': ['meteorological_dataset'],
            },
          },
          required: ['dataset_ref'],
        },
        handler: async (_args, context) => {
          const ref = context.resolveValueRef('ref_prior_dataset')
          return result('reuse', [], { reusedKind: ref.kind })
        },
      }]))
      const firstRun = await store.createRun(session.id, '先检查数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await store.updateRunState(firstRun.id, {
        toolValueRefs: [{
          refId: 'ref_prior_dataset',
          kind: 'meteorological_dataset',
          label: '上一轮数据集',
          value: { name: 'rain.nc', relativePath: 'objects/sha256/aa/rain.nc' },
          metadata: {},
          sourceTool: 'inspect_meteorological_dataset',
          sourceResultId: 'result_prior',
          createdAt: new Date().toISOString(),
          unit: null,
        }],
      })
      await store.completeRun(firstRun.id, 'completed')
      const secondRun = await store.createRun(session.id, '继续使用上一轮数据集', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let turns = 0
      const model = scriptedModel(request => {
        turns += 1
        if (hasToolResult(request)) return { text: '已经复用上一轮数据集。' }
        return { toolCalls: [{ id: 'call_reuse', name: 'use_dataset_ref', arguments: '{"dataset_ref":"ref_prior_dataset"}' }] }
      })

      const completed = await new OpenAIAgentsRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(secondRun, thread.id))

      expect(completed.status).toBe('completed')
      expect(turns).toBe(2)
      expect(completed.state.toolResults[0]).toMatchObject({
        tool: 'use_dataset_ref',
        status: 'completed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
      const model = scriptedModel(() => { modelCalls += 1; return { text: '不应调用模型。' } })
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '接下来天气怎么样？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const completed = await new OpenAIAgentsRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id), runtimeConfig: config,
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

interface ScriptedResponse {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
}

function scriptedModel(script: (request: ModelRequest) => ScriptedResponse): Model {
  return {
    getRetryAdvice: ({ error }) => error instanceof ReplaySafeTestError
      ? { suggested: true, replaySafety: 'safe', normalized: { isNetworkError: true } }
      : undefined,
    async getResponse(request): Promise<ModelResponse> {
      const response = script(request)
      return { usage: new Usage(), output: outputItems(response, makeIdForResponse()), responseId: makeIdForResponse() }
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      const response = script(request)
      const responseId = makeIdForResponse()
      yield { type: 'response_started' }
      if (response.reasoning) {
        yield {
          type: 'model',
          event: { choices: [{ index: 0, delta: { reasoning_content: response.reasoning } }] },
        }
      }
      if (response.text) yield { type: 'output_text_delta', delta: response.text }
      yield {
        type: 'response_done',
        response: {
          id: responseId,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: outputItems(response, responseId),
        },
      }
    },
  }
}

class ReplaySafeTestError extends Error {}

let responseSequence = 0
function makeIdForResponse(): string {
  responseSequence += 1
  return `response_${responseSequence}`
}

function outputItems(response: ScriptedResponse, responseId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  if (response.reasoning) output.push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: response.reasoning }] })
  if (response.text) {
    output.push({
      id: responseId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: response.text }],
    })
  }
  for (const call of response.toolCalls ?? []) {
    output.push({
      id: responseId, type: 'function_call', status: 'completed',
      callId: call.id, name: call.name, arguments: call.arguments,
    })
  }
  return output
}

async function executeTextRun(model: Model, tools = new ToolRegistry()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-stream-'))
  try {
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '模型流测试')
    const run = await store.createRun(session.id, '回答测试问题', {
      threadId: thread.id,
      modelProvider: 'fake',
      runtimeConfigSnapshot: testRuntimeConfig(),
    })
    const completed = await new OpenAIAgentsRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(run, thread.id))
    await store.conversationStore.flush()
    return {
      run: structuredClone(completed),
      items: structuredClone(await store.listItems(run.id)),
      transcript: structuredClone(await store.activeTranscript(thread.id)),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fakeAdapter(model: Model): ModelAdapter {
  return {
    provider: 'fake',
    displayName: 'Fake',
    defaultModel: 'fake-model',
    contextWindowTokens: 128_000,
    isConfigured: () => true,
    capabilities: () => ['chat', 'stream'],
    createAgentModel: () => model,
    chat: async () => ({ content: '{}' }),
  }
}

function registryWith(adapter: ModelAdapter): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry(testEnv())
  registry.register(adapter)
  return registry
}

function runOptions(run: { id: string; sessionId: string; userQuery: string }, threadId: string) {
  return {
    runId: run.id,
    threadId,
    sessionId: run.sessionId,
    query: run.userQuery,
    provider: 'fake',
    runtimeConfig: testRuntimeConfig(),
  }
}

function requestTexts(request: ModelRequest): string[] {
  if (typeof request.input === 'string') return [request.input]
  return request.input.flatMap(item => {
    if (!('role' in item)) return []
    if (typeof item.content === 'string') return [item.content]
    return item.content.flatMap(part => 'text' in part && typeof part.text === 'string' ? [part.text] : [])
  })
}

function hasToolResult(request: ModelRequest): boolean {
  return Array.isArray(request.input) && request.input.some(item => item.type === 'function_call_result')
}

function approvalProvider(onExecute: () => void): ToolProvider {
  const definition = toolDefinition('sensitive_tool', ['value'])
  return providerFromTools('approval-test-provider', [{
    ...definition,
    jsonSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    handler: async () => {
      onExecute()
      return result('sensitive', [], { ok: true })
    },
  }])
}

function nowcastAnswerProvider(): ToolProvider {
  const definition = toolDefinition('answer_nowcast_question', ['question'])
  return providerFromTools('nowcast-answer-test', [{
    ...definition,
    handler: async () => result('answer', [], { answer: '未来3小时不会下雨，您可以放心出门。' }),
  }])
}

function deterministicNowcastProvider(calls: string[]): ToolProvider {
  const tool = (name: string, required: string[], handler: ToolDef['handler']): ToolDef => ({
    ...toolDefinition(name, required),
    handler: async (args, context) => { calls.push(name); return handler(args, context) },
  })
  const ref = (refId: string, kind: string, value: unknown): ValueRef => ({ refId, kind, label: kind, value })
  return providerFromTools('deterministic-nowcast-test', [
    tool('list_meteorological_files', [], async () => result('list', [
      ref('ref_collection', 'meteorological_file_collection', { files: [{ name: 'a.nc' }, { name: 'b.nc' }] }),
    ])),
    tool('create_nowcast_sequence', ['file_collection_ref'], async () => result('sequence', [ref('ref_sequence', 'nowcast_sequence', {})])),
    tool('prepare_hangzhou_nowcast_scope', ['question'], async () => result('scope', [ref('ref_scope', 'nowcast_area', {})])),
    tool('analyze_nowcast_precipitation', ['sequence_ref', 'scope_ref'], async () => result('analysis', [ref('ref_analysis', 'nowcast_analysis', {})])),
    tool('answer_nowcast_question', ['nowcast_analysis_ref', 'question'], async () => result('answer', [
      ref('ref_answer', 'nowcast_answer', { answer: '未来三小时不会下雨。' }),
    ], { answer: '未来三小时不会下雨。' })),
  ])
}

function toolDefinition(name: string, required: string[]): Omit<ToolDef, 'handler'> {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])),
      required,
    },
  }
}

function providerFromTools(id: string, tools: ToolDef[]): ToolProvider {
  return {
    manifest: {
      id, name: id, version: '1.0.0', author: 'test', language: 'typescript', description: id,
      tools: tools.map(({ handler: _handler, ...definition }) => definition),
    },
    tools: () => tools,
  }
}

function result(name: string, valueRefs: ValueRef[], payload: Record<string, unknown> = {}): ToolResult {
  return {
    message: `${name} completed`, payload, warnings: [], resultId: `result_${name}`, source: 'test', valueRefs,
  }
}

function noOpDb(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}

function testEnv(): Env {
  return {
    API_HOST: '127.0.0.1', API_PORT: 0, DATABASE_URL: 'postgres://unused',
    RUNTIME_ROOT: 'runtime', ENABLED_TOOL_PROVIDERS: '',
  }
}

function testRuntimeConfig() {
  const config = defaultRuntimeConfig()
  config.subAgents = []
  return config
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
