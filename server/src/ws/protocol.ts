// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 消息协议
//
//   文件:       protocol.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 所有 WS 通信走 NDJSON message-passing，每条消息一行 JSON。
// 请求消息带 id，回复带相同 id。流式推送不带 id。

import { z } from 'zod'

// --- 消息类型枚举 ---

export const clientMsgType = z.enum([
  'session:create', 'session:get', 'session:list',
  'thread:create', 'thread:get', 'thread:update', 'thread:delete', 'thread:list',
  'run:start', 'run:cancel', 'run:approve',
  'tool:list', 'layer:list', 'config:get', 'config:set',
])

export const serverMsgType = z.enum([
  'session', 'thread', 'run',
  'item:started', 'item:delta', 'item:completed',
  'tool:call', 'tool:result',
  'approval:required',
  'tool:list', 'layer:list', 'config',
  'result', 'error', 'keepalive',
])

// --- 客户端消息 ---

export const clientMsgSchema = z.object({
  type: clientMsgType,
  id: z.string(),  // request id for correlation
  payload: z.record(z.unknown()).default({}),
})

export type ClientMsg = z.infer<typeof clientMsgSchema>

// --- 服务端消息 ---

export const serverMsgSchema = z.object({
  type: serverMsgType,
  id: z.string().nullable().default(null),  // null for pushes
  payload: z.record(z.unknown()).default({}),
})

export type ServerMsg = z.infer<typeof serverMsgSchema>

// --- 具体 payload 类型 ---

export const runStartPayload = z.object({
  query: z.string(),
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  provider: z.string().default('openai_compatible'),
  modelName: z.string().nullable().default(null),
  executionMode: z.enum(['plan', 'auto']).default('auto'),
})

export const threadCreatePayload = z.object({
  sessionId: z.string(),
  title: z.string().nullable().default(null),
})

export const threadUpdatePayload = z.object({
  threadId: z.string(),
  title: z.string(),
})

export const approvePayload = z.object({
  runId: z.string(),
  approvalId: z.string(),
  approved: z.boolean(),
})

// --- 工具函数 ---

export function parseMessage(raw: string): ClientMsg | null {
  try {
    const parsed = clientMsgSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function formatMsg(type: string, payload: Record<string, unknown> = {}, id: string | null = null): string {
  return JSON.stringify({ type, id, payload }) + '\n'
}
