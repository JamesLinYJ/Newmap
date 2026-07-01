// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 工具桥接
//
//   文件:       agentsToolBridge.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { tool, type RunContext, type Tool } from '@openai/agents'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolDef } from '../framework/types.js'
import { enrichValueRefDescriptions, ensureToolSchemas, isRecord, parametersForAgentsSdk, stripNullObjectValues, valueRefRules } from '../framework/schema.js'

export interface AgentsExecutionContext {
  runId: string
  prepareToolCall(toolName: string, args: Record<string, unknown>, callId: string): Promise<void>
  executeTool(toolName: string, args: Record<string, unknown>, callId: string): Promise<string>
}

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
    const { jsonSchema } = ensureToolSchemas(definition)
    const parameters = parametersForAgentsSdk(enrichValueRefDescriptions(jsonSchema))
    return tool<typeof parameters, AgentsExecutionContext>({
      name: definition.name,
      description: describeToolForAgent(definition, jsonSchema),
      parameters,
      strict: true,
      errorFunction: null,
      needsApproval: async (runContext, input, callId) => {
        const context = requireContext(runContext)
        const args = stripNullObjectValues(requireArguments(definition.name, input))
        if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
        await context.prepareToolCall(definition.name, args, callId)
        return definition.requiresApproval === true || definition.isDestructive || approvalTools.has(definition.name)
      },
      execute: async (input, runContext, details) => {
        const context = requireContext(runContext)
        const args = stripNullObjectValues(requireArguments(definition.name, input))
        const callId = details?.toolCall?.callId
        if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
        await context.prepareToolCall(definition.name, args, callId)
        return context.executeTool(definition.name, args, callId)
      },
    })
  })
}

// Agent 看到的是 Chat Completions 函数 schema，而不是 DebugPage 的参数面板。
// 因此 valueRef kind 约束必须写进模型可读描述里，避免把相邻工具产生的 ref 混用。
function describeToolForAgent(definition: ToolDef, jsonSchema: Record<string, unknown>): string {
  const parts = [definition.description, `工具使用说明：\n${definition.prompt.trim()}`]
  const rules = valueRefRules(enrichValueRefDescriptions(jsonSchema))
  if (rules.length) {
    parts.push(`ValueRef 参数规则：${rules.join('；')}。调用前必须确认 refId 的 kind 匹配，不能用其它 kind 的 valueRef 代替。`)
  }
  return parts.join('\n\n')
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
