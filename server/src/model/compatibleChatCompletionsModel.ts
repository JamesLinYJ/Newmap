// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK Chat Completions 模型
//
//   文件:       compatibleChatCompletionsModel.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 该模块是 OpenAI Compatible 传输层的唯一实现。Runner 负责 Agent 编排，
// 本模型只负责严格转换 Chat Completions 请求、响应与流事件。

import {
  Usage,
  UserError,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryAdvice,
  type ModelRetryAdviceRequest,
  type ResponseStreamEvent,
  type SerializedHandoff,
  type SerializedTool,
} from '@openai/agents'
import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions'

const FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/u
const RESERVED_PROVIDER_FIELDS = new Set([
  'model', 'messages', 'tools', 'stream', 'stream_options', 'response_format',
  'tool_choice', 'parallel_tool_calls',
])

type CompatibleAssistantMessage = ChatCompletion['choices'][number]['message'] & {
  reasoning?: string | null
  reasoning_content?: string | null
}

interface CompatibleStreamChunk {
  id?: string
  choices?: Array<{
    index?: number
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: Record<string, number>
    completion_tokens_details?: Record<string, number>
  } | null
}

interface AccumulatedToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

type ModelOutput = Extract<ResponseStreamEvent, { type: 'response_done' }>['response']['output']

class CompatibleModelStreamError extends Error {
  constructor(
    message: string,
    readonly replaySafe: boolean,
    readonly networkError: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CompatibleModelStreamError'
  }
}

export interface CompatibleChatCompletionsModelOptions {
  client: OpenAI
  model: string
}

// CompatibleChatCompletionsModel
//
// 同时规范化标准 OpenAI 增量与兼容服务的 reasoning_content/完整参数快照，
// 但不接受任何 Responses 专属状态或工具能力。
export class CompatibleChatCompletionsModel implements Model {
  readonly model: string
  private readonly client: OpenAI

  constructor(options: CompatibleChatCompletionsModelOptions) {
    if (!options.model.trim()) throw new Error('Chat Completions 模型名称不能为空')
    this.client = options.client
    this.model = options.model
  }

  getRetryAdvice(args: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    if (args.error instanceof CompatibleModelStreamError) {
      if (!args.error.networkError) return undefined
      return {
        suggested: args.error.replaySafe,
        replaySafety: args.error.replaySafe ? 'safe' : 'unsafe',
        reason: args.error.message,
        normalized: { isNetworkError: args.error.networkError },
      }
    }
    return undefined
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const params = this.buildRequest(request, false)
    const response = await this.client.chat.completions.create(params, { signal: request.signal })
    const choice = response.choices[0]
    if (!choice || response.choices.length !== 1) throw new Error('Chat Completions 必须返回且只能返回一个 choice')
    assertFinishReason(choice.finish_reason)
    const output = parseAssistantMessage(response.id, choice.message as CompatibleAssistantMessage)
    if (!output.length) throw new Error('Chat Completions 未返回正文或工具调用')
    return {
      usage: new Usage(toUsage(response.usage)),
      output,
      responseId: response.id,
      providerData: response as unknown as Record<string, unknown>,
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const params = this.buildRequest(request, true)
    let emittedSemanticOutput = false
    try {
      const stream = await this.client.chat.completions.create(params, { signal: request.signal }) as unknown as AsyncIterable<CompatibleStreamChunk>
      let responseId = ''
      let text = ''
      let reasoning = ''
      let finishReason: string | null = null
      let usage: CompatibleStreamChunk['usage']
      let started = false
      const calls = new Map<number, AccumulatedToolCall>()

      for await (const chunk of stream) {
        if (chunk.id) {
          if (responseId && responseId !== chunk.id) throw new Error('Chat Completions 流在同一响应中改变了 response id')
          responseId = chunk.id
        }
        if (chunk.usage) usage = chunk.usage
        const choices = chunk.choices ?? []
        if (choices.length === 0) {
          if (started) yield { type: 'model', event: chunk, providerData: { source: 'openai_chat_completions' } }
          continue
        }
        if (choices.length !== 1 || (choices[0].index ?? 0) !== 0) {
          throw new Error('Chat Completions 流必须只包含 index=0 的 choice')
        }
        const choice = choices[0]
        const delta = choice.delta
        const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content
        const hasSemanticOutput = Boolean(delta?.content || reasoningDelta || delta?.tool_calls?.length)
        if (hasSemanticOutput && !started) {
          started = true
          yield { type: 'response_started', providerData: { chunk } }
        }
        if (started) yield { type: 'model', event: chunk, providerData: { source: 'openai_chat_completions' } }
        if (hasSemanticOutput) emittedSemanticOutput = true
        if (delta?.content) {
          text += delta.content
          yield { type: 'output_text_delta', delta: delta.content, providerData: { chunk } }
        }
        if (reasoningDelta) {
          reasoning += reasoningDelta
        }
        for (const raw of delta?.tool_calls ?? []) {
          accumulateToolCall(calls, raw)
        }
        if (choice.finish_reason) {
          if (finishReason && finishReason !== choice.finish_reason) throw new Error('Chat Completions 流返回了冲突的 finish reason')
          finishReason = choice.finish_reason
        }
      }

      if (!started || !responseId) throw new Error('Chat Completions 流缺少响应标识')
      assertFinishReason(finishReason)
      const output = buildOutput(responseId, text, reasoning, [...calls.values()].sort((a, b) => a.index - b.index))
      if (!output.length) throw new Error('Chat Completions 流未返回正文或工具调用')
      yield {
        type: 'response_done',
        response: {
          id: responseId,
          usage: toUsage(usage),
          output,
        },
      }
    } catch (error) {
      if (error instanceof UserError || error instanceof CompatibleModelStreamError) throw error
      throw new CompatibleModelStreamError(
        error instanceof Error ? error.message : String(error),
        !emittedSemanticOutput && isTransientNetworkError(error),
        isTransientNetworkError(error),
        { cause: error },
      )
    }
  }

  private buildRequest(request: ModelRequest, stream: false): ChatCompletionCreateParamsNonStreaming
  private buildRequest(request: ModelRequest, stream: true): ChatCompletionCreateParamsStreaming
  private buildRequest(
    request: ModelRequest,
    stream: boolean,
  ): ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming {
    assertSupportedRequest(request)
    const messages = toChatMessages(request.input)
    if (request.systemInstructions) messages.unshift({ role: 'system', content: request.systemInstructions })
    const tools = [
      ...request.tools.map(toChatTool),
      ...request.handoffs.map(toHandoffTool),
    ]
    const providerData = request.modelSettings.providerData ?? {}
    for (const key of Object.keys(providerData)) {
      if (RESERVED_PROVIDER_FIELDS.has(key)) throw new UserError(`providerData 不得覆盖保留字段 '${key}'`)
    }
    const responseFormat = toResponseFormat(request.outputType)
    return ({
      model: this.model,
      messages,
      tools: tools.length ? tools : undefined,
      temperature: request.modelSettings.temperature,
      top_p: request.modelSettings.topP,
      frequency_penalty: request.modelSettings.frequencyPenalty,
      presence_penalty: request.modelSettings.presencePenalty,
      max_tokens: request.modelSettings.maxTokens,
      tool_choice: toToolChoice(request.modelSettings.toolChoice, tools),
      parallel_tool_calls: request.modelSettings.parallelToolCalls ?? false,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(request.modelSettings.reasoning?.effort ? { reasoning_effort: request.modelSettings.reasoning.effort } : {}),
      ...providerData,
    } as unknown) as ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming
  }
}

function assertSupportedRequest(request: ModelRequest): void {
  if (request.previousResponseId) throw new UserError('Chat Completions 不支持 previousResponseId')
  if (request.conversationId) throw new UserError('Chat Completions 不支持远程 conversationId')
  if (request.prompt) throw new UserError('Chat Completions 不支持 reusable prompt')
  if (request.modelSettings.contextManagement?.length) throw new UserError('Chat Completions 不支持服务端 compaction')
  for (const tool of request.tools) {
    if (tool.type !== 'function') throw new UserError(`Chat Completions 不支持工具类型 '${tool.type}'`)
    if (tool.namespace) throw new UserError('Chat Completions 不支持 namespaced function tool')
    if (tool.deferLoading) throw new UserError('Chat Completions 不支持 deferred function tool')
  }
}

function toChatMessages(input: string | AgentInputItem[]): ChatCompletionMessageParam[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  const messages: ChatCompletionMessageParam[] = []
  let pendingAssistant: { role: 'assistant'; content: string | null; tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } | null = null
  const flush = () => {
    if (!pendingAssistant) return
    const value = pendingAssistant
    pendingAssistant = null
    if (!value.tool_calls.length && !value.content?.trim()) {
      throw new UserError('历史 assistant 消息缺少正文或工具调用')
    }
    messages.push({ ...value, tool_calls: value.tool_calls.length ? value.tool_calls : undefined } as ChatCompletionMessageParam)
  }
  const assistant = () => pendingAssistant ??= { role: 'assistant', content: null, tool_calls: [] }

  for (const item of input) {
    if (isMessage(item)) {
      flush()
      if (item.role === 'system') messages.push({ role: 'system', content: String(item.content) })
      else if (item.role === 'user') messages.push({ role: 'user', content: extractUserText(item.content) })
      else {
        const content = extractAssistantText(item.content)
        if (!content.trim()) throw new UserError('历史 assistant 消息缺少正文或工具调用')
        messages.push({ role: 'assistant', content })
      }
      continue
    }
    if (item.type === 'reasoning') {
      // Provider reasoning is UI-only telemetry in GeoForge. Replaying it as a
      // standalone assistant message is invalid for Chat Completions.
      continue
    }
    if (item.type === 'function_call') {
      if (!item.callId || !item.name || !FUNCTION_NAME.test(item.name)) throw new UserError('历史工具调用缺少合法 callId/name')
      assistant().tool_calls.push({
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      })
      continue
    }
    if (item.type === 'function_call_result') {
      flush()
      if (!item.callId) throw new UserError('历史工具结果缺少 callId')
      messages.push({ role: 'tool', tool_call_id: item.callId, content: extractToolText(item.output) })
      continue
    }
    throw new UserError(`Chat Completions 不支持历史项 '${item.type}'`)
  }
  flush()
  return messages
}

function toChatTool(tool: SerializedTool): ChatCompletionTool {
  if (tool.type !== 'function') throw new UserError(`Chat Completions 不支持工具类型 '${tool.type}'`)
  if (!FUNCTION_NAME.test(tool.name)) throw new UserError(`工具名称 '${tool.name}' 不符合 Chat Completions 约束`)
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }
}

function toHandoffTool(handoff: SerializedHandoff): ChatCompletionTool {
  if (!FUNCTION_NAME.test(handoff.toolName)) throw new UserError(`handoff 名称 '${handoff.toolName}' 不合法`)
  return {
    type: 'function',
    function: {
      name: handoff.toolName,
      description: handoff.toolDescription || '',
      parameters: handoff.inputJsonSchema,
      strict: handoff.strictJsonSchema,
    },
  }
}

function toResponseFormat(outputType: ModelRequest['outputType']): Record<string, unknown> | undefined {
  if (outputType === 'text') return undefined
  if (outputType.type === 'json_schema') {
    return { type: 'json_schema', json_schema: { name: outputType.name, strict: outputType.strict, schema: outputType.schema } }
  }
  return { type: 'json_object' }
}

function toToolChoice(choice: ModelRequest['modelSettings']['toolChoice'], tools: ChatCompletionTool[]): unknown {
  if (!choice || choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (!tools.some(tool => tool.type === 'function' && tool.function.name === choice)) {
    throw new UserError(`toolChoice 指向未知工具 '${choice}'`)
  }
  return { type: 'function', function: { name: choice } }
}

function parseAssistantMessage(responseId: string, message: CompatibleAssistantMessage): ModelOutput {
  const calls = (message.tool_calls ?? []).map((call, index) => {
    if (call.type !== 'function') throw new UserError(`不支持工具调用类型 '${call.type}'`)
    return { index, id: call.id, name: call.function.name, arguments: call.function.arguments }
  })
  return buildOutput(responseId, message.content ?? '', message.reasoning ?? message.reasoning_content ?? '', calls)
}

function buildOutput(responseId: string, text: string, reasoning: string, calls: AccumulatedToolCall[]): ModelOutput {
  const output: ModelOutput = []
  if (reasoning) output.push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: reasoning }] })
  if (text) {
    output.push({
      id: responseId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    })
  }
  for (const call of calls) {
    if (!call.id || !call.name || !FUNCTION_NAME.test(call.name)) throw new Error('工具调用缺少合法 callId/name')
    const parsed = JSON.parse(call.arguments || '{}') as unknown
    if (!isRecord(parsed)) throw new Error(`工具 '${call.name}' 参数必须为 JSON object`)
    output.push({
      id: responseId,
      type: 'function_call',
      status: 'completed',
      callId: call.id,
      name: call.name,
      arguments: call.arguments || '{}',
    })
  }
  return output
}

function accumulateToolCall(
  calls: Map<number, AccumulatedToolCall>,
  raw: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } },
): void {
  const index = raw.index
  if (!Number.isInteger(index) || (index ?? -1) < 0) throw new Error('工具调用缺少合法 index')
  if (raw.type && raw.type !== 'function') throw new Error(`不支持工具调用类型 '${raw.type}'`)
  const current = calls.get(index!) ?? { index: index!, id: '', name: '', arguments: '' }
  if (raw.id) {
    if (current.id && current.id !== raw.id) throw new Error(`工具索引 ${index} 返回冲突 callId`)
    current.id = raw.id
  }
  if (raw.function?.name) current.name = mergeDeltaOrSnapshot(current.name, raw.function.name)
  if (raw.function?.arguments) current.arguments = mergeDeltaOrSnapshot(current.arguments, raw.function.arguments)
  calls.set(index!, current)
}

export function mergeDeltaOrSnapshot(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current || incoming.startsWith(current)) return incoming
  return current + incoming
}

function assertFinishReason(reason: string | null | undefined): void {
  if (reason === 'stop' || reason === 'tool_calls') return
  if (!reason) throw new Error('Chat Completions 响应未正常结束')
  throw new Error(`Chat Completions 未完整交付，finish_reason=${reason}`)
}

function toUsage(usage: CompatibleStreamChunk['usage'] | ChatCompletion['usage'] | null | undefined) {
  return {
    requests: 1,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    inputTokensDetails: numericDetails(usage?.prompt_tokens_details),
    outputTokensDetails: numericDetails(usage?.completion_tokens_details),
  }
}

function numericDetails(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

function isMessage(item: AgentInputItem): item is Extract<AgentInputItem, { role: string }> {
  return item.type === 'message' || (typeof item.type === 'undefined' && 'role' in item)
}

function extractUserText(content: Extract<AgentInputItem, { role: 'user' }>['content']): string {
  if (typeof content === 'string') return content
  const unsupported = content.filter(part => part.type !== 'input_text')
  if (unsupported.length) throw new UserError('Chat Completions 当前只接受文本用户消息')
  return content.map(part => part.type === 'input_text' ? part.text : '').join('')
}

function extractAssistantText(content: Extract<AgentInputItem, { role: 'assistant' }>['content']): string {
  return content.map(part => {
    if (part.type === 'output_text') return part.text
    if (part.type === 'refusal') return part.refusal
    throw new UserError(`Chat Completions 不支持 assistant 内容 '${part.type}'`)
  }).join('')
}

function extractToolText(output: Extract<AgentInputItem, { type: 'function_call_result' }>['output']): string {
  if (typeof output === 'string') {
    if (!output.trim()) throw new UserError('Chat Completions 工具结果不能为空')
    return output
  }
  if (Array.isArray(output) && output.every(part => part.type === 'input_text')) {
    const text = output.map(part => part.type === 'input_text' ? part.text : '').join('')
    if (!text.trim()) throw new UserError('Chat Completions 工具结果不能为空')
    return text
  }
  if (isRecord(output) && output.type === 'text' && typeof output.text === 'string') {
    if (!output.text.trim()) throw new UserError('Chat Completions 工具结果不能为空')
    return output.text
  }
  throw new UserError('Chat Completions 工具结果必须是非空文本')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return [
    'terminated', 'fetch failed', 'econnreset', 'etimedout', 'socket hang up',
    'premature close', 'connection reset', 'connection error',
  ].some(marker => message.includes(marker))
}
