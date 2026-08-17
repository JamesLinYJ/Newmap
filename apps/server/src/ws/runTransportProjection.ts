// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行实时传输投影
//
//   文件:       runTransportProjection.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  conversationItemSchema,
  runEventSchema,
  runSnapshotSchema,
  type AnalysisRun,
  type ConversationItem,
  type RunEvent,
  type RunSnapshot,
  type ToolValueRef,
} from '@geo-agent-platform/shared-types'

const MAX_SNAPSHOT_ITEMS = 600
const MAX_SNAPSHOT_EVENTS = 600
const TOOL_TEXT_MAX_BYTES = 16 * 1024
const MESSAGE_TEXT_MAX_BYTES = 48 * 1024

/**
 * PostgreSQL 保留完整运行事实；WebSocket 只传客户端展示所需的有界投影。
 * 大型 GeoJSON、格点数组和 valueRef.value 继续通过服务器引用使用，不在
 * 每次 run 状态变化时重复复制到桌面 IPC 或本机 CLI。
 */
export function projectRunSnapshotForTransport(input: RunSnapshot): RunSnapshot {
  const items = selectSnapshotItems(input.items).map(projectConversationItemForTransport)
  return runSnapshotSchema.parse({
    run: projectRunForTransport(input.run),
    items,
    events: input.events.slice(-MAX_SNAPSHOT_EVENTS).map(projectRunEventForTransport),
    itemStream: projectItemStreamCursors(input.itemStream, items),
  })
}

function selectSnapshotItems(items: readonly ConversationItem[]): ConversationItem[] {
  const selectedIds = new Set(items.slice(-MAX_SNAPSHOT_ITEMS).map(item => item.itemId))
  for (const item of items) {
    if (item.status === 'running') selectedIds.add(item.itemId)
  }
  return items.filter(item => selectedIds.has(item.itemId))
}

export function projectRunForTransport(run: AnalysisRun): AnalysisRun {
  const state = run.state
  return {
    ...run,
    // runtimeConfigSnapshot is an internal recovery fact and may contain MCP
    // headers/env credentials. It must never cross the ordinary client transport.
    runtimeConfigSnapshot: null,
    state: {
      ...state,
      agentWorkflow: state.agentWorkflow
        ? {
            ...state.agentWorkflow,
            steps: state.agentWorkflow.steps.map(step => ({
              ...step,
              args: projectRecord(step.args, 240, 8_000),
            })),
          }
        : null,
      contextReferences: state.contextReferences.map(reference => ({
        ...reference,
        metadata: projectRecord(reference.metadata, 160, 6_000),
      })),
      decisions: state.decisions.map(decision => ({
        ...decision,
        payload: projectRecord(decision.payload, 160, 6_000),
      })),
      approvals: state.approvals.map(approval => ({
        ...approval,
        payload: projectRecord(approval.payload, 160, 6_000),
      })),
      toolResults: state.toolResults.map(result => ({
        ...result,
        args: projectRecord(result.args, 240, 8_000),
        provenance: projectRecord(result.provenance, 160, 6_000),
        crs: projectRecord(result.crs, 80, 2_000),
        valueRefs: result.valueRefs.map(projectValueRefForTransport),
      })),
      toolValueRefs: state.toolValueRefs.map(projectValueRefForTransport),
      artifacts: state.artifacts.map(artifact => ({
        ...artifact,
        metadata: projectRecord(artifact.metadata, 240, 8_000),
      })),
    },
  }
}

export function projectConversationItemForTransport(
  input: ConversationItem,
): ConversationItem {
  const item = conversationItemSchema.parse(input)
  const isToolItem = item.itemType === 'function_call'
    || item.itemType === 'function_call_output'
  const isStreamedTextItem = item.itemType === 'message' || item.itemType === 'reasoning'
  return conversationItemSchema.parse({
    ...item,
    body: isStreamedTextItem
      ? item.body
      : projectOptionalText(
          item.body,
          isToolItem ? TOOL_TEXT_MAX_BYTES : MESSAGE_TEXT_MAX_BYTES,
          isToolItem,
        ),
    arguments: projectOptionalText(item.arguments, TOOL_TEXT_MAX_BYTES, true),
    output: projectOptionalText(item.output, TOOL_TEXT_MAX_BYTES, true),
    metadata: {
      ...projectRecord(item.metadata, 320, 12_000),
      ...(isToolItem ? { transportProjection: 'bounded_tool_record' } : {}),
    },
  })
}

function projectItemStreamCursors(
  stream: RunSnapshot['itemStream'],
  items: readonly ConversationItem[],
): RunSnapshot['itemStream'] {
  const projectedItems = new Map(items.map(item => [item.itemId, item]))
  return {
    streamId: stream.streamId,
    cursors: stream.cursors
      .filter(cursor => projectedItems.has(cursor.itemId))
      .map(cursor => ({
        ...cursor,
        utf16Offset: (projectedItems.get(cursor.itemId)?.body ?? '').length,
      })),
  }
}

export function projectRunEventForTransport(input: RunEvent): RunEvent {
  const event = runEventSchema.parse(input)
  return runEventSchema.parse({
    ...event,
    message: truncateUtf8(event.message, 4_000),
    payload: {
      ...projectRecord(event.payload, 240, 8_000),
      transportProjection: 'bounded_run_event',
    },
  })
}

function projectValueRefForTransport(reference: ToolValueRef): ToolValueRef {
  return {
    ...reference,
    value: null,
    metadata: {
      ...projectRecord(reference.metadata, 160, 6_000),
      transportProjection: 'server_value_ref',
    },
  }
}

function projectOptionalText(
  value: string | null,
  maxBytes: number,
  preferStructuredProjection: boolean,
): string | null {
  if (value === null || Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  if (preferStructuredProjection) {
    try {
      const parsed: unknown = JSON.parse(value)
      const projected = projectUnknown(parsed, { nodes: 360, stringCharacters: 12_000 }, 0)
      const envelope = isRecord(projected)
        ? { ...projected, transportProjection: 'bounded_json' }
        : { value: projected, transportProjection: 'bounded_json' }
      const serialized = JSON.stringify(envelope)
      if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized
    } catch {
      // 非 JSON 工具文本仍通过统一 UTF-8 预算截断，并显式标记。
    }
  }
  return `${truncateUtf8(value, maxBytes - 96)}\n[桌面传输投影：完整内容保留在服务器运行记录中]`
}

function projectRecord(
  value: Record<string, unknown>,
  nodes: number,
  stringCharacters: number,
): Record<string, unknown> {
  const projected = projectUnknown(value, { nodes, stringCharacters }, 0)
  return isRecord(projected) ? projected : {}
}

interface ProjectionBudget {
  nodes: number
  stringCharacters: number
}

function projectUnknown(
  value: unknown,
  budget: ProjectionBudget,
  depth: number,
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    const allowed = Math.max(0, Math.min(value.length, 4_000, budget.stringCharacters))
    budget.stringCharacters -= allowed
    return value.length <= allowed
      ? value
      : `${value.slice(0, allowed)}…[已省略 ${value.length - allowed} 字符]`
  }
  if (depth >= 6 || budget.nodes <= 0) return { omitted: true, reason: 'projection_budget' }
  budget.nodes -= 1
  if (Array.isArray(value)) {
    const output: unknown[] = []
    const limit = Math.min(value.length, 24)
    for (let index = 0; index < limit && budget.nodes > 0; index += 1) {
      output.push(projectUnknown(value[index], budget, depth + 1))
    }
    if (limit < value.length) output.push({ omittedItems: value.length - limit })
    return output
  }
  if (!isRecord(value)) return String(value)

  const output: Record<string, unknown> = {}
  const entries = Object.entries(value)
  const limit = Math.min(entries.length, 48)
  for (let index = 0; index < limit && budget.nodes > 0; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    output[entry[0]] = projectUnknown(entry[1], budget, depth + 1)
  }
  if (limit < entries.length) output.transportOmittedKeys = entries.length - limit
  return output
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const bytes = Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes))
  return bytes.toString('utf8').replace(/\uFFFD$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
