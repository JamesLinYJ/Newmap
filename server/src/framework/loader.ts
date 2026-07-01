// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool Provider 显式加载器
//
//   文件:       loader.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { getEnv } from './env.js'
import { toolRegistry } from './registry.js'
import type { InstallContext, ToolProvider } from './types.js'
import type { PostGisRepository } from '../gis/postgis.js'
import chartProvider from '../tools/chart/index.js'
import geocodeProvider from '../tools/geocode/index.js'
import mediaProvider from '../tools/media/index.js'
import memoryProvider from '../tools/memory/index.js'
import planProvider from '../tools/plan/index.js'
import developerProvider from '../tools/developer/index.js'
import meteorologyProvider from '../tools/meteorology/index.js'
import { createSpatialProvider } from '../tools/spatial/index.js'
import { createRoutingProvider } from '../tools/routing/index.js'

const LEGACY_METEOROLOGY_PROVIDER_ID = ['wea', 'ther'].join('')

// 安装到仓库并不等于启用；只有 ENABLED_TOOL_PROVIDERS 中的精确 ID 会进入运行时。
export async function discoverAndLoad(postgis: PostGisRepository): Promise<void> {
  const env = getEnv()
  const spatialProvider = createSpatialProvider(postgis)
  const routingProvider = createRoutingProvider()
  const providers: ToolProvider[] = [
    chartProvider as ToolProvider,
    geocodeProvider as ToolProvider,
    mediaProvider as ToolProvider,
    memoryProvider as ToolProvider,
    planProvider as ToolProvider,
    developerProvider as ToolProvider,
    meteorologyProvider as ToolProvider,
    spatialProvider as ToolProvider,
    routingProvider as ToolProvider,
  ]
  const builtinProviders = new Map<string, ToolProvider>(
    providers.map(provider => [provider.manifest.id, provider]),
  )
  const enabledIds = env.ENABLED_TOOL_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean)
  const legacyMeteorologyId = enabledIds.find(providerId => providerId === LEGACY_METEOROLOGY_PROVIDER_ID)
  if (legacyMeteorologyId) {
    throw new Error(
      `ENABLED_TOOL_PROVIDERS 不再接受旧 Provider ID "${LEGACY_METEOROLOGY_PROVIDER_ID}"；请改用 "geo-platform-meteorology"，并运行 npm run reset:conversations 清理旧运行配置。`,
    )
  }
  const config = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === undefined ? undefined : String(value)]),
  )

  for (const providerId of enabledIds) {
    const provider = builtinProviders.get(providerId)
    if (!provider) {
      toolRegistry.markUnavailable(providerId, 'Provider 不在显式内置目录中')
      console.warn(`[loader] provider "${providerId}" 不可用：Provider 不在显式内置目录中`)
      continue
    }
    const missing = requiredDependencies(provider).filter(key => !config[key])
    if (missing.length) {
      const reason = `缺少依赖：${missing.join(', ')}`
      toolRegistry.markUnavailable(providerId, reason)
      console.warn(`[loader] provider "${providerId}" 不可用：${reason}`)
      continue
    }
    try {
      const ctx: InstallContext = {
        config,
        state: new Map(),
        log: (level, message) => console.log(`[${providerId}] ${level}: ${message}`),
      }
      await provider.onInstall?.(ctx)
      toolRegistry.register(provider)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toolRegistry.markUnavailable(providerId, reason)
      console.warn(`[loader] provider "${providerId}" 不可用：${reason}`)
    }
  }

  console.log(`[loader] 已启用 ${toolRegistry.listProviders().length} 个 provider, ${toolRegistry.list().length} 个 tool`)
}

function requiredDependencies(provider: ToolProvider): string[] {
  return Object.entries(provider.manifest.requires ?? {})
    .filter(([, level]) => level === 'required')
    .map(([key]) => key)
}
