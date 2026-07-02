// +-------------------------------------------------------------------------
//
//   地理智能平台 - Vitest 安全环境启动器
//
//   文件:       run-vitest-with-env.mjs
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaults = {
  APP_BASE_URL: 'http://127.0.0.1:8000',
  WEB_BASE_URL: 'http://127.0.0.1:5173',
  BETTER_AUTH_SECRET: 'test-only-better-auth-secret-change-before-production',
  BETTER_AUTH_ALLOW_SIGN_UP: 'true',
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
  BETTER_AUTH_MIN_PASSWORD_LENGTH: '12',
  CSRF_HEADER_NAME: 'x-geoforge-csrf',
  TRUSTED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
  WORKER_SHARED_SECRET: 'test-only-worker-shared-secret-change-before-production',
}

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value
}
if (!process.env.BETTER_AUTH_URL) process.env.BETTER_AUTH_URL = process.env.APP_BASE_URL

const __dirname = path.dirname(fileURLToPath(import.meta.url))
if (!process.env.GEOFORGE_MEMORY_BASE_DIR) {
  process.env.GEOFORGE_MEMORY_BASE_DIR = path.resolve(__dirname, '..', '.tmp-test-memory')
}
const vitestEntrypoint = path.resolve(__dirname, '..', '..', 'node_modules', 'vitest', 'vitest.mjs')

const child = spawn(process.execPath, [vitestEntrypoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', code => process.exit(code ?? 1))
