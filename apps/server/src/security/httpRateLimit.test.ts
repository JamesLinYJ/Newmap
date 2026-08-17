// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 认证限流测试
//
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createAuthRateLimitMiddleware } from './httpRateLimit.js'

class CountingLimiter {
  private readonly counts = new Map<string, number>()

  constructor(private readonly limit: number) {}

  consume(key: string): boolean {
    const next = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, next)
    return next <= this.limit
  }
}

describe('authRateLimitMiddleware', () => {
  it('cannot be bypassed by rotating email identities behind one IP', async () => {
    const app = authApp({
      ipLimiter: new CountingLimiter(2),
      identityLimiter: new CountingLimiter(100),
    })

    expect((await post(app, 'first@example.com')).status).toBe(200)
    expect((await post(app, 'second@example.com')).status).toBe(200)
    const blocked = await post(app, 'third@example.com')

    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toEqual({ detail: '请求过于频繁，请稍后重试。' })
  })

  it('keeps a separate fine-grained identity budget after the IP admission', async () => {
    const app = authApp({
      ipLimiter: new CountingLimiter(100),
      identityLimiter: new CountingLimiter(1),
    })

    expect((await post(app, 'same@example.com')).status).toBe(200)
    expect((await post(app, 'same@example.com')).status).toBe(429)
    expect((await post(app, 'different@example.com')).status).toBe(200)
  })

  it('rejects declared and streamed oversized JSON before Better Auth receives it', async () => {
    const declared = authApp({
      ipLimiter: new CountingLimiter(100),
      identityLimiter: new CountingLimiter(100),
      maxBodyInspectionBytes: 32,
    })
    const declaredResponse = await declared.request('http://localhost/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '1024',
      },
      body: '{}',
    }, requestEnvironment())
    expect(declaredResponse.status).toBe(413)

    const streamed = authApp({
      ipLimiter: new CountingLimiter(100),
      identityLimiter: new CountingLimiter(100),
      maxBodyInspectionBytes: 8,
    })
    const streamedResponse = await streamed.request('http://localhost/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'large@example.com' }),
    }, requestEnvironment())
    expect(streamedResponse.status).toBe(413)
    await expect(streamedResponse.json()).resolves.toEqual({
      detail: '认证请求体过大，检查上限为 8 字节。',
    })
  })

  it('leaves the original bounded body readable by the downstream auth handler', async () => {
    const app = authApp({
      ipLimiter: new CountingLimiter(100),
      identityLimiter: new CountingLimiter(100),
      maxBodyInspectionBytes: 1024,
    })

    const response = await post(app, 'User@Example.com')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ email: 'User@Example.com' })
  })
})

function authApp(options: Parameters<typeof createAuthRateLimitMiddleware>[0]): Hono {
  const app = new Hono()
  app.post('/auth', createAuthRateLimitMiddleware(options), async context => {
    const payload = await context.req.json<{ email?: string }>()
    return context.json({ email: payload.email ?? null })
  })
  return app
}

function post(app: Hono, email: string): Promise<Response> {
  return app.request('http://localhost/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  }, requestEnvironment())
}

function requestEnvironment() {
  return { incoming: { socket: { remoteAddress: '203.0.113.10' } } }
}
