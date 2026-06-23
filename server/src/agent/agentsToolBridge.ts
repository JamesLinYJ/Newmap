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
      description: definition.description,
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
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required.map(String) : [],
    additionalProperties: true,
  } as NonStrictJsonParameters
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
