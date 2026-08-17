// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry（语言无关）
//
//   文件:       registry.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolDef, ToolProvider, ToolContext, ToolResult } from './types.js'
import { z } from 'zod'
import { validateToolProvider } from './validation.js'
import { ensureToolSchemas, schemaParameters, isRecord } from './schema.js'
import { logger } from '../observability/logger.js'
import { artifactDisplaySchema } from '../schemas/types.js'

export type ToolExecutionAuthorizer = (
  toolName: string,
  context: ToolContext,
) => Promise<NonNullable<ToolContext['auth']>>

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private providers = new Map<string, ToolProvider>()
  private unavailableProviders = new Map<string, string>()
  private executionAuthorizer: ToolExecutionAuthorizer | null = null

  setExecutionAuthorizer(authorizer: ToolExecutionAuthorizer): void {
    if (this.executionAuthorizer) throw new Error('ToolRegistry 执行授权器已经配置。')
    this.executionAuthorizer = authorizer
  }

  register(provider: ToolProvider): void {
    const tools = validateToolProvider(provider)
    if (this.providers.has(provider.manifest.id)) {
      throw new Error(`Provider "${provider.manifest.id}" 重复注册`)
    }
    for (const tool of tools) {
      ensureToolSchemas(tool)
      if (this.tools.has(tool.name)) throw new Error(`工具 "${tool.name}" 重复注册`)
      if (prepareValueRefValidation(tool.jsonSchema ?? {})) valueRefValidatedTools.add(tool)
      tool.providerId = provider.manifest.id
      tool.language = provider.manifest.language
      this.tools.set(tool.name, tool)
    }
    this.providers.set(provider.manifest.id, provider)
    this.unavailableProviders.delete(provider.manifest.id)
    logger.info({ providerId: provider.manifest.id, language: provider.manifest.language, toolCount: tools.length }, 'provider registered')
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

  validatePlannedArguments(name: string, args: Record<string, unknown>): string | null {
    const tool = this.tools.get(name)
    if (!tool) return `工具 "${name}" 未注册`
    const result = ensureToolSchemas(tool).parameters.partial().safeParse(args)
    if (result.success) return null
    return result.error.issues.map(issue => formatIssue(issue)).join('；')
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
      parallelSafe: t.parallelSafe !== false && t.isReadOnly && !t.isDestructive,
      available: true,
      tags: t.tags,
      parameters: schemaParameters(ensureToolSchemas(t).jsonSchema),
      error: null,
      meta: {
        providerId: t.providerId,
        language: t.language,
        isReadOnly: t.isReadOnly,
        isDestructive: t.isDestructive,
        parallelSafe: t.parallelSafe !== false && t.isReadOnly && !t.isDestructive,
        approvalRecommended: t.isDestructive || t.requiresApproval === true,
        executionSurfaces: t.executionSurfaces ?? ['agent', 'automation', 'debug'],
        agentResultMode: t.agentResultMode ?? 'continue',
        jsonSchema: ensureToolSchemas(t).jsonSchema,
      },
    }))
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`工具 "${name}" 未注册`)
    const validatedArgs = validateArguments(tool, args)
    if (valueRefValidatedTools.has(tool)) validateValueRefArguments(tool, validatedArgs, ctx)

    // schema/valueRef 验证无副作用；授权必须紧贴 handler，避免排队、审批、
    // Handoff 或恢复期间的会话撤销和角色变化继续沿用旧 AuthContext。
    if (this.executionAuthorizer) {
      ctx.auth = await this.executionAuthorizer(name, ctx)
    }
    ctx.log('info', `执行 ${tool.label} (${tool.providerId})`)
    const result = await tool.handler(validatedArgs, ctx)
    if (!result.resultId || !result.source || !result.message || !isRecord(result.payload)) {
      throw new Error(`工具 "${name}" 返回了无效结果`)
    }
    if (tool.agentResultMode === 'return_direct' && !result.modelOutput?.trim()) {
      throw new Error(`工具 "${name}" 声明直接返回，但没有提供 modelOutput`)
    }
    for (const artifact of result.artifacts ?? []) {
      if (!artifact.artifactId || !artifact.artifactType || !artifact.name || !artifact.uri || !artifact.relativePath) {
        throw new Error(`工具 "${name}" 返回了无效 artifact`)
      }
      const display = artifactDisplaySchema.safeParse(artifact.display)
      if (!display.success) {
        throw new Error(`工具 "${name}" 的 artifact "${artifact.artifactId}" 展示契约无效：${display.error.issues[0]?.message ?? '未知 schema 错误'}`)
      }
    }
    return result
  }
}

/**
 * x-value-ref-kinds 不只是给模型看的提示：它也是工具执行边界的强约束。
 * 在 handler 发生任何副作用之前解析 refId 并核对 kind，防止可选参数或
 * 第三方 Provider 忘记在自己的 handler 内重复校验。
 */
function validateValueRefArguments(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): void {
  const rootSchema = ensureToolSchemas(tool).jsonSchema
  const resolved = new Map<string, ReturnType<ToolContext['resolveValueRef']>>()

  const visit = (value: unknown, currentSchema: Record<string, unknown>, path: string, refs = new Set<string>()): void => {
    const referenced = resolveLocalSchema(currentSchema, rootSchema, refs)
    if (referenced !== currentSchema) {
      visit(value, referenced, path, new Set(refs).add(String(currentSchema.$ref)))
    }
    const kinds = Array.isArray(currentSchema['x-value-ref-kinds'])
      ? [...new Set(currentSchema['x-value-ref-kinds'].map(String).filter(Boolean))]
      : []
    if (kinds.length > 0 && typeof value === 'string') {
      const refId = value.trim()
      if (!refId) return
      const reference = resolved.get(refId) ?? ctx.resolveValueRef(refId)
      resolved.set(refId, reference)
      if (!kinds.includes(reference.kind)) {
        throw new Error(`工具 "${tool.name}" 参数 ${path} 必须引用 ${kinds.join(' 或 ')}，实际为 ${reference.kind}`)
      }
    }

    for (const schema of Array.isArray(currentSchema.allOf) ? currentSchema.allOf.filter(isRecord) : []) {
      visit(value, schema, path, new Set(refs))
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const alternatives = Array.isArray(currentSchema[keyword]) ? currentSchema[keyword].filter(isRecord) : []
      if (!alternatives.length) continue
      const matched = alternatives.filter(candidate => jsonSchemaMatches(candidate, value))
      if (keyword === 'oneOf' && matched.length !== 1) {
        throw new Error(`工具 "${tool.name}" 参数 ${path || '参数'} 未唯一匹配 oneOf 分支`)
      }
      if (keyword === 'oneOf') {
        visit(value, matched[0]!, path, new Set(refs))
      } else if (matched.length > 0) {
        const failures: unknown[] = []
        let accepted = false
        for (const candidate of matched) {
          try {
            visit(value, candidate, path, new Set(refs))
            accepted = true
            break
          } catch (error) {
            failures.push(error)
          }
        }
        if (!accepted && failures[0]) throw failures[0]
      }
    }

    if (Array.isArray(value)) {
      const prefixItems = Array.isArray(currentSchema.prefixItems) ? currentSchema.prefixItems.filter(isRecord) : []
      value.forEach((item, index) => {
        const itemSchema = prefixItems[index] ?? (isRecord(currentSchema.items) ? currentSchema.items : null)
        if (itemSchema) visit(item, itemSchema, path ? `${path}.${index}` : String(index), new Set(refs))
      })
      return
    }
    if (isRecord(value) && isRecord(currentSchema.properties)) {
      for (const [key, childSchema] of Object.entries(currentSchema.properties)) {
        if (value[key] === undefined || !isRecord(childSchema)) continue
        visit(value[key], childSchema, path ? `${path}.${key}` : key, new Set(refs))
      }
    }
  }

  visit(args, rootSchema, '')
}

const valueRefBranchValidators = new WeakMap<Record<string, unknown>, z.ZodType>()
const valueRefValidatedTools = new WeakSet<ToolDef>()

function jsonSchemaMatches(schema: Record<string, unknown>, value: unknown): boolean {
  const validator = valueRefBranchValidators.get(schema)
  if (!validator) throw new Error('工具 valueRef 分支 schema 未在注册阶段编译')
  return validator.safeParse(value).success
}

function prepareValueRefValidation(rootSchema: Record<string, unknown>): boolean {
  const seen = new Set<Record<string, unknown>>()
  let hasValueRefConstraint = false
  const visit = (schema: Record<string, unknown>): void => {
    if (seen.has(schema)) return
    seen.add(schema)
    if (Array.isArray(schema['x-value-ref-kinds']) && schema['x-value-ref-kinds'].length > 0) {
      hasValueRefConstraint = true
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      for (const candidate of Array.isArray(schema[keyword]) ? schema[keyword].filter(isRecord) : []) {
        const branchSchema: Parameters<typeof z.fromJSONSchema>[0] = {
          ...candidate,
          ...(isRecord(rootSchema.$defs) ? { $defs: jsonSchemaDefinitions(rootSchema.$defs) } : {}),
        }
        valueRefBranchValidators.set(candidate, z.fromJSONSchema(branchSchema))
        visit(candidate)
      }
    }
    for (const candidate of Array.isArray(schema.allOf) ? schema.allOf.filter(isRecord) : []) visit(candidate)
    if (isRecord(schema.properties)) for (const candidate of Object.values(schema.properties).filter(isRecord)) visit(candidate)
    if (isRecord(schema.items)) visit(schema.items)
    if (Array.isArray(schema.prefixItems)) for (const candidate of schema.prefixItems.filter(isRecord)) visit(candidate)
    if (isRecord(schema.$defs)) for (const candidate of Object.values(schema.$defs).filter(isRecord)) visit(candidate)
  }
  visit(rootSchema)
  return hasValueRefConstraint
}

function jsonSchemaDefinitions(definitions: Record<string, unknown>): Record<string, Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>> {
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    if (!isRecord(definition)) throw new Error(`JSON Schema $defs.${key} 不是 schema 对象`)
    return [key, definition as Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>]
  }))
}

function resolveLocalSchema(
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  seenRefs: Set<string>,
): Record<string, unknown> {
  if (typeof schema.$ref !== 'string') return schema
  const ref = schema.$ref
  if (!ref.startsWith('#/')) throw new Error(`不支持非本地 JSON Schema $ref: ${ref}`)
  if (seenRefs.has(ref)) throw new Error(`JSON Schema $ref 循环: ${ref}`)
  let current: unknown = rootSchema
  for (const token of ref.slice(2).split('/').map(value => value.replace(/~1/gu, '/').replace(/~0/gu, '~'))) {
    if (!isRecord(current) || !(token in current)) throw new Error(`JSON Schema $ref 不存在: ${ref}`)
    current = current[token]
  }
  if (!isRecord(current)) throw new Error(`JSON Schema $ref 不是 schema 对象: ${ref}`)
  return current
}

function validateArguments(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const result = ensureToolSchemas(tool).parameters.safeParse(args)
  if (!result.success) {
    const details = result.error.issues.map(issue => formatIssue(issue)).join('；')
    throw new Error(`工具 "${tool.name}" 参数无效：${details}`)
  }
  return result.data as Record<string, unknown>
}

function formatIssue(issue: unknown): string {
  const record = isRecord(issue) ? issue : {}
  const path = Array.isArray(record.path) ? record.path.map(String).join('.') || '参数' : '参数'
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.message === 'string' ? record.message : '参数不合法'
  const keys = Array.isArray(record.keys) ? record.keys.map(String) : []
  if (code === 'unrecognized_keys' && keys.length) return `${path}: 未知参数 "${keys.join('、')}"`
  if (code === 'too_big' && typeof record.maximum !== 'undefined') return `${path}: 不能大于 ${String(record.maximum)}`
  if (code === 'too_small' && typeof record.minimum !== 'undefined') return `${path}: 不能小于 ${String(record.minimum)}`
  if (code === 'invalid_type' && record.expected === 'array') return `${path}: 必须是数组`
  if (code === 'invalid_type' && record.expected === 'object') return `${path}: 必须是对象`
  if (code === 'invalid_type' && record.expected === 'string') return `${path}: 必须是字符串`
  if (code === 'invalid_type' && record.expected === 'number') return `${path}: 必须是数字`
  return `${path}: ${message}`
}
