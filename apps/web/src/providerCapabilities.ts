// +-------------------------------------------------------------------------
//
//   地理智能平台 - Provider 能力判定
//
//   文件:       providerCapabilities.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 收口前端对模型 provider 的可用性判断，使提交入口和配置界面共享
// 后端 registry 暴露的 Agents SDK 能力事实。

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'

export function supportsAgentSdkLiveSupervisor(provider?: ModelProviderDescriptor) {
  // 分析提交必须走后端声明的 Agents SDK live supervisor 主路径。
  //
  // configured 只代表 chat adapter 可用，不代表 agent loop / tools / approvals 可用。
  return Boolean(provider?.configured && provider.capabilities.includes('agents_sdk_live_supervisor'))
}

export function providerUnavailableLabel(provider: ModelProviderDescriptor) {
  // 下拉选项只显示事实状态，不替 provider 生成可用假象。
  if (!provider.configured) {
    return '（未配置）'
  }
  if (!supportsAgentSdkLiveSupervisor(provider)) {
    return '（非 SDK 主路径）'
  }
  return ''
}
