// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 工具桥接
//
//   文件:       agentsToolBridge.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { tool, type RunContext, type Tool, type ToolInputParameters } from '@openai/agents'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolDef } from '../framework/types.js'

export interface AgentsExecutionContext {
  runId: string
  prepareToolCall(toolName: string, args: Record<string, unknown>, callId: string): Promise<void>
  executeTool(toolName: string, args: Record<string, unknown>, callId: string): Promise<string>
}

type NonStrictJsonParameters = Extract<ToolInputParameters, { type: 'object'; additionalProperties: true }>

export function createAgentsTools(
  registry: ToolRegistry,
  approvalTools: ReadonlySet<string>,
  allowedToolNames?: ReadonlySet<string>,
): Tool<AgentsExecutionContext>[] {
  const definitions = allowedToolNames
    ? [...allowedToolNames].map(name => {
      const definition = registry.get(name)
      if (!definition) throw new Error(`Agent 工具 allowlist 包含未知工具 '${name}'`)
      return definition
    })
    : registry.list()

  return definitions.map(definition => {
    const parameters = normalizeObjectSchema(definition.name, definition.jsonSchema)
    return tool<typeof parameters, AgentsExecutionContext>({
      name: definition.name,
      description: describeToolForAgent(definition),
      parameters,
      strict: false,
      errorFunction: null,
      needsApproval: async (runContext, input, callId) => {
        const context = requireContext(runContext)
        const args = requireArguments(definition.name, input)
        if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
        await context.prepareToolCall(definition.name, args, callId)
        return definition.isDestructive || approvalTools.has(definition.name)
      },
      execute: async (input, runContext, details) => {
        const context = requireContext(runContext)
        const args = requireArguments(definition.name, input)
        const callId = details?.toolCall?.callId
        if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
        await context.prepareToolCall(definition.name, args, callId)
        return context.executeTool(definition.name, args, callId)
      },
    })
  })
}

function normalizeObjectSchema(toolName: string, schema: Record<string, unknown>): NonStrictJsonParameters {
  if (schema.type !== 'object') throw new Error(`工具 '${toolName}' 顶层 schema.type 必须为 object`)
  return {
    ...schema,
    type: 'object',
    properties: isRecord(schema.properties) ? enrichProperties(schema.properties) : {},
    required: Array.isArray(schema.required) ? schema.required.map(String) : [],
    additionalProperties: true,
  } as NonStrictJsonParameters
}

// Agent 看到的是 Chat Completions 函数 schema，而不是 DebugPage 的参数面板。
// 因此 valueRef kind 约束必须写进模型可读描述里，避免把相邻工具产生的 ref 混用。
function describeToolForAgent(definition: ToolDef): string {
  const rules = valueRefRules(definition.jsonSchema)
  if (!rules.length) return definition.description
  return `${definition.description}\nValueRef 参数规则：${rules.join('；')}。调用前必须确认 refId 的 kind 匹配，不能用其它 kind 的 valueRef 代替。`
}

function valueRefRules(schema: Record<string, unknown>, prefix = ''): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const rules: string[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const kinds = valueRefKinds(raw)
    if (kinds.length) rules.push(`${path} 只接受 ${kinds.join(' / ')}`)
    rules.push(...valueRefRules(raw, path))
  }
  return rules
}

function enrichProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, enrichSchema(value)]),
  )
}

function enrichSchema(value: unknown): unknown {
  if (!isRecord(value)) return value
  const schema: Record<string, unknown> = { ...value }
  const kinds = valueRefKinds(schema)
  if (kinds.length) {
    const base = typeof schema.description === 'string' && schema.description.trim()
      ? schema.description.trim()
      : '必须使用当前 run 中已存在的 valueRef ID'
    schema.description = `${base}；允许的 valueRef kind: ${kinds.join(' / ')}；禁止传入其它 kind 的 valueRef。`
  }
  if (isRecord(schema.properties)) schema.properties = enrichProperties(schema.properties)
  if (isRecord(schema.items)) schema.items = enrichSchema(schema.items)
  return schema
}

function valueRefKinds(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema['x-value-ref-kinds'])) return []
  return schema['x-value-ref-kinds'].map(String).filter(Boolean)
}

function requireContext(runContext?: RunContext<unknown>): AgentsExecutionContext {
  const context = runContext?.context
  if (!isRecord(context)
    || typeof context.runId !== 'string'
    || typeof context.prepareToolCall !== 'function'
    || typeof context.executeTool !== 'function') {
    throw new Error('Agents SDK 工具缺少运行上下文')
  }
  return context as unknown as AgentsExecutionContext
}

function requireArguments(toolName: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`工具 '${toolName}' 参数必须为 JSON object`)
  return input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
