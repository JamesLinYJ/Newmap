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
  MAX_FILE_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  MAX_GEOJSON_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  MAX_METEOROLOGY_UPLOAD_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  MAX_GEOJSON_FEATURES: z.coerce.number().int().positive().default(50_000),
  MAX_GEOJSON_COORDINATES: z.coerce.number().int().positive().default(2_000_000),

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
  WORKER_SHARED_SECRET: z.string().min(32).optional(),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().default('eastasia'),
  AZURE_SPEECH_ENDPOINT: z.string().url().default('https://eastasia.api.cognitive.microsoft.com'),
  AZURE_SPEECH_DEFAULT_LANGUAGE: z.string().default('zh-CN'),
  AZURE_SPEECH_SUPPORTED_LANGUAGES: z.string().default('zh-CN,en-US,ja-JP,ko-KR'),
  AZURE_SPEECH_DEFAULT_VOICE: z.string().default('zh-CN-XiaoxiaoNeural'),
  SANDBOX_BACKEND: z.enum(['docker', 'unix_local']).default('docker'),
  SANDBOX_DOCKER_IMAGE: z.string().default('node:22-bookworm-slim'),
  ENABLED_TOOL_PROVIDERS: z.string(),
  DEVELOPER_TOOL_ALLOWED_ROOTS: z.string().optional(),
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
