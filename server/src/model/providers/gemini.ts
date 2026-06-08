// Gemini 模型适配器
import type { ModelAdapter, AgentsSdkCapabilities } from '../registry.js'
import { makeCapabilities } from '../registry.js'

export interface GeminiOptions { baseUrl: string; apiKey: string; defaultModel: string; displayName?: string }

export function createGeminiAdapter(opts: GeminiOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  return {
    provider: 'gemini',
    displayName: opts.displayName ?? 'Gemini',
    defaultModel: opts.defaultModel,
    isConfigured: () => Boolean(opts.apiKey && opts.defaultModel),
    agentsSdkCapabilities: (): AgentsSdkCapabilities => makeCapabilities(),
    capabilities: () => ['chat', 'structured'],
    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]
      const temperature = (kwargs?.temperature as number) ?? 0.1
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

      const url = `${baseUrl}/models/${model}:generateContent?key=${opts.apiKey}`
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { temperature } }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Gemini API error: ${res.status}`)
      const payload = (await res.json()) as Record<string, unknown>
      const candidates = (payload.candidates as Array<Record<string, unknown>>) ?? []
      const parts = (candidates[0]?.content as Record<string, unknown>)?.parts as Array<{ text?: string }> | undefined
      const content = (parts ?? []).filter(p => 'text' in p).map(p => p.text ?? '').join('\n').trim()
      return { provider: 'gemini', content, raw: payload, model }
    },
  }
}
