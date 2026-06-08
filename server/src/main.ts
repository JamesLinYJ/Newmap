import 'dotenv/config'

import { createServer } from 'node:http'
import { getEnv } from './framework/env.js'
import { discoverAndLoad } from './framework/loader.js'
import { toolRegistry } from './framework/registry.js'
import { createDb } from './db/connection.js'
import { PostgresPlatformStore, StoreNotFoundError } from './store/platformStore.js'
import { ModelAdapterRegistry } from './model/registry.js'
import { createWsHandler } from './ws/handler.js'
import path from 'node:path'

const env = getEnv()

// Infrastructure
const db = createDb(env.DATABASE_URL)
const storageRoot = path.resolve(env.RUNTIME_ROOT, 'sessions-ts')
const store = new PostgresPlatformStore(db, storageRoot)
const modelRegistry = new ModelAdapterRegistry(env)

await discoverAndLoad()

function json(res: import('node:http').ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const seg = url.pathname.split('/').filter(Boolean)  // ['api','v1','sessions',':id']

  try {
    // Health
    if (req.method === 'GET' && url.pathname === '/') { json(res, 200, { status: 'ok' }); return }

    // Sessions
    if (seg[0] === 'api' && seg[1] === 'v1' && seg[2] === 'sessions') {
      if (req.method === 'POST' && seg.length === 3) { json(res, 200, await store.createSession()); return }
      if (req.method === 'GET' && seg[3] === 'default') { json(res, 200, await store.getOrCreateDefaultSession()); return }
      if (req.method === 'GET' && seg.length === 4) { json(res, 200, store.getSession(seg[3])); return }
      if (req.method === 'GET' && seg[4] === 'threads') { json(res, 200, store.listThreadsForSession(seg[3])); return }
      if (req.method === 'GET' && seg[4] === 'runs') { json(res, 200, store.listRunsForSession(seg[3])); return }
    }

    // Threads (v2)
    if (seg[0] === 'api' && seg[1] === 'v2' && seg[2] === 'threads') {
      if (req.method === 'POST' && seg.length === 3) {
        const body = await readBody(req)
        json(res, 200, await store.createThread(body.sessionId, body.title)); return
      }
      if (req.method === 'GET' && seg.length === 4) {
        const runs = store.listRunsForThread(seg[3])
        json(res, 200, { thread: store.getThread(seg[3]), runs, latestRun: runs[0] ?? null }); return
      }
      if (req.method === 'PATCH' && seg.length === 4) {
        const body = await readBody(req)
        json(res, 200, await store.updateThread(seg[3], { title: body.title })); return
      }
      if (req.method === 'DELETE' && seg.length === 4) {
        await store.deleteThread(seg[3]); json(res, 200, { deleted: true, threadId: seg[3] }); return
      }
    }

    // Runs (v2)
    if (seg[0] === 'api' && seg[1] === 'v2' && seg[2] === 'runs') {
      if (req.method === 'POST' && seg.length === 3) {
        const body = await readBody(req)
        const run = store.createRun(body.sessionId, body.query, {
          threadId: body.threadId ?? null,
          modelProvider: body.modelProvider ?? null,
          modelName: body.modelName ?? null,
        })
        json(res, 200, run); return
      }
      if (req.method === 'GET' && seg.length === 4) {
        json(res, 200, store.getRun(seg[3])); return
      }
    }

    // Providers / Tools / System / Config
    if (req.method === 'GET' && url.pathname === '/api/v1/providers') { json(res, 200, modelRegistry.descriptors()); return }
    if (req.method === 'GET' && url.pathname === '/api/v1/tools') { json(res, 200, toolRegistry.descriptors()); return }
    if (req.method === 'GET' && url.pathname === '/api/v1/tools/catalog') { json(res, 200, []); return }
    if (req.method === 'GET' && url.pathname === '/api/v1/system/components') {
      json(res, 200, { catalogBackend: 'ts', postgisEnabled: true, providers: modelRegistry.descriptors() }); return
    }

    // Layers / Basemaps / Config / Weather — stubs
    if (req.method === 'GET' && url.pathname === '/api/v1/layers') { json(res, 200, []); return }
    if (req.method === 'GET' && url.pathname === '/api/v1/map/basemaps') { json(res, 200, []); return }
    if (req.method === 'GET' && url.pathname === '/api/v1/runtime/config') { json(res, 200, {}); return }
    if (req.method === 'GET' && url.pathname === '/api/v1/weather/datasets') { json(res, 200, []); return }

    json(res, 404, { detail: 'Not found' })
  } catch (err) {
    if (err instanceof StoreNotFoundError) { json(res, 404, { detail: err.message }); return }
    console.error(err)
    json(res, 500, { detail: err instanceof Error ? err.message : String(err) })
  }
})

async function readBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

createWsHandler(server, store, toolRegistry, modelRegistry)

server.listen(env.PORT, env.HOST, () => {
  console.log(`server listening on ws://${env.HOST}:${env.PORT}`)
  console.log(`[tools] ${toolRegistry.list().length} tools from ${toolRegistry.listProviders().length} providers`)
})
