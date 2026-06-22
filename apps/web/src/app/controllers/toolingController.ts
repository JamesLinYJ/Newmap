// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具与运行时配置控制器
//
//   文件:       toolingController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { startTransition, useCallback, useEffect, useState } from 'react'
import type {
  AgentRuntimeConfig,
  SystemComponentsStatus,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'
import {
  deleteToolCatalogEntry,
  getRuntimeConfig,
  listToolCatalogEntries,
  listTools,
  runTool,
  updateRuntimeConfig,
  upsertToolCatalogEntry,
} from '../../api/client'
import { getSystemComponents } from '../../api/client'
import { formatUiError } from '../bootstrap'

interface ToolingControllerOptions {
  loadDiagnostics: boolean
  setUiError: (error?: string) => void
}

// 工具控制器持有工具目录、运行时配置和调试状态。
//
// 各事实源独立吸收，单个持久化组件失败不会清空已经成功加载的工具描述。
export function useToolingController({ loadDiagnostics, setUiError }: ToolingControllerOptions) {
  const [availableTools, setAvailableTools] = useState<ToolDescriptor[]>([])
  const [toolCatalogEntries, setToolCatalogEntries] = useState<Array<Record<string, unknown>>>([])
  const [runtimeConfig, setRuntimeConfig] = useState<AgentRuntimeConfig>()
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [toolRunResult, setToolRunResult] = useState<Record<string, unknown> | null>(null)
  const [isToolSubmitting, setIsToolSubmitting] = useState(false)
  const [isToolCatalogSubmitting, setIsToolCatalogSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    const [components, tools, catalogEntries, loadedRuntimeConfig] = await Promise.allSettled([
      getSystemComponents(),
      listTools(),
      listToolCatalogEntries(),
      getRuntimeConfig(),
    ])
    startTransition(() => {
      if (components.status === 'fulfilled') setSystemComponents(components.value)
      if (tools.status === 'fulfilled') setAvailableTools(tools.value ?? [])
      if (catalogEntries.status === 'fulfilled') setToolCatalogEntries(catalogEntries.value ?? [])
      if (loadedRuntimeConfig.status === 'fulfilled') setRuntimeConfig(loadedRuntimeConfig.value)
    })
    const rejected = [components, tools, catalogEntries, loadedRuntimeConfig].find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }, [])

  useEffect(() => {
    // 工具、配置和系统状态只在对应控制面可见时加载，不能占用首页关键路径。
    if (!loadDiagnostics) return
    void refresh().catch(error => setUiError(formatUiError(error, '部分系统状态加载失败。')))
  }, [loadDiagnostics, refresh, setUiError])

  const saveRuntimeConfig = useCallback(async (nextConfig: AgentRuntimeConfig) => {
    try {
      setUiError(undefined)
      const saved = await updateRuntimeConfig(nextConfig)
      startTransition(() => setRuntimeConfig(saved))
    } catch (error) {
      setUiError(formatUiError(error, '运行时配置保存失败。'))
    }
  }, [setUiError])

  const saveCatalogEntry = useCallback(async (
    tool: ToolDescriptor,
    payload: Record<string, unknown>,
    sortOrder?: number,
  ) => {
    try {
      setUiError(undefined)
      setIsToolCatalogSubmitting(true)
      await upsertToolCatalogEntry(tool.toolKind, tool.name, payload, sortOrder)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 目录配置保存失败。`))
    } finally {
      setIsToolCatalogSubmitting(false)
    }
  }, [refresh, setUiError])

  const removeCatalogEntry = useCallback(async (tool: ToolDescriptor) => {
    try {
      setUiError(undefined)
      setIsToolCatalogSubmitting(true)
      await deleteToolCatalogEntry(tool.toolKind, tool.name)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 目录配置删除失败。`))
    } finally {
      setIsToolCatalogSubmitting(false)
    }
  }, [refresh, setUiError])

  return {
    availableTools,
    isToolCatalogSubmitting,
    isToolSubmitting,
    removeCatalogEntry,
    runtimeConfig,
    runTool,
    saveCatalogEntry,
    saveRuntimeConfig,
    setIsToolSubmitting,
    setToolRunResult,
    systemComponents,
    toolCatalogEntries,
    toolRunResult,
  }
}
