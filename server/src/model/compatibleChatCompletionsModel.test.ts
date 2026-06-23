// +-------------------------------------------------------------------------
//
//   地理智能平台 - Chat Completions SDK Model 契约测试
//
//   文件:       compatibleChatCompletionsModel.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ModelRequest, ResponseStreamEvent } from '@openai/agents'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { CompatibleChatCompletionsModel, mergeDeltaOrSnapshot } from './compatibleChatCompletionsModel.js'

describe('CompatibleChatCompletionsModel', () => {
  it('normalizes standard text and DeepSeek reasoning streams', async () => {
    const model = createModel([
      chunk({ reasoning_content: '先分析' }),
      chunk({ content: '答案' }, 'stop', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
    ])

    const events = await collect(model.getStreamedResponse(request()))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')

    expect(events.some(event => event.type === 'output_text_delta' && event.delta === '答案')).toBe(true)
    expect(done?.response.output).toContainEqual({
      type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '先分析' }],
    })
    expect(done?.response.usage.totalTokens).toBe(5)
  })

  it('accepts both incremental and full-snapshot tool argument frames', async () => {
    const model = createModel([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_layer', arguments: '{"layer"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"layer":"roads"}' } }] }, 'tool_calls'),
    ])

    const events = await collect(model.getStreamedResponse(request()))
    const done = events.find((event): event is Extract<ResponseStreamEvent, { type: 'response_done' }> => event.type === 'response_done')
    expect(done?.response.output).toContainEqual(expect.objectContaining({
      type: 'function_call', callId: 'call_1', name: 'query_layer', arguments: '{"layer":"roads"}',
    }))
    expect(mergeDeltaOrSnapshot('{"a"', ':1}')).toBe('{"a":1}')
  })

  it('fails malformed tool arguments instead of manufacturing an empty object', async () => {
    const model = createModel([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_layer', arguments: '{bad' } }] }, 'tool_calls'),
    ])
    await expect(collect(model.getStreamedResponse(request()))).rejects.toThrow(/JSON/u)
  })

  it('rejects Responses-only state', async () => {
    const model = createModel([])
    await expect(collect(model.getStreamedResponse(request({ conversationId: 'conv_1' })))).rejects.toThrow(/conversationId/u)
  })

  // 历史 reasoning 只属于 UI/replay 诊断，不得变成 Chat Completions 的空 assistant 消息。
  it('drops reasoning-only history when serializing Chat Completions messages', async () => {
    let observedMessages: unknown[] = []
    const client = {
      chat: {
        completions: {
          create: async (params: { messages: unknown[] }) => {
            observedMessages = params.messages
            return (async function* () {
              yield chunk({ content: '继续回答' }, 'stop')
            })()
          },
        },
      },
    } as unknown as OpenAI
    const model = new CompatibleChatCompletionsModel({ client, model: 'test-model' })

    await collect(model.getStreamedResponse(request({
      input: [
        { type: 'message', role: 'user', content: '上一轮问题' },
        { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '内部推理，不进模型历史' }] },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '上一轮可见回答' }],
        },
      ],
    })))

    expect(observedMessages).toEqual([
      { role: 'user', content: '上一轮问题' },
      { role: 'assistant', content: '上一轮可见回答' },
    ])
  })

  // 兼容服务常先发送只有 role/id 的帧；此时断线尚未产生语义输出，允许 Runner 安全重试一次。
  it('keeps role-only frames invisible so a pre-semantic network failure is replay-safe', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => (async function* () {
            yield chunk({ role: 'assistant' })
            throw new Error('terminated')
          })(),
        },
      },
    } as unknown as OpenAI
    const model = new CompatibleChatCompletionsModel({ client, model: 'test-model' })
    const modelRequest = request()
    const events: ResponseStreamEvent[] = []
    let failure: unknown
    try {
      for await (const event of model.getStreamedResponse(modelRequest)) events.push(event)
    } catch (error) {
      failure = error
    }

    expect(events).toEqual([])
    expect(model.getRetryAdvice({ request: modelRequest, error: failure, stream: true, attempt: 1 }))
      .toMatchObject({ suggested: true, replaySafety: 'safe' })
  })
})

function createModel(chunks: unknown[]) {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          for (const value of chunks) yield value
        })(),
      },
    },
  } as unknown as OpenAI
  return new CompatibleChatCompletionsModel({ client, model: 'test-model' })
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    input: [{ role: 'user', content: '测试' }],
    modelSettings: { parallelToolCalls: false },
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
    ...overrides,
  }
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, number>,
) {
  return {
    id: 'response_1',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

async function collect(stream: AsyncIterable<ResponseStreamEvent>): Promise<ResponseStreamEvent[]> {
  const events: ResponseStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
