// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry（语言无关）
//
//   文件:       registry.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { makeId } from '../utils/ids.js'
import type { ToolDef, ToolProvider, ToolContext, ToolResult } from './types.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private providers = new Map<string, ToolProvider>()

  register(provider: ToolProvider): void {
    if (this.providers.has(provider.manifest.id)) {
      console.warn(`[registry] provider "${provider.manifest.id}" 已存在，跳过`)
      return
    }
    this.providers.set(provider.manifest.id, provider)
    for (const tool of provider.tools()) {
      this.tools.set(tool.name, tool)
    }
    console.log(`[registry] 已注册 provider "${provider.manifest.id}" (${provider.manifest.language}, ${provider.tools().length} tools)`)
  }

  unregister(providerId: string): void {
    const provider = this.providers.get(providerId)
    if (!provider) return
    for (const tool of provider.tools()) {
      this.tools.delete(tool.name)
    }
    this.providers.delete(providerId)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  listProviders(): ToolProvider[] {
    return [...this.providers.values()]
  }

  descriptors() {
    return this.list().map(t => ({
      name: t.name,
      label: t.label,
      description: t.description,
      group: t.group,
      toolKind: 'provider',
      available: true,
      tags: t.tags,
      parameters: [],
      error: null,
      meta: { providerId: t.providerId, language: t.language },
    }))
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`工具 "${name}" 未注册`)

    ctx.log('info', `执行 ${tool.label} (${tool.providerId})`)
    try {
      return await tool.handler(args, ctx)
    } catch (err) {
      ctx.log('error', `${tool.label} 失败: ${err instanceof Error ? err.message : String(err)}`)
      return {
        message: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
        payload: { error: String(err) },
        resultId: 'error',
        source: 'registry',
        warnings: [],
      }
    }
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry()
