// Anthropic 模型适配器
import type { ModelAdapter, AgentsSdkCapabilities } from '../registry.js'
import { makeCapabilities } from '../registry.js'

export interface AnthropicOptions {
  baseUrl: string; apiKey: string; defaultModel: string; version: string; displayName?: string
}

export function createAnthropicAdapter(opts: AnthropicOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  return {
    provider: 'anthropic',
    displayName: opts.displayName ?? 'Anthropic',
    defaultModel: opts.defaultModel,
    isConfigured: () => Boolean(opts.apiKey && opts.defaultModel),
    agentsSdkCapabilities: (): AgentsSdkCapabilities => makeCapabilities(),
    capabilities: () => ['chat', 'structured'],
    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const system = kwargs?.system as string | undefined
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]
      const maxTokens = (kwargs?.max_tokens as number) ?? 1200

      const body: Record<string, unknown> = {
        model, max_tokens: maxTokens,
        messages: messages.map(m => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
      }
      if (system) body.system = system

      const res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': opts.apiKey, 'anthropic-version': opts.version, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`)
      const payload = (await res.json()) as Record<string, unknown>
      const content = ((payload.content as Array<{ type: string; text?: string }>) ?? [])
        .filter(i => i.type === 'text').map(i => i.text ?? '').join('\n').trim()
      return { provider: 'anthropic', content, raw: payload, model }
    },
  }
}
