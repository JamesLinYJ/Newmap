// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 限流中间件（Hono）
//
//   文件:       httpRateLimit.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'
import {
  clientIp,
  createApiRateLimiter,
  createAuthIdentityRateLimiter,
  createAuthIpRateLimiter,
} from './rateLimiter.js'
import type { SecurityServices } from './routes.js'

const MAX_AUTH_BODY_INSPECTION_BYTES = 16 * 1024
const apiLimiter = createApiRateLimiter()

interface RateLimiterPort {
  consume(key: string): boolean
}

export interface AuthRateLimitMiddlewareOptions {
  ipLimiter?: RateLimiterPort
  identityLimiter?: RateLimiterPort
  maxBodyInspectionBytes?: number
}

/**
 * Better Auth 入口先消费不可由请求体轮换的 IP 预算，再在有界 JSON 读取后
 * 消费 IP+identity 预算。邮箱只以摘要进入 limiter key，既不能通过轮换邮箱
 * 绕过 IP 边界，也不会把原始身份长期保留在高基数内存 key 中。
 */
export function createAuthRateLimitMiddleware(
  options: AuthRateLimitMiddlewareOptions = {},
) {
  const ipLimiter = options.ipLimiter ?? createAuthIpRateLimiter()
  const identityLimiter = options.identityLimiter ?? createAuthIdentityRateLimiter()
  const maxBodyInspectionBytes = options.maxBodyInspectionBytes ?? MAX_AUTH_BODY_INSPECTION_BYTES
  if (!Number.isSafeInteger(maxBodyInspectionBytes) || maxBodyInspectionBytes <= 0) {
    throw new Error('认证限流请求体检查上限必须是正整数。')
  }

  return async (c: Context, next: Next): Promise<void | Response> => {
    const ip = clientIp(c.req.raw, { remoteAddress: requestRemoteAddress(c) })
    if (!ipLimiter.consume(`auth:ip:${ip}`)) return rateLimited(c)

    let identity: string | null = null
    try {
      identity = await normalizedAuthIdentity(c.req.raw, maxBodyInspectionBytes)
    } catch (error) {
      if (error instanceof AuthBodyTooLargeError) {
        return c.json({ detail: error.message }, 413)
      }
      throw error
    }

    if (identity) {
      const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)
      if (!identityLimiter.consume(`auth:identity:${ip}:${digest}`)) return rateLimited(c)
    }
    await next()
  }
}

export const authRateLimitMiddleware = createAuthRateLimitMiddleware()

/** /api/v1/* 按用户或 IP 限流 */
export function apiRateLimitMiddleware(security: SecurityServices) {
  return async (c: Context, next: Next): Promise<void | Response> => {
    const ip = clientIp(c.req.raw, { remoteAddress: requestRemoteAddress(c) })
    let userId: string | null = null
    try {
      const auth = await security.auth.authenticateRequest(c.req.raw)
      userId = auth?.userId ?? null
    } catch {
      // 认证状态不可用时仅改变限流维度；后续鉴权仍决定请求能否进入业务处理。
    }
    const key = userId ? `api:user:${userId}` : `api:ip:${ip}`

    if (!apiLimiter.consume(key)) {
      return c.json({ detail: '请求过于频繁，请稍后重试。' }, 429)
    }
    await next()
  }
}

class AuthBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`认证请求体过大，检查上限为 ${limit} 字节。`)
    this.name = 'AuthBodyTooLargeError'
  }
}

function rateLimited(c: Context): Response {
  return c.json({ detail: '请求过于频繁，请稍后重试。' }, 429)
}

function requestRemoteAddress(c: Context): string | null {
  const environment = c.env as {
    incoming?: { socket?: { remoteAddress?: string | undefined } }
  } | undefined
  return environment?.incoming?.socket?.remoteAddress ?? null
}

async function normalizedAuthIdentity(request: Request, limit: number): Promise<string | null> {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return null
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) return null
  rejectOversizedContentLength(request.headers.get('content-length'), limit)

  const text = await readRequestTextBounded(request, limit)
  if (!text.trim()) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || typeof parsed.email !== 'string') return null
    const normalized = parsed.email.trim().toLowerCase()
    return normalized || null
  } catch {
    // 非法 JSON 仍受不可轮换的 IP 预算约束，具体格式错误由 Better Auth 返回。
    return null
  }
}

async function readRequestTextBounded(request: Request, limit: number): Promise<string> {
  const clone = request.clone()
  if (!clone.body) return ''
  const reader = clone.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytesRead += result.value.byteLength
      if (bytesRead > limit) {
        // Request.clone() 使用 tee。等待单个分支的 cancel promise 会一直等到
        // 原始分支也结束；这里只发出取消信号并显式吸收其异步拒绝，随后立即
        // 返回 413，让 Hono 可以结束原始请求，而不是在限流中间件内死锁。
        void reader.cancel('auth body inspection limit exceeded').catch(() => undefined)
        throw new AuthBodyTooLargeError(limit)
      }
      text += decoder.decode(result.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function rejectOversizedContentLength(value: string | null, limit: number): void {
  if (!value) return
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed > limit) {
    throw new AuthBodyTooLargeError(limit)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
