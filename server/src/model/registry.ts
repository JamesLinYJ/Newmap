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
import { createOpenAIAdapter } from './providers/openaiCompatible.js'
import { createAnthropicAdapter } from './providers/anthropic.js'
import { createGeminiAdapter } from './providers/gemini.js'
import { createOllamaAdapter } from './providers/ollama.js'

// --- Types ---

export interface AgentsSdkCapabilities {
  liveSupervisor: boolean
  structuredOutput: boolean
  jsonObjectOutput: boolean
}

export function makeCapabilities(overrides: Partial<AgentsSdkCapabilities> = {}): AgentsSdkCapabilities {
  return {
    liveSupervisor: overrides.liveSupervisor ?? false,
    structuredOutput: overrides.structuredOutput ?? false,
    jsonObjectOutput: overrides.jsonObjectOutput ?? false,
  }
}

export interface ChatStreamDelta {
  content?: string
  toolCalls?: Array<{ id: string; index: number; name: string; arguments: string }>
  finishReason?: string
}

export interface ModelAdapter {
  readonly provider: string
  readonly displayName: string
  readonly defaultModel: string | null
  readonly subagentModel?: string

  isConfigured(): boolean
  capabilities(): string[]
  agentsSdkCapabilities(modelName?: string | null): AgentsSdkCapabilities
  chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>>
  chatStream?(messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string }>, opts?: { model?: string; reasoning?: boolean; tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> }): AsyncIterable<ChatStreamDelta>
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
    const configured = [...this.adapters.values()].filter(a => a.isConfigured())
    const selected = provider ?? this.defaultProvider

    if (selected && this.adapters.has(selected)) {
      const a = this.adapters.get(selected)!
      if (a.isConfigured()) return a
      throw new Error(`模型 provider '${selected}' 尚未配置`)
    }

    if (this.defaultProvider && this.adapters.has(this.defaultProvider)) {
      const a = this.adapters.get(this.defaultProvider)!
      if (a.isConfigured()) return a
    }

    if (configured.length > 0) return configured[0]

    throw new Error('当前没有可用的模型 provider')
  }

  providers(): string[] {
    return [...this.adapters.keys()].sort()
  }

  descriptors(): ModelProviderDescriptor[] {
    return [...this.adapters.values()].map(a => {
      const caps = a.agentsSdkCapabilities(a.defaultModel)
      const labels: string[] = []
      if (caps.liveSupervisor) labels.push('agents_sdk_live_supervisor')
      if (caps.structuredOutput) labels.push('agents_sdk_structured_output')
      if (caps.jsonObjectOutput) labels.push('agents_sdk_json_object_output')

      return {
        provider: a.provider,
        displayName: a.displayName,
        configured: a.isConfigured(),
        defaultModel: a.defaultModel,
        capabilities: [...a.capabilities(), ...labels],
      }
    })
  }
}
