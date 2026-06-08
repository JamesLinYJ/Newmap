// +-------------------------------------------------------------------------
//
//   地理智能平台 - Hono 应用装配
//
//   文件:       app.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './env.js'
import { createDb } from './db/connection.js'
import { PostgresPlatformStore } from './store/platformStore.js'
import { ModelAdapterRegistry } from './model/registry.js'
import { buildRegistry, type ToolRegistry } from './tools.js'
import { PostGisRepository } from './gis/postgis.js'
import { healthRoute } from './routes/health.js'
import { sessionRoutes } from './routes/sessions.js'
import { threadRoutes } from './routes/threads.js'
import { configRoutes } from './routes/config.js'
import { toolRoutes } from './routes/tools.js'
import { runRoutes } from './routes/runs.js'
import { weatherRoutes } from './routes/weather.js'
import path from 'node:path'

// App context type for Hono Variables
type AppVariables = {
  store: PostgresPlatformStore
  modelRegistry: ModelAdapterRegistry
  toolRegistry: ToolRegistry
}

export type AppContext = { Variables: AppVariables }

export function createApp(env: Env) {
  const app = new Hono<AppContext>()

  // Middleware
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
  }))

  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    c.res.headers.set('X-Frame-Options', 'DENY')
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  })

  // Infrastructure
  const db = createDb(env.DATABASE_URL)
  const storageRoot = path.resolve(env.RUNTIME_ROOT, 'sessions-ts')
  const store = new PostgresPlatformStore(db, storageRoot)
  const postgis = new PostGisRepository(db)
  const modelRegistry = new ModelAdapterRegistry(env)
  const toolRegistry = buildRegistry({ postgis })

  // Store references on context
  app.use('*', async (c, next) => {
    c.set('store', store)
    c.set('modelRegistry', modelRegistry)
    c.set('toolRegistry', toolRegistry)
    await next()
  })

  // Routes
  app.route('/', healthRoute)
  app.route('/', sessionRoutes(store))
  app.route('/', threadRoutes(store))
  app.route('/', configRoutes(modelRegistry, toolRegistry, store))
  app.route('/', toolRoutes(toolRegistry, store))
  app.route('/', runRoutes(store, toolRegistry, modelRegistry))
  app.route('/', weatherRoutes)

  // Initialize store (load sessions/threads from JSONL)
  store.initialize().catch(err => console.error('Store init error:', err))

  return { app, store }
}
