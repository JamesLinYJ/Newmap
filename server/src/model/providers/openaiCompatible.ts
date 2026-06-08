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
  const client = new OpenAI({ baseURL: baseUrl, apiKey: opts.apiKey })

  function baseUrlHostname(url: string): string {
    try { return new URL(url).hostname.toLowerCase() }
    catch { return url.toLowerCase() }
  }

  function isDeepseek(hostname: string): boolean {
    return hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')
  }

  return {
    provider: 'openai_compatible',
    displayName: opts.displayName ?? 'OpenAI Compatible',
    defaultModel: opts.defaultModel,
    subagentModel: opts.subagentModel,

    isConfigured(): boolean {
      return Boolean(baseUrl && opts.apiKey && opts.defaultModel)
    },

    agentsSdkCapabilities(modelName?: string | null): AgentsSdkCapabilities {
      if (!this.isConfigured()) return makeCapabilities()
      const hostname = baseUrlHostname(baseUrl)
      const model = (modelName ?? opts.defaultModel ?? '').toLowerCase()
      const isDs = isDeepseek(hostname) || model.includes('deepseek')
      const isOpenAi = hostname === 'api.openai.com'
      return makeCapabilities({
        liveSupervisor: true,
        structuredOutput: isOpenAi && !isDs,
        jsonObjectOutput: isDs,
      })
    },

    capabilities: () => ['chat', 'structured', 'stream', 'repair_tool_json'],

    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]

      const completion = await client.chat.completions.create({
        model,
        messages: messages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
        stream: false,
        ...(kwargs?.reasoning !== false ? { thinking: { type: 'enabled' as const }, reasoning_effort: 'high' } : {}),
      } as any)

      const content = completion.choices[0]?.message?.content ?? ''
      return { provider: 'openai_compatible', content, raw: completion as unknown as Record<string, unknown>, model }
    },

    chatStream(messages, streamOpts) {
      const model = (streamOpts?.model as string | undefined) ?? opts.defaultModel
      const openaiTools = streamOpts?.tools?.map(t => ({
        type: 'function' as const,
        function: t.function,
      }))

      type StreamChunk = { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> }
      const streamPromise = client.chat.completions.create({
        model,
        messages: messages.map(m => ({
          role: m.role as any, content: m.content ?? '',
          tool_calls: m.tool_calls as any, tool_call_id: m.tool_call_id as any,
        })),
        tools: openaiTools as any, stream: true,
        ...(streamOpts?.reasoning !== false ? { thinking: { type: 'enabled' as const }, reasoning_effort: 'high' } : {}),
      } as any) as unknown as Promise<AsyncIterable<StreamChunk>>

      const acc: Map<number, { id: string; name: string; arguments: string }> = new Map()
      return (async function* () {
        const stream = await streamPromise
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta
          const finish = chunk.choices?.[0]?.finish_reason
          if (delta?.content) yield { content: delta.content }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const cur = acc.get(idx) ?? { id: '', name: '', arguments: '' }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.name = tc.function.name
              if (tc.function?.arguments) cur.arguments += tc.function.arguments
              acc.set(idx, cur)
            }
          }
          if (finish) {
            const toolCalls = acc.size > 0 ? [...acc.values()].map(tc => ({ ...tc, index: 0 })) : undefined
            yield { finishReason: finish, toolCalls }
          }
        }
      })()
    },
  }
}
