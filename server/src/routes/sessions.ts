// Sessions 路由
import { Hono } from 'hono'
import type { PostgresPlatformStore, StoreNotFoundError } from '../store/platformStore.js'

export function sessionRoutes(store: PostgresPlatformStore) {
  return new Hono()
    .post('/api/v1/sessions', async (c) => {
      const session = await store.createSession()
      return c.json(session)
    })
    .get('/api/v1/sessions/default', async (c) => {
      const session = await store.getOrCreateDefaultSession()
      return c.json(session)
    })
    .get('/api/v1/sessions/:sessionId', (c) => {
      try {
        return c.json(store.getSession(c.req.param('sessionId')))
      } catch (e) {
        if ((e as StoreNotFoundError).name === 'StoreNotFoundError') return c.json({ detail: (e as Error).message }, 404)
        throw e
      }
    })
    .get('/api/v1/sessions/:sessionId/runs', (c) => {
      return c.json(store.listRunsForSession(c.req.param('sessionId')))
    })
    .get('/api/v1/sessions/:sessionId/threads', (c) => {
      return c.json(store.listThreadsForSession(c.req.param('sessionId')))
    })
}
