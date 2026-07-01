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

// 文件型 manifest 与分片 JSONL 是事实源；监听前只恢复轻量索引和 run 检查点。
await store.initialize()
await ensureMeteorologicalTables(db)
if (env.SEED_LAYERS_DIR) {
  const seedDirectory = path.resolve(projectRoot, env.SEED_LAYERS_DIR)
  const seededLayers = await seedLayersFromDirectory(postgis, seedDirectory)
  console.log(`[layers] seeded ${seededLayers.length} layers from ${seedDirectory}`)
}
await discoverAndLoad(postgis)

const app = new Hono()
app.use('*', cors())
app.get('/health', c => c.json({ status: 'ok' }))
app.route('/', fileRoutes(runtimeRoot, store))
app.route('/', layerRoutes(postgis, store))
app.route('/', artifactRoutes(db, runtimeRoot))
app.route('/', mapRoutes)
app.route('/', meteorologyRoutes(db, runtimeRoot, store))
app.notFound(c => c.json({ detail: 'Not found' }, 404))

const server = createServer(getRequestListener(app.fetch))
createWsHandler(server, {
  store,
  toolRegistry,
  modelRegistry,
  postgis,
  runtimeRoot,
  defaultRuntimeConfig: runtimeConfigDefaults,
})

server.listen(env.API_PORT, env.API_HOST, () => {
  console.log(`server listening on http://${env.API_HOST}:${env.API_PORT}`)
  console.log(`[tools] ${toolRegistry.list().length} tools from ${toolRegistry.listProviders().length} providers`)
})
