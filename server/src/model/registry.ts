// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型适配器注册表
//
//   文件:       registry.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '../schemas/types.js'
import type { Env } from '../framework/env.js'
import type { Model } from '@openai/agents'
import { createOpenAIAdapter } from './providers/openaiCompatible.js'
import { createAnthropicAdapter } from './providers/anthropic.js'
import { createGeminiAdapter } from './providers/gemini.js'
import { createOllamaAdapter } from './providers/ollama.js'

export interface ModelAdapter {
  readonly provider: string
  readonly displayName: string
  readonly defaultModel: string | null
  readonly subagentModel?: string
  readonly contextWindowTokens?: number

  isConfigured(): boolean
  capabilities(): string[]
  createAgentModel?(modelName?: string | null): Model
  chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>>
}

// --- Registry ---

export class ModelAdapterRegistry {
  private adapters = new Map<string, ModelAdapter>()
  readonly defaultProvider: string
  readonly defaultModelName: string | null

  constructor(env: Env) {
    this.defaultProvider = env.DEFAULT_MODEL_PROVIDER ?? ''
    this.defaultModelName = env.DEFAULT_MODEL_NAME ?? null

    const dmf = (p: string) => env.DEFAULT_MODEL_PROVIDER === p ? (env.DEFAULT_MODEL_NAME ?? '') : ''

    this.register(createOpenAIAdapter({
      baseUrl: env.OPENAI_BASE_URL ?? '',
      apiKey: env.OPENAI_API_KEY ?? '',
      defaultModel: (env.OPENAI_MODEL ?? dmf('openai_compatible')),
      subagentModel: env.OPENAI_SUBAGENT_MODEL ?? undefined,
    }))
    this.register(createAnthropicAdapter({
      baseUrl: env.ANTHROPIC_BASE_URL ?? '',
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      defaultModel: (env.ANTHROPIC_MODEL ?? dmf('anthropic')),
      version: env.ANTHROPIC_VERSION ?? '',
    }))
    this.register(createGeminiAdapter({
      baseUrl: env.GEMINI_BASE_URL ?? '',
      apiKey: env.GEMINI_API_KEY ?? '',
      defaultModel: (env.GEMINI_MODEL ?? dmf('gemini')),
    }))
    this.register(createOllamaAdapter({
      baseUrl: env.OLLAMA_BASE_URL ?? '',
      defaultModel: (env.OLLAMA_MODEL ?? dmf('ollama')),
    }))
  }

  register(adapter: ModelAdapter): void {
    this.adapters.set(adapter.provider, adapter)
  }

  get(provider: string): ModelAdapter {
    const a = this.adapters.get(provider)
    if (!a) throw new Error(`未注册的 provider: ${provider}`)
    return a
  }

  resolveProvider(provider?: string | null): ModelAdapter {
    const selected = provider ?? this.defaultProvider
    if (!selected) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')
    const adapter = this.adapters.get(selected)
    if (!adapter) throw new Error(`未注册的模型 provider: ${selected}`)
    if (!adapter.isConfigured()) throw new Error(`模型 provider '${selected}' 尚未配置`)
    return adapter
  }

  providers(): string[] {
    return [...this.adapters.keys()].sort()
  }

  descriptors(): ModelProviderDescriptor[] {
    return [...this.adapters.values()].map(a => {
      const labels = a.createAgentModel
        ? ['agents_sdk_live_supervisor', 'agents_sdk_chat_completions']
        : []

      return {
        provider: a.provider,
        displayName: a.displayName,
        configured: a.isConfigured(),
        defaultModel: a.defaultModel,
        capabilities: [...a.capabilities(), ...labels],
        contextWindowTokens: a.contextWindowTokens ?? inferContextWindow(a.defaultModel),
      }
    })
  }
}

function inferContextWindow(model: string | null): number {
  const normalized = (model ?? '').toLowerCase()
  if (normalized.includes('gemini-2.5')) return 1_000_000
  if (normalized.includes('claude')) return 200_000
  return 128_000
}
