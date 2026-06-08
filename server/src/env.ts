// +-------------------------------------------------------------------------
//
//   地理智能平台 - 环境配置
//
//   文件:       env.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(8011),
  HOST: z.string().default('0.0.0.0'),
  APP_ENV: z.enum(['development', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/geoagent'),
  RUNTIME_ROOT: z.string().default('runtime'),

  // Model providers
  DEFAULT_MODEL_PROVIDER: z.string().default('openai_compatible'),
  DEFAULT_MODEL_NAME: z.string().default(''),
  OPENAI_BASE_URL: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(''),
  OPENAI_SUBAGENT_MODEL: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default(''),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  GEMINI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default(''),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default(''),

  // GIS
  TIANDITU_API_KEY: z.string().default(''),
  NOMINATIM_BASE_URL: z.string().default('https://nominatim.openstreetmap.org'),
  OVERPASS_BASE_URL: z.string().default('https://overpass-api.de/api/interpreter'),

  // Python sidecar
  WORKER_URL: z.string().default('http://localhost:8012'),
})

export type Env = z.infer<typeof envSchema>

let _env: Env | null = null

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env)
  }
  return _env
}

export function resolveRuntimeRoot(): string {
  return getEnv().RUNTIME_ROOT
}
