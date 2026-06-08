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
  PORT: z.coerce.number(),
  HOST: z.string(),
  DATABASE_URL: z.string(),
  RUNTIME_ROOT: z.string(),

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
  PYTHON_TOOLS: z.string().optional(),

  // 额外 tool 目录
  TOOL_DIRS: z.string().optional(),
  // Tianditu
  TIANDITU_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let _env: Env | null = null

export function getEnv(): Env {
  if (_env) return _env
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const missing = result.error.issues
      .filter(i => i.code === 'invalid_type' && i.received === 'undefined')
      .map(i => i.path.join('.'))
    console.error('[env] 缺少必填环境变量:', missing.join(', '))
    process.exit(1)
  }
  _env = result.data
  return _env
}
