// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry（语言无关）
//
//   文件:       registry.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ToolDef, ToolProvider, ToolContext, ToolResult } from './types.js'
import { validateToolProvider } from './validation.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private providers = new Map<string, ToolProvider>()
  private unavailableProviders = new Map<string, string>()

  register(provider: ToolProvider): void {
    validateToolProvider(provider)
    if (this.providers.has(provider.manifest.id)) {
      throw new Error(`Provider "${provider.manifest.id}" 重复注册`)
    }
    for (const tool of provider.tools()) {
      if (this.tools.has(tool.name)) throw new Error(`工具 "${tool.name}" 重复注册`)
      tool.providerId = provider.manifest.id
      tool.language = provider.manifest.language
      this.tools.set(tool.name, tool)
    }
    this.providers.set(provider.manifest.id, provider)
    this.unavailableProviders.delete(provider.manifest.id)
    console.log(`[registry] 已注册 provider "${provider.manifest.id}" (${provider.manifest.language}, ${provider.tools().length} tools)`)
  }

  markUnavailable(providerId: string, reason: string): void {
    this.unavailableProviders.set(providerId, reason)
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

  providerStatuses() {
    const enabled = this.listProviders().map(provider => ({
      providerId: provider.manifest.id,
      name: provider.manifest.name,
      version: provider.manifest.version,
      author: provider.manifest.author,
      language: provider.manifest.language,
      toolCount: provider.manifest.tools.length,
      available: true,
      error: null,
    }))
    const unavailable = [...this.unavailableProviders].map(([providerId, error]) => ({
      providerId,
      name: providerId,
      version: null,
      author: null,
      language: null,
      toolCount: 0,
      available: false,
      error,
    }))
    return [...enabled, ...unavailable]
  }

  descriptors() {
    return this.list().map(t => ({
      name: t.name,
      label: t.label,
      description: t.description,
      group: t.group,
      toolKind: 'provider',
      providerId: t.providerId ?? null,
      language: t.language ?? null,
      isReadOnly: t.isReadOnly,
      isDestructive: t.isDestructive,
      available: true,
      tags: t.tags,
      parameters: schemaParameters(t.jsonSchema),
      error: null,
      meta: {
        providerId: t.providerId,
        language: t.language,
        isReadOnly: t.isReadOnly,
        isDestructive: t.isDestructive,
        approvalRecommended: t.isDestructive,
        jsonSchema: t.jsonSchema,
      },
    }))
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`工具 "${name}" 未注册`)
    validateArguments(tool, args)

    ctx.log('info', `执行 ${tool.label} (${tool.providerId})`)
    const result = await tool.handler(args, ctx)
    if (!result.resultId || !result.source || !result.message || !isRecord(result.payload)) {
      throw new Error(`工具 "${name}" 返回了无效结果`)
    }
    for (const artifact of result.artifacts ?? []) {
      if (!artifact.artifactId || !artifact.artifactType || !artifact.name || !artifact.uri || !artifact.relativePath) {
        throw new Error(`工具 "${name}" 返回了无效 artifact`)
      }
    }
    return result
  }
}

function validateArguments(tool: ToolDef, args: Record<string, unknown>): void {
  validateValue(tool.jsonSchema, args, `工具 "${tool.name}" 参数`)
}

function validateValue(schema: Record<string, unknown>, value: unknown, field: string): void {
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
    throw new Error(`${field} 必须是：${schema.enum.map(String).join('、')}`)
  }
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) throw new Error(`${field} 必须是对象`)
      const properties = isRecord(schema.properties) ? schema.properties : {}
      const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
      for (const key of required) {
        if (!(key in value) || value[key] === null || value[key] === '') throw new Error(`${field} 缺少必填参数 "${key}"`)
      }
      for (const [key, nested] of Object.entries(value)) {
        const property = properties[key]
        if (!isRecord(property)) {
          if (schema.additionalProperties === true) continue
          throw new Error(`${field} 收到未知参数 "${key}"`)
        }
        validateValue(property, nested, `${field}.${key}`)
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`)
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`${field} 至少需要 ${schema.minItems} 项`)
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${field} 最多允许 ${schema.maxItems} 项`)
      if (isRecord(schema.items)) value.forEach((item, index) => validateValue(schema.items as Record<string, unknown>, item, `${field}[${index}]`))
      return
    }
    case 'string':
      if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) throw new Error(`${field} 长度不能小于 ${schema.minLength}`)
      return
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`)
      if (schema.type === 'integer' && !Number.isInteger(value)) throw new Error(`${field} 必须是整数`)
      if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${field} 不能小于 ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${field} 不能大于 ${schema.maximum}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`)
      return
    default:
      throw new Error(`${field} 使用了不支持的 schema.type`)
  }
}

function schemaParameters(schema: Record<string, unknown>) {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  return Object.entries(properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {}
    return {
      key,
      label: typeof property.title === 'string' ? property.title : key,
      dataType: typeof property.type === 'string' ? property.type : 'string',
      source: typeof property['x-source'] === 'string' ? property['x-source'] : 'text',
      required: required.has(key),
      description: typeof property.description === 'string' ? property.description : null,
      placeholder: null,
      defaultValue: property.default ?? null,
      options: Array.isArray(property.enum)
        ? property.enum.map(value => ({ label: String(value), value: String(value) }))
        : [],
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 全局单例
export const toolRegistry = new ToolRegistry()
