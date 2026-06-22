// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具管理模型测试
//
//   文件:       toolManagementModel.test.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 测试目的
//
// 工具管理页依赖这些纯函数来呈现服务端 descriptor，不在 UI 层二次猜测
// Provider 或工具风险状态。

import { describe, expect, it } from 'vitest'
import type { SystemComponentsStatus, ToolDescriptor } from '@geo-agent-platform/shared-types'

import {
  filterTools,
  findToolCatalogEntry,
  groupToolsForManagement,
  providerLabel,
  summarizeTools,
} from '../features/tools/toolManagementModel'

describe('tool management model', () => {
  const tools: ToolDescriptor[] = [
    makeTool({
      name: 'inspect_meteorological_dataset',
      label: '检查气象数据集',
      group: 'meteorology',
      providerId: 'weather',
      language: 'typescript',
      tags: ['weather', 'netcdf'],
    }),
    makeTool({
      name: 'delete_layer',
      label: '删除图层',
      group: 'catalog',
      providerId: 'layer',
      language: 'worker',
      isReadOnly: false,
      isDestructive: true,
      tags: ['layer'],
    }),
    makeTool({
      name: 'broken_tool',
      label: '不可用工具',
      group: 'analysis',
      providerId: 'broken',
      language: 'python-worker',
      available: false,
      error: 'missing dependency',
      tags: ['debug'],
    }),
  ]

  it('summarizes tool and provider health for overview cards', () => {
    const components: SystemComponentsStatus = {
      catalogBackend: 'postgres',
      postgisEnabled: true,
      postgisError: null,
      conversationStoreRoot: 'runtime/conversations',
      providers: [],
      toolProviders: [
        {
          providerId: 'weather',
          name: 'Weather',
          version: '1.0.0',
          author: 'team',
          language: 'typescript',
          toolCount: 1,
          available: true,
          error: null,
        },
        {
          providerId: 'broken',
          name: 'Broken',
          version: null,
          author: null,
          language: null,
          toolCount: 0,
          available: false,
          error: 'missing dependency',
        },
      ],
    }

    expect(summarizeTools(tools, components)).toMatchObject({
      total: 3,
      available: 2,
      unavailable: 1,
      destructive: 1,
      readOnly: 2,
      providers: 2,
      unavailableProviders: 1,
    })
  })

  it('filters across label, tags, provider and language', () => {
    expect(filterTools(tools, 'netcdf').map((tool) => tool.name)).toEqual(['inspect_meteorological_dataset'])
    expect(filterTools(tools, 'layer').map((tool) => tool.name)).toEqual(['delete_layer'])
    expect(filterTools(tools, 'typescript').map((tool) => tool.name)).toEqual(['inspect_meteorological_dataset'])
  })

  it('groups tools with counts and stable Chinese labels', () => {
    const groups = groupToolsForManagement(tools)
    const weatherGroup = groups.find((group) => group.key === 'meteorology')
    const catalogGroup = groups.find((group) => group.key === 'catalog')

    expect(weatherGroup).toMatchObject({ label: '气象分析', availableCount: 1, destructiveCount: 0 })
    expect(catalogGroup).toMatchObject({ label: '目录与图层', availableCount: 1, destructiveCount: 1 })
  })

  it('finds provider label and catalog override by canonical key', () => {
    const entry = { toolKind: 'provider', toolName: 'delete_layer', payload: { label: '删除图层 Pro' } }

    expect(providerLabel(tools[0])).toBe('weather')
    expect(findToolCatalogEntry([entry], tools[1])).toBe(entry)
  })
})

function makeTool(partial: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name' | 'label'>): ToolDescriptor {
  return {
    name: partial.name,
    label: partial.label,
    description: partial.description ?? `${partial.label} description`,
    group: partial.group ?? 'analysis',
    toolKind: partial.toolKind ?? 'provider',
    providerId: partial.providerId ?? 'demo',
    language: partial.language ?? 'typescript',
    isReadOnly: partial.isReadOnly ?? true,
    isDestructive: partial.isDestructive ?? false,
    available: partial.available ?? true,
    tags: partial.tags ?? [],
    parameters: partial.parameters ?? [],
    error: partial.error ?? null,
    meta: partial.meta ?? {},
  }
}
