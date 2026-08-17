// +-------------------------------------------------------------------------
//
//   地理智能平台 - 滑动窗口限流
//
//   文件:       rateLimiter.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

/** 单进程令牌桶限流器。生产多实例部署时应替换为共享计数后端。 */
export class SlidingWindowRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>()

  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number,
  ) {}

  /** 消费一个令牌。返回 true 表示允许，false 表示触发限流。 */
  consume(key: string): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key)

    if (!bucket) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, lastRefill: now })
      this.prune()
      return true
    }

    const elapsed = now - bucket.lastRefill
    if (elapsed >= this.windowMs) {
      bucket.tokens = this.maxTokens - 1
      bucket.lastRefill = now
      this.prune()
      return true
    }

    const refill = (elapsed / this.windowMs) * this.maxTokens
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill)
    bucket.lastRefill = now

    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** 返回 key 还剩多少 token */
  remaining(key: string): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return this.maxTokens
    return Math.floor(bucket.tokens)
  }

  delete(key: string): void {
    this.buckets.delete(key)
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs * 2
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key)
    }
  }
}

/**
 * Better Auth 使用两层独立预算：IP 是不可由请求体轮换的粗粒度边界，
 * identity 是 IP+规范化身份的细粒度边界。
 */
export function createAuthIpRateLimiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(30, 60_000) // 30 req/min/IP
}

export function createAuthIdentityRateLimiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(10, 60_000) // 10 req/min/IP+identity
}

/** 保留旧工厂名作为 identity limiter 的明确别名。 */
export function createAuthRateLimiter(): SlidingWindowRateLimiter {
  return createAuthIdentityRateLimiter()
}

export function createApiRateLimiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(120, 60_000) // 120 req/min
}

/**
 * 从适配器提供的 socket 地址提取客户端 IP。
 *
 * `Request` 本身没有可信的 peer address；X-Forwarded-For/X-Real-IP 都是
 * 请求头，不能在没有可信代理边界的情况下参与限流 key。Node Hono 适配器
 * 由调用方传入 `request.socket.remoteAddress`，其它适配器缺少 peer 地址时
 * 使用固定 unknown key，而不是接受可伪造的请求头。
 */
export function clientIp(_request: Request, options: { remoteAddress?: string | null } = {}): string {
  const remoteAddress = options.remoteAddress?.trim()
  if (remoteAddress) return remoteAddress
  return 'unknown'
}

/** WS 消息限流器：按连接总量和同一连接的命令类型分别限流。 */
export class WsMessageRateLimiter {
  private connectionLimiter: SlidingWindowRateLimiter
  private commandLimiters = new Map<string, SlidingWindowRateLimiter>()

  constructor(
    maxPerConnectionPerWindow: number = 60,
    private readonly windowMs: number = 60_000,
    private readonly maxPerCommandTypePerWindow: number = 20,
  ) {
    this.connectionLimiter = new SlidingWindowRateLimiter(maxPerConnectionPerWindow, windowMs)
  }

  /** 对指定连接的指定命令类型消费令牌。返回 true 表示允许。 */
  consume(connectionId: string, commandType: string): boolean {
    if (!this.connectionLimiter.consume(connectionId)) return false

    let cmdLimiter = this.commandLimiters.get(commandType)
    if (!cmdLimiter) {
      cmdLimiter = new SlidingWindowRateLimiter(this.maxPerCommandTypePerWindow, this.windowMs)
      this.commandLimiters.set(commandType, cmdLimiter)
    }
    return cmdLimiter.consume(connectionId)
  }

  releaseConnection(connectionId: string): void {
    this.connectionLimiter.delete(connectionId)
    for (const limiter of this.commandLimiters.values()) limiter.delete(connectionId)
  }
}
