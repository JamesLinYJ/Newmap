// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象 Worker 短期请求签名
//
//   文件:       workerAuth.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'

const WORKER_TOKEN_TTL_SECONDS = 60

const workerTokenPayloadSchema = z.object({
  v: z.literal(1),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  nonce: z.string().min(16),
  toolName: z.string().min(1),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
})

type WorkerTokenPayload = z.infer<typeof workerTokenPayloadSchema>

// Worker 请求签名把工具名、请求体哈希和短期过期时间绑定在一起。
// Python sidecar 只接受这个 envelope，不再接受长期密钥作为 Bearer token。
export function signWorkerRequest(secret: string, toolName: string, body: string, nowMs = Date.now()): string {
  const nowSeconds = Math.floor(nowMs / 1000)
  const payload: WorkerTokenPayload = {
    v: 1,
    iat: nowSeconds,
    exp: nowSeconds + WORKER_TOKEN_TTL_SECONDS,
    nonce: randomUUID(),
    toolName,
    bodyHash: createHash('sha256').update(body).digest('hex'),
  }
  const encodedPayload = Buffer.from(JSON.stringify(workerTokenPayloadSchema.parse(payload)), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url')
  return `GeoForge-Worker ${encodedPayload}.${signature}`
}
