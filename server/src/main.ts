// +-------------------------------------------------------------------------
//
//   地理智能平台 - Node API 与 WebSocket 服务入口
//
//   文件:       main.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 workspaces 子目录启动时，dotenv 需要指向项目根目录的 .env
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
dotenv.config({ path: path.join(projectRoot, '.env') })

import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { setTracingDisabled } from '@openai/agents'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sql } from 'drizzle-orm'
import { createDb } from './db/connection.js'
import { defaultRuntimeConfig } from './agent/defaultRuntimeConfig.js'
import { getEnv } from './framework/env.js'
import { discoverAndLoad } from './framework/loader.js'
import { toolRegistry } from './framework/registry.js'
import { PostGisRepository } from './gis/postgis.js'
import { ModelAdapterRegistry } from './model/registry.js'
import { artifactRoutes } from './routes/artifacts.js'
import { fileRoutes } from './routes/files.js'
import { layerRoutes } from './routes/layers.js'
import { mapRoutes } from './routes/map.js'
import { ensureMeteorologicalTables, meteorologyRoutes } from './routes/meteorology.js'
import { PostgresPlatformStore } from './store/platformStore.js'
import { createWsHandler } from './ws/handler.js'
import { seedLayersFromDirectory } from './gis/seedLayers.js'
import { ensureSecurityTables } from './security/database.js'
import { BetterAuthService } from './security/authService.js'
import { AuthorizationError, AuthorizationService } from './security/authorizationService.js'
import { requireHttpAuth, securityRoutes, type SecurityServices } from './security/routes.js'
import { installLifecycleManager } from './lifecycle.js'

// GeoForge 不向外部 tracing 后端发送 Agent 数据；Runner 级配置负责每次运行，
// 全局开关覆盖 SDK 创建根 trace 和嵌套 Agent 工具的生命周期。
setTracingDisabled(true)

const env = getEnv()
const db = createDb(env.DATABASE_URL)
const runtimeRoot = path.resolve(env.RUNTIME_ROOT)
const store = new PostgresPlatformStore(db, path.join(runtimeRoot, 'conversations'))
const postgis = new PostGisRepository(db)
const modelRegistry = new ModelAdapterRegistry(env)
const runtimeConfigDefaults = defaultRuntimeConfig({
  sandbox: {
    backend: env.SANDBOX_BACKEND,
    dockerImage: env.SANDBOX_DOCKER_IMAGE,
  },
})

// 数据库结构必须先于运行历史索引恢复完成。
// store.initialize 会扫描 runtime artifact 并回写平台索引，安全列和气象表缺失时必须直接失败。
await ensureMeteorologicalTables(db)
await ensureSecurityTables(db)
// 文件型 manifest 与分片 JSONL 是事实源；监听前只恢复轻量索引和 run 检查点。
await store.initialize()
if (env.SEED_LAYERS_DIR) {
  const seedDirectory = path.resolve(projectRoot, env.SEED_LAYERS_DIR)
  const seededLayers = await seedLayersFromDirectory(postgis, seedDirectory)
  console.log(`[layers] seeded ${seededLayers.length} layers from ${seedDirectory}`)
}
await discoverAndLoad(postgis)

const app = new Hono()
const security: SecurityServices = {
  auth: new BetterAuthService(db, env),
  authorization: new AuthorizationService(db),
  db,
}
const trustedOrigins = new Set([
  ...security.auth.trustedOrigins(),
  env.APP_BASE_URL.replace(/\/+$/u, ''),
  ...(env.WEB_BASE_URL ? [env.WEB_BASE_URL.replace(/\/+$/u, '')] : []),
])
let isShuttingDown = false
app.use('*', cors({
  origin: origin => origin && trustedOrigins.has(origin.replace(/\/+$/u, '')) ? origin : '',
  credentials: true,
  allowHeaders: ['Content-Type', env.CSRF_HEADER_NAME],
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
}))
app.use('*', async (c, next) => {
  if (isShuttingDown && c.req.path !== '/health') return c.json({ detail: '服务正在关闭，请稍后重试。' }, 503)
  await next()
})
app.get('/health', async c => {
  const health = await checkReadiness()
  return c.json(health, health.status === 'ok' ? 200 : 503)
})
app.on(['GET', 'POST'], '/api/auth/*', c => security.auth.handler(c.req.raw))
app.use('/api/v1/*', (c, next) => requireHttpAuth(security, c, next))
app.route('/', securityRoutes(security))
app.route('/', fileRoutes(runtimeRoot, store, security, env))
app.route('/', layerRoutes(postgis, store, security, env))
app.route('/', artifactRoutes(db, runtimeRoot, security))
app.route('/', mapRoutes)
app.route('/', meteorologyRoutes(db, runtimeRoot, store, security, env))
app.onError((error, c) => {
  if (error instanceof AuthorizationError) return c.json({ detail: error.message }, 403)
  if (error.message === '未登录。') return c.json({ detail: '未登录' }, 401)
  console.error('[api] request failed:', error)
  return c.json({ detail: '服务处理失败。请查看服务端日志。' }, 500)
})
app.notFound(c => c.json({ detail: 'Not found' }, 404))

const server = createServer(getRequestListener(app.fetch))
const wsServer = createWsHandler(server, {
  store,
  toolRegistry,
  modelRegistry,
  postgis,
  runtimeRoot,
  defaultRuntimeConfig: runtimeConfigDefaults,
  security,
})
installLifecycleManager({
  server,
  wsServer,
  store,
  db,
  onShutdownStart: () => { isShuttingDown = true },
})

server.listen(env.API_PORT, env.API_HOST, () => {
  console.log(`server listening on http://${env.API_HOST}:${env.API_PORT}`)
  console.log(`[tools] ${toolRegistry.list().length} tools from ${toolRegistry.listProviders().length} providers`)
})

async function checkReadiness(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}
  try {
    await db.execute(sql`SELECT 1`)
    checks.database = { ok: true }
  } catch (error) {
    checks.database = { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }

  const postgisStatus = await postgis.status()
  checks.postgis = postgisStatus.available ? { ok: true } : { ok: false, detail: postgisStatus.error ?? 'PostGIS 不可用' }

  if (env.WORKER_URL) {
    try {
      const response = await fetch(new URL('/health', env.WORKER_URL).toString(), { signal: AbortSignal.timeout(2_000) })
      checks.worker = response.ok ? { ok: true } : { ok: false, detail: `Worker HTTP ${response.status}` }
    } catch (error) {
      checks.worker = { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    status: Object.values(checks).every(check => check.ok) ? 'ok' : 'degraded',
    checks,
  }
}
