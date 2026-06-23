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
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions'
import type { ModelAdapter } from '../registry.js'
import { CompatibleChatCompletionsModel } from '../compatibleChatCompletionsModel.js'

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

    createAgentModel(modelName?: string | null) {
      if (!client) throw new Error('OpenAI Compatible provider 未配置 API key')
      const model = modelName ?? opts.defaultModel
      if (!model) throw new Error('OpenAI Compatible provider 未配置模型名称')
      return new CompatibleChatCompletionsModel({ client, model })
    },

    capabilities: () => ['chat', 'structured', 'stream', 'chat_completions'],

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

  }
}

function inferContextWindow(model: string): number {
  const normalized = model.toLowerCase()
  if (normalized.includes('gpt-4.1')) return 1_000_000
  if (normalized.includes('gpt-4o')) return 128_000
  if (normalized.includes('deepseek')) return 128_000
  return 128_000
}

function toBasicMessage(role: string, content: string): ChatCompletionMessageParam {
  if (role === 'assistant') return { role: 'assistant', content }
  if (role === 'system') return { role: 'system', content }
  return { role: 'user', content }
}
