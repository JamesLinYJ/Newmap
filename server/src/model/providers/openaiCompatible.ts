// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Compatible 适配器（标准 openai SDK）
//
//   文件:       openaiCompatible.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions'
import type { ModelAdapter, AgentsSdkCapabilities } from '../registry.js'
import { makeCapabilities } from '../registry.js'

export interface OpenAIOptions {
  baseUrl: string
  apiKey: string
  defaultModel: string
  subagentModel?: string
  displayName?: string
}

export function createOpenAIAdapter(opts: OpenAIOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const client = opts.apiKey ? new OpenAI({ baseURL: baseUrl, apiKey: opts.apiKey }) : null

  return {
    provider: 'openai_compatible',
    displayName: opts.displayName ?? 'OpenAI Compatible',
    defaultModel: opts.defaultModel,
    subagentModel: opts.subagentModel,
    contextWindowTokens: inferContextWindow(opts.defaultModel),

    isConfigured(): boolean {
      return Boolean(baseUrl && opts.apiKey && opts.defaultModel)
    },

    agentsSdkCapabilities(modelName?: string | null): AgentsSdkCapabilities {
      if (!this.isConfigured()) return makeCapabilities()
      const model = (modelName ?? opts.defaultModel ?? '').toLowerCase()
      const hasDeepseek = model.includes('deepseek')
      return makeCapabilities({
        liveSupervisor: true,
        structuredOutput: !hasDeepseek,
        jsonObjectOutput: hasDeepseek,
      })
    },

    capabilities: () => ['chat', 'structured', 'stream', 'repair_tool_json'],

    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!client) throw new Error('OpenAI Compatible provider 未配置 API key')
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]

      const request: ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: messages.map(m => toBasicMessage(m.role, m.content)),
        stream: false,
        ...(kwargs?.reasoning !== false ? { reasoning_effort: 'high' as const } : {}),
      }
      const completion = await client.chat.completions.create(request)

      const content = completion.choices[0]?.message?.content ?? ''
      return { provider: 'openai_compatible', content, raw: completion as unknown as Record<string, unknown>, model }
    },

    chatStream(messages, streamOpts) {
      if (!client) throw new Error('OpenAI Compatible provider 未配置 API key')
      const model = (streamOpts?.model as string | undefined) ?? opts.defaultModel
      const openaiTools = streamOpts?.tools?.map(t => ({
        type: 'function' as const,
        function: t.function,
      }))

      type StreamChunk = {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      const request: ChatCompletionCreateParamsStreaming = {
        model,
        messages: messages.map(toStreamMessage),
        tools: openaiTools,
        stream: true,
        stream_options: { include_usage: true },
        ...(streamOpts?.reasoning !== false ? { reasoning_effort: 'high' as const } : {}),
      }
      const streamPromise = client.chat.completions.create(request) as unknown as Promise<AsyncIterable<StreamChunk>>

      // 收集每个 tool_call 的 arguments 碎片，结束时自动判断拼接策略
      const acc: Map<number, { id: string; name: string; fragments: string[] }> = new Map()
      return (async function* () {
        const stream = await streamPromise
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta
          const finish = chunk.choices?.[0]?.finish_reason
          if (delta?.reasoning_content) yield { reasoningContent: delta.reasoning_content }
          if (delta?.content) yield { content: delta.content }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const cur = acc.get(idx) ?? { id: '', name: '', fragments: [] }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.name = tc.function.name
              if (tc.function?.arguments) cur.fragments.push(tc.function.arguments)
              acc.set(idx, cur)
            }
          }
          if (finish) {
            const toolCalls = acc.size > 0 ? [...acc.values()].map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: resolveArguments(tc.fragments),
              index: 0,
            })) : undefined
            yield { finishReason: finish, toolCalls }
          }
          if (chunk.usage) {
            yield {
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
                totalTokens: chunk.usage.total_tokens ?? 0,
              },
            }
          }
        }
      })()
    },
  }
}

function inferContextWindow(model: string): number {
  const normalized = model.toLowerCase()
  if (normalized.includes('gpt-4.1')) return 1_000_000
  if (normalized.includes('gpt-4o')) return 128_000
  if (normalized.includes('deepseek')) return 128_000
  return 128_000
}

// 通用 arguments 解析：兼容"增量拼接"（OpenAI）和"每帧完整覆盖"（DeepSeek 等兼容厂商）
export function resolveArguments(fragments: string[]): string {
  if (!fragments.length) return '{}'

  // 策略 A：拼接（OpenAI 风格 — 每帧是增量片段）
  const concatenated = fragments.join('')
  if (isValidJson(concatenated)) return concatenated

  // 策略 B：取最后一帧（DeepSeek 风格 — 每帧是完整 JSON）
  const last = fragments.at(-1) ?? '{}'
  if (isValidJson(last)) return last

  // 兜底：从后往前找第一个合法 JSON
  for (let i = fragments.length - 2; i >= 0; i--) {
    if (isValidJson(fragments[i])) return fragments[i]
  }

  // 损坏的工具参数必须交给运行时 JSON.parse 失败并终止本次调用。
  // 返回空对象会把模型/schema 错误伪装成一次合法工具请求。
  return concatenated
}

function isValidJson(value: string): boolean {
  try { JSON.parse(value); return true }
  catch { return false }
}

function toBasicMessage(role: string, content: string): ChatCompletionMessageParam {
  if (role === 'assistant') return { role: 'assistant', content }
  if (role === 'system') return { role: 'system', content }
  return { role: 'user', content }
}

function toStreamMessage(message: {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}): ChatCompletionMessageParam {
  if (message.role === 'tool') {
    if (!message.tool_call_id) throw new Error('tool message 缺少 tool_call_id')
    return { role: 'tool', content: message.content ?? '', tool_call_id: message.tool_call_id }
  }
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.content, tool_calls: message.tool_calls }
  }
  if (message.role === 'system') return { role: 'system', content: message.content ?? '' }
  return { role: 'user', content: message.content ?? '' }
}
