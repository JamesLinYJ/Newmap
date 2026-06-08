// Ollama 模型适配器
import type { ModelAdapter, AgentsSdkCapabilities } from '../registry.js'
import { makeCapabilities } from '../registry.js'

export interface OllamaOptions { baseUrl: string; defaultModel: string; displayName?: string }

export function createOllamaAdapter(opts: OllamaOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  return {
    provider: 'ollama',
    displayName: opts.displayName ?? 'Ollama',
    defaultModel: opts.defaultModel,
    isConfigured: () => Boolean(baseUrl && opts.defaultModel),
    agentsSdkCapabilities: (): AgentsSdkCapabilities => makeCapabilities(),
    capabilities: () => ['chat'],
    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]
      const temperature = (kwargs?.temperature as number) ?? 0.1

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages, options: { temperature } }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`Ollama API error: ${res.status}`)
      const payload = (await res.json()) as Record<string, unknown>
      const message = payload.message as Record<string, unknown> | undefined
      return { provider: 'ollama', content: message?.content ?? '', raw: payload, model }
    },
  }
}
