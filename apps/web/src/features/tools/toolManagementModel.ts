// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具管理页派生模型
//
//   文件:       toolManagementModel.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 将服务端工具 descriptor、provider 状态和目录 override 投影成工具管理页
// 可消费的分组、搜索和统计数据。这里保持纯函数，方便 UI 与测试共享。

import type {
  SystemComponentsStatus,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'

export interface ToolGroupSummary {
  key: string
  label: string
  tools: ToolDescriptor[]
  availableCount: number
  destructiveCount: number
}

export interface ToolCatalogSummary {
  total: number
  available: number
  unavailable: number
  destructive: number
  readOnly: number
  providers: number
  unavailableProviders: number
}

const GROUP_LABELS: Record<string, string> = {
  analysis: '空间分析',
  catalog: '目录与图层',
  data: '数据准备',
  lookup: '地理编码',
  meteorology: '气象分析',
  output: '导出',
  可视化: '可视化',
}

export function summarizeTools(
  tools: ToolDescriptor[],
  components?: SystemComponentsStatus,
): ToolCatalogSummary {
  const providers = components?.toolProviders ?? []
  return {
    total: tools.length,
    available: tools.filter((tool) => tool.available).length,
    unavailable: tools.filter((tool) => !tool.available).length,
    destructive: tools.filter((tool) => tool.isDestructive).length,
    readOnly: tools.filter((tool) => tool.isReadOnly).length,
    providers: providers.length,
    unavailableProviders: providers.filter((provider) => !provider.available).length,
  }
}

export function filterTools(tools: ToolDescriptor[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return tools
  return tools.filter((tool) => {
    const haystack = [
      tool.name,
      tool.label,
      tool.description,
      tool.group,
      tool.providerId ?? '',
      tool.language ?? '',
      ...tool.tags,
    ].join(' ').toLowerCase()
    return haystack.includes(normalized)
  })
}

export function groupToolsForManagement(tools: ToolDescriptor[]): ToolGroupSummary[] {
  return Object.entries(
    tools.reduce<Record<string, ToolDescriptor[]>>((accumulator, tool) => {
      const group = tool.group || 'other'
      accumulator[group] = [...(accumulator[group] ?? []), tool]
      return accumulator
    }, {}),
  )
    .map(([key, groupTools]) => ({
      key,
      label: GROUP_LABELS[key] ?? key,
      tools: groupTools.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
      availableCount: groupTools.filter((tool) => tool.available).length,
      destructiveCount: groupTools.filter((tool) => tool.isDestructive).length,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
}

export function providerLabel(tool: ToolDescriptor) {
  return tool.providerId ?? String(tool.meta.providerId ?? 'unknown-provider')
}

export function findToolCatalogEntry(
  entries: Array<Record<string, unknown>>,
  tool?: ToolDescriptor,
) {
  if (!tool) return undefined
  return entries.find(
    (entry) => String(entry.toolName ?? '') === tool.name && String(entry.toolKind ?? '') === tool.toolKind,
  )
}
