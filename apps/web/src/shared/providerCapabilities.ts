// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Provider 能力判定
//
//   文件:       providerCapabilities.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'

const LIVE_SUPERVISOR_CAPABILITIES = new Set([
  'agents_sdk_live_supervisor',
  'agents_sdk',
  'openai_agents',
  'chat_completions',
  'tool_calls',
  'streaming',
])

// Provider 描述来自系统状态接口，是前端判断可选模型的事实源。
//
// 这里只做显式能力解释：未配置的 provider 不可选；缺少能力标签时不猜测。
export function supportsAgentSdkLiveSupervisor(provider?: ModelProviderDescriptor | null): boolean {
  if (!provider?.configured) return false
  return provider.capabilities.some(capability => LIVE_SUPERVISOR_CAPABILITIES.has(capability))
}

export function providerUnavailableLabel(provider?: ModelProviderDescriptor | null): string {
  if (!provider) return '（不可用）'
  if (!provider.configured) return '（未配置）'
  if (!supportsAgentSdkLiveSupervisor(provider)) return '（不支持 Agent 运行时）'
  return ''
}
