// Threads 路由 (v2)
import { Hono } from 'hono'
import type { PostgresPlatformStore, StoreNotFoundError } from '../store/platformStore.js'

export function threadRoutes(store: PostgresPlatformStore) {
  const isNotFound = (e: unknown) => (e as StoreNotFoundError).name === 'StoreNotFoundError'

  return new Hono()
    .post('/api/v2/threads', async (c) => {
      const { sessionId, title } = await c.req.json<{ sessionId?: string; title?: string | null }>()
      if (!sessionId?.trim()) return c.json({ detail: 'sessionId 不能为空。' }, 400)
      try {
        return c.json(await store.createThread(sessionId, title))
      } catch (e) { if (isNotFound(e)) return c.json({ detail: (e as Error).message }, 404); throw e }
    })
    .get('/api/v2/threads/:threadId', (c) => {
      try {
        const threadId = c.req.param('threadId')
        const runs = store.listRunsForThread(threadId)
        return c.json({ thread: store.getThread(threadId), runs, latestRun: runs[0] ?? null })
      } catch (e) { if (isNotFound(e)) return c.json({ detail: (e as Error).message }, 404); throw e }
    })
    .patch('/api/v2/threads/:threadId', async (c) => {
      const { title } = await c.req.json<{ title?: string }>()
      if (!title?.trim()) return c.json({ detail: '标题不能为空。' }, 400)
      try {
        return c.json(await store.updateThread(c.req.param('threadId'), { title }))
      } catch (e) { if (isNotFound(e)) return c.json({ detail: (e as Error).message }, 404); throw e }
    })
    .delete('/api/v2/threads/:threadId', async (c) => {
      try {
        const threadId = c.req.param('threadId')
        await store.deleteThread(threadId)
        return c.json({ deleted: true, threadId })
      } catch (e) { if (isNotFound(e)) return c.json({ detail: (e as Error).message }, 404); throw e }
    })
}
