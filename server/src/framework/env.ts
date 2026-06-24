// +-------------------------------------------------------------------------
//
//   地理智能平台 - 环境配置（零默认值，严格校验）
//
//   文件:       env.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { z } from 'zod'

const envSchema = z.object({
  API_PORT: z.coerce.number(),
  API_HOST: z.string(),
  DATABASE_URL: z.string(),
  RUNTIME_ROOT: z.string(),
  SEED_LAYERS_DIR: z.string().optional(),

  // 模型 providers（至少一个）
  DEFAULT_MODEL_PROVIDER: z.string().optional(),
  DEFAULT_MODEL_NAME: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_SUBAGENT_MODEL: z.string().optional(),

  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_VERSION: z.string().optional(),

  GEMINI_BASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),

  OLLAMA_BASE_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().optional(),

  // Python sidecar + Python tools
  WORKER_URL: z.string().optional(),
  MEDIA_WORKER_URL: z.string().optional(),
  ENABLED_TOOL_PROVIDERS: z.string(),
  VALHALLA_BASE_URL: z.string().url().optional(),
  ROUTING_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Tianditu
  TIANDITU_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let _env: Env | null = null

export function getEnv(): Env {
  if (_env) return _env
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const field = issue.path.join('.') || 'environment'
      return `${field}: ${issue.message}`
    })
    console.error('[env] 环境变量校验失败:', details.join('；'))
    process.exit(1)
  }
  _env = result.data
  return _env
}
