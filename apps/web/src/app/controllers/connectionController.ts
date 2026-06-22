// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连接控制器
//
//   文件:       connectionController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { startTransition, useCallback, useState } from 'react'
import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import { supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'

// 连接控制器持有模型 Provider 能力事实和当前用户编辑选择。
//
// 默认 session 获取函数也从这里暴露，AppShell 不直接依赖网络客户端。
export function useConnectionController() {
  const [providers, setProviders] = useState<ModelProviderDescriptor[]>([])
  const [provider, setProvider] = useState('openai_compatible')
  const [model, setModel] = useState('')

  const applyProviders = useCallback((providerList: ModelProviderDescriptor[]) => {
    startTransition(() => {
      setProviders(providerList)
      const preferred =
        providerList.find(item => item.provider === 'openai_compatible' && supportsAgentSdkLiveSupervisor(item)) ??
        providerList.find(item => supportsAgentSdkLiveSupervisor(item)) ??
        providerList[0]
      if (preferred) {
        setProvider(preferred.provider)
        setModel(preferred.defaultModel ?? '')
      }
    })
  }, [])

  const changeProvider = useCallback((value: string) => {
    setProvider(value)
    const selected = providers.find(item => item.provider === value)
    setModel(selected?.defaultModel ?? '')
  }, [providers])

  return {
    applyProviders,
    changeProvider,
    model,
    provider,
    providers,
    setModel,
    setProvider,
  }
}
