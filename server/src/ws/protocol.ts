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
  'run:list', 'run:start', 'run:get', 'run:cancel', 'run:resolve-approval', 'run:subscribe', 'run:unsubscribe',
  'tool:list', 'tool:run',
  'tool-catalog:list', 'tool-catalog:upsert', 'tool-catalog:delete',
  'runtime-config:get', 'runtime-config:update',
  'provider:list', 'system:get',
  'file:list', 'file:delete',
  'layer:list', 'layer:update', 'layer:delete',
])

export const clientMsgSchema = z.object({
  type: clientMsgType,
  id: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
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

export function push(type: 'run.item' | 'run.event' | 'run.snapshot' | 'keepalive', data: unknown): string {
  return format({ type, id: null, payload: { data } })
}

function format(message: { type: string; id: string | null; payload: Record<string, unknown> }): string {
  return JSON.stringify(message) + '\n'
}
