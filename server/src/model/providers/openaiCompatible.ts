// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Compatible 适配器
//
//   文件:       openaiCompatible.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ModelAdapter, AgentsSdkCapabilities } from '../registry.js'
import { makeCapabilities } from '../registry.js'

export interface OpenAIOptions {
  baseUrl: string
  apiKey: string
  defaultModel: string
  subagentModel?: string
  displayName?: string
  requestTimeout?: number
}

export function createOpenAIAdapter(opts: OpenAIOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const requestTimeout = opts.requestTimeout ?? 30_000

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
      const temperature = (kwargs?.temperature as number) ?? 0.1

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature }),
        signal: AbortSignal.timeout(requestTimeout),
      })

      if (!response.ok) {
        throw new Error(`OpenAI Compatible API error: ${response.status}`)
      }

      const payload = (await response.json()) as Record<string, unknown>
      const choices = payload.choices as Array<Record<string, unknown>>
      const content = (choices?.[0]?.message as Record<string, unknown>)?.content ?? ''

      return { provider: this.provider, content, raw: payload, model }
    },
  }
}
