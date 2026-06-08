// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent SDK Bridge
//
//   文件:       sdkBridge.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import {
  Agent,
  tool,
  type RunItem,
  type RunStreamEvent,
  type Tool,
  type ToolInputParameters,
  type ToolOptions,
} from '@openai/agents'
import type { ToolRegistry, ToolRuntime } from '../tools.js'
import type { AgentRuntimeConfig, AgentState } from '../schemas/types.js'
import type { RunEventSink } from './turnRunner.js'
import type { ItemSink } from '../conversation/itemSink.js'
import { buildToolHandler } from './toolBridge.js'

export interface SupervisorBuildOpts {
  registry: ToolRegistry
  runtimeConfig: AgentRuntimeConfig
  state: AgentState
  eventSink: RunEventSink
  itemSink: ItemSink
  contextPrompt: string
  memoryPrompt: string
  toolsToApprove: string[]
  toolRuntime: ToolRuntime
  modelName?: string | null
}

export function buildSupervisorAgent(opts: SupervisorBuildOpts): Agent<ToolRuntime> {
  const sdkTools: Tool<ToolRuntime>[] = opts.registry.list()
    .filter(def => def.toolKind === 'registry')
    .map(def =>
      tool<ToolInputParameters, ToolRuntime, string>({
        name: def.name,
        description: def.description,
        parameters: toToolInputParameters(def.jsonSchema),
        strict: false,
        execute: async (input) => {
          const args = normalizeToolInput(input)
          opts.eventSink.emit('tool.started', `${def.label}...`, { tool: def.name, args })
          const handler = buildToolHandler(def, opts.registry, opts.toolRuntime)
          const result = await handler(args)
          opts.eventSink.emit('tool.completed', `${def.label} 完成`, { tool: def.name })
          return result
        },
        errorFunction: null,
        needsApproval: opts.toolsToApprove.includes(def.name),
      } as ToolOptions<ToolInputParameters, ToolRuntime>),
    )

  return new Agent<ToolRuntime>({
    name: opts.runtimeConfig.supervisor.name,
    instructions: buildInstructions(opts),
    model: opts.modelName ?? undefined,
    tools: sdkTools,
  })
}

export async function drainSdkStream(
  result: SdkStreamResult,
  itemSink: ItemSink,
): Promise<string> {
  let assistantItemId: string | null = null
  let assistantText = ''
  let assistantCompleted = false

  const ensureAssistantItem = () => {
    if (!assistantItemId) {
      assistantItemId = itemSink.startItem('message', { role: 'assistant' }).itemId
    }
    return assistantItemId
  }

  for await (const event of result) {
    if (event.type === 'raw_model_stream_event') {
      const delta = extractRawTextDelta(event.data)
      if (delta) {
        assistantText += delta
        itemSink.deltaItem(ensureAssistantItem(), delta)
      }
      continue
    }

    if (event.type === 'run_item_stream_event') {
      const finalText = emitRunItem(event, itemSink, assistantItemId)
      if (finalText !== null) {
        assistantText = finalText
        if (assistantItemId) {
          itemSink.completeItem(assistantItemId, { body: finalText })
        } else {
          itemSink.appendAssistantMessage(finalText)
        }
        assistantCompleted = true
      }
    }
  }

  await result.completed

  if (assistantItemId && !assistantCompleted) {
    itemSink.completeItem(assistantItemId, { body: assistantText })
    assistantCompleted = true
  }

  if (!assistantCompleted && !assistantText.trim()) {
    throw new Error('模型流结束但没有产出 assistant message item')
  }

  return assistantText
}

function emitRunItem(
  event: Extract<RunStreamEvent, { type: 'run_item_stream_event' }>,
  itemSink: ItemSink,
  currentAssistantItemId: string | null,
): string | null {
  const item = event.item

  if (event.name === 'message_output_created' || item.type === 'message_output_item') {
    return extractRunItemText(item)
  }

  if (event.name === 'reasoning_item_created' || item.type === 'reasoning_item') {
    const text = extractReasoningText(item)
    if (text) {
      const reasoning = itemSink.startItem('reasoning', { role: 'assistant' })
      itemSink.completeItem(reasoning.itemId, { body: text })
    }
    return null
  }

  if (event.name === 'tool_called' || item.type === 'tool_call_item') {
    const call = extractToolCall(item)
    if (!call.callId) return null
    itemSink.startItem('function_call', {
      itemId: `toolcall:${call.callId}`,
      callId: call.callId,
      name: call.name ?? undefined,
      arguments: call.arguments ?? undefined,
      metadata: { source: 'openai-agents-js' },
    })
    return null
  }

  if (event.name === 'tool_output' || item.type === 'tool_call_output_item') {
    const output = extractToolOutput(item)
    if (!output.callId) return null
    const outputItem = itemSink.startItem('function_call_output', {
      itemId: `toolout:${output.callId}`,
      callId: output.callId,
      name: output.name ?? undefined,
      metadata: output.metadata,
    })
    itemSink.completeItem(outputItem.itemId, {
      output: output.output,
      body: output.output,
      metadata: output.metadata,
    })
    return null
  }

  if (currentAssistantItemId) return null
  return null
}

function buildInstructions(opts: SupervisorBuildOpts): string {
  const cfg = opts.runtimeConfig.supervisor
  const parts: string[] = [cfg.systemPrompt || defaultPrompt()]

  if (opts.contextPrompt) parts.push(`\n## 项目上下文\n${opts.contextPrompt}`)
  if (opts.memoryPrompt && opts.runtimeConfig.context.memoryEnabled) {
    parts.push(`\n## 记忆\n${opts.memoryPrompt}`)
  }

  if (opts.state.clarification) {
    const c = opts.state.clarification
    parts.push(`\n## 需要澄清\n问题: ${c.question}`)
    for (const opt of c.options) {
      parts.push(`- [${opt.optionId}] ${opt.label}: ${opt.description}`)
    }
  }

  if (opts.state.planMode) parts.push('\n当前处于计划模式（只读探索）。')
  parts.push(`\n最大轮次: ${opts.runtimeConfig.maxTurns}`)
  return parts.join('\n')
}

function defaultPrompt(): string {
  return `你是地理智能助手（geo-agent-supervisor）。
使用空间分析工具帮用户理解地理数据。用中文回复。

## 工作流程
1. 理解用户的空间查询意图
2. 逐步执行分析
3. 汇总结果并可视化`
}

interface SdkStreamResult extends AsyncIterable<RunStreamEvent> {
  completed: Promise<void>
  finalOutput: unknown
}

function toToolInputParameters(schema?: Record<string, unknown>): ToolInputParameters {
  const source = schema ?? { type: 'object', properties: {}, required: [], additionalProperties: true }
  return {
    type: 'object',
    properties: isRecord(source.properties) ? source.properties : {},
    required: Array.isArray(source.required) ? source.required.filter((item): item is string => typeof item === 'string') : [],
    additionalProperties: true,
    description: typeof source.description === 'string' ? source.description : undefined,
  } as ToolInputParameters
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    const parsed = JSON.parse(input) as unknown
    if (isRecord(parsed)) return parsed
    throw new Error('工具参数必须是 JSON object')
  }
  if (isRecord(input)) return input
  throw new Error('工具参数必须是 object')
}

function extractRawTextDelta(data: unknown): string {
  const wrapper = isRecord(data) ? data : {}
  const event = isRecord(wrapper.event) ? wrapper.event : wrapper
  const type = typeof event.type === 'string' ? event.type : ''
  if ((type === 'output_text_delta' || type.endsWith('.output_text.delta')) && typeof event.delta === 'string') {
    return event.delta
  }

  const choices = Array.isArray(event.choices) ? event.choices : []
  const first = choices[0]
  if (isRecord(first) && isRecord(first.delta) && typeof first.delta.content === 'string') {
    return first.delta.content
  }

  return ''
}

function extractRunItemText(item: RunItem): string {
  if (item.type !== 'message_output_item') return ''
  return item.content
}

function extractReasoningText(item: RunItem): string {
  if (item.type !== 'reasoning_item') return ''
  const raw = item.rawItem
  const rawRecord: Record<string, unknown> = isRecord(raw) ? raw : {}
  const rawContent: unknown[] = Array.isArray(rawRecord.rawContent) ? rawRecord.rawContent : []
  const content = rawContent
    .filter(isRecord)
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
  if (content) return content

  const normalized: unknown[] = Array.isArray(rawRecord.content) ? rawRecord.content : []
  return normalized
    .filter(isRecord)
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
}

function extractToolCall(item: RunItem): { callId: string | null; name: string | null; arguments: string | null } {
  if (item.type !== 'tool_call_item') return { callId: null, name: null, arguments: null }
  const raw: Record<string, unknown> = isRecord(item.rawItem) ? item.rawItem : {}
  const args = typeof raw.arguments === 'string' ? raw.arguments : null
  return {
    callId: item.callId ?? null,
    name: item.toolName ?? null,
    arguments: args,
  }
}

function extractToolOutput(item: RunItem): {
  callId: string | null
  name: string | null
  output: string
  metadata: Record<string, unknown>
} {
  if (item.type !== 'tool_call_output_item') {
    return { callId: null, name: null, output: '', metadata: {} }
  }
  const raw: Record<string, unknown> = isRecord(item.rawItem) ? item.rawItem : {}
  const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
  return {
    callId: item.callId ?? null,
    name: typeof raw.name === 'string' ? raw.name : null,
    output,
    metadata: {
      source: 'openai-agents-js',
      resultId: typeof raw.id === 'string' ? raw.id : null,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
