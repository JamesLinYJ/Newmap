// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面协议
//
//   文件:       protocol.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { z } from 'zod'

export const clientMsgType = z.enum([
  'workspace:bootstrap',
  'session:get-default', 'session:get',
  'thread:list', 'thread:get', 'thread:create', 'thread:update', 'thread:delete',
  'thread:history', 'thread:fork', 'thread:compact', 'thread:context',
  'thread:subscribe', 'thread:unsubscribe',
  'thread:memory:get', 'thread:memory:update', 'thread:memory:rebuild',
  'thread:trash:list', 'thread:trash:restore', 'thread:trash:purge',
  'run:list', 'run:start', 'run:get', 'run:cancel', 'run:resume', 'run:respond-decision', 'run:subscribe', 'run:unsubscribe',
  'tool:list', 'tool:run',
  'tool-catalog:list', 'tool-catalog:upsert', 'tool-catalog:delete',
  'runtime-config:get', 'runtime-config:update',
  'provider:list', 'system:get',
  'speech:authorization',
  'memory:list', 'memory:read', 'memory:write', 'memory:delete', 'memory:search',
  'memory:extract', 'memory:dream',
  'memory:session:get', 'memory:session:rebuild',
  'memory:instructions:list',
  'file:list', 'file:delete',
  'layer:list', 'layer:update', 'layer:delete',
])

export const clientMsgSchema = z.object({
  type: clientMsgType,
  id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).prefault({}),
})

export type ClientMsg = z.infer<typeof clientMsgSchema>

export function parseMessage(raw: string): ClientMsg {
  return clientMsgSchema.parse(JSON.parse(raw))
}

export function success(id: string, data: unknown): string {
  return format({ type: 'response', id, payload: { ok: true, data } })
}

export function failure(id: string | null, code: string, message: string): string {
  return format({ type: 'response', id, payload: { ok: false, error: { code, message } } })
}

export function push(
  type: 'run.item' | 'run.event' | 'run.snapshot'
    | 'thread.entry' | 'thread.updated' | 'thread.compacted' | 'thread.memory.updated'
    | 'keepalive',
  data: unknown,
): string {
  return format({ type, id: null, payload: { data } })
}

function format(message: { type: string; id: string | null; payload: Record<string, unknown> }): string {
  return JSON.stringify(message) + '\n'
}
