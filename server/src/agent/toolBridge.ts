// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool Bridge（ToolDef → SDK tool() 包装）
//
//   文件:       toolBridge.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ToolDef, ToolExecutionResult, ToolRegistry, ToolRuntime } from '../tools.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { AgentState, ToolCall, ToolValueRef } from '../schemas/types.js'

// ToolErrorClassifier
export type ToolErrorCategory = 'invalid_input' | 'timeout' | 'permission_denied' | 'external_api_failure' | 'data_format_error' | 'unknown'

export function classifyToolError(error: Error, _toolName: string, _args: Record<string, unknown>): ToolErrorCategory {
  const msg = error.message.toLowerCase()
  if (msg.includes('timeout') || msg.includes('abort')) return 'timeout'
  if (msg.includes('permission') || msg.includes('denied')) return 'permission_denied'
  if (msg.includes('invalid') || msg.includes('validation')) return 'invalid_input'
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('http')) return 'external_api_failure'
  if (msg.includes('parse') || msg.includes('json')) return 'data_format_error'
  return 'unknown'
}

// buildToolHandler
//
// 将 ToolDef 包装为 SDK tool 用的 execute 函数。
// 处理权限检查、状态同步、事件发射、错误分类。
export function buildToolHandler(
  def: ToolDef,
  registry: ToolRegistry,
  toolRuntime: ToolRuntime,
  opts: {
    onStart?: (toolName: string, args: Record<string, unknown>) => void
    onComplete?: (toolName: string, result: ToolExecutionResult) => void
    onError?: (toolName: string, error: Error, category: ToolErrorCategory) => void
  } = {},
) {
  return async (args: Record<string, unknown>): Promise<string> => {
    const startTime = Date.now()
    opts.onStart?.(def.name, args)

    try {
      const result = await registry.execute(def.name, args, toolRuntime)
      const elapsed = Date.now() - startTime
      opts.onComplete?.(def.name, result)

      return formatToolObservation(def.name, result)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const category = classifyToolError(err, def.name, args)
      opts.onError?.(def.name, err, category)
      throw err
    }
  }
}

// formatToolObservation
//
// 将工具执行结果格式化为模型可读的观察文本。
export function formatToolObservation(toolName: string, result: ToolExecutionResult): string {
  const parts: string[] = [result.message]
  if (result.payload) {
    parts.push(JSON.stringify(result.payload, null, 2))
  }
  if (result.warnings.length > 0) {
    parts.push(`\n⚠️ 警告:\n${result.warnings.map(String).join('\n')}`)
  }
  return parts.join('\n')
}

// truncateObservation
export function truncateObservation(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n\n... (截断，共 ${text.length} 字符)`
}

// syncStateFromToolResult
//
// 将工具结果反向投影到 AgentState。
export function syncStateFromToolResult(
  state: AgentState,
  toolName: string,
  result: ToolExecutionResult,
): Partial<AgentState> {
  const updates: Partial<AgentState> = {}

  // Track tool result
  const toolCall: ToolCall = {
    stepId: makeId('step'), tool: toolName, args: {},
    status: 'completed', message: result.message,
    resultId: result.resultId, source: result.source,
    valueRefs: result.valueRefs as ToolValueRef[],
    startedAt: null, completedAt: null, confidence: null,
    usedQuery: null, provenance: {}, crs: {},
    geometryType: null, featureCount: null,
  }
  updates.toolResults = [...(state.toolResults ?? []), toolCall]
  updates.toolValueRefs = [...(state.toolValueRefs ?? []), ...(result.valueRefs as ToolValueRef[])]

  // Handle geocode_place → PlaceResolution
  if (toolName === 'geocode_place' && result.payload) {
    updates.placeResolution = {
      status: 'resolved', query: result.payload.query as string, provider: result.source,
      selected: null, error: null,
      candidates: (result.payload.candidates as unknown[])?.map((c: unknown) => {
        const candidate = c as Record<string, unknown>
        return {
          label: candidate.label as string,
          displayName: candidate.displayName as string ?? null,
          country: candidate.country as string ?? null,
          latitude: candidate.latitude as number ?? null,
          longitude: candidate.longitude as number ?? null,
          boundingbox: (candidate.boundingbox as Array<string | number>) ?? null,
          source: result.source,
        }
      }) ?? [],
    }
  }

  return updates
}
