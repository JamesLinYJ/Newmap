// Weather 路由 → Python sidecar 代理
import { Hono } from 'hono'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8012'

export const weatherRoutes = new Hono()
  .post('/api/v1/weather/datasets', async (c) => {
    const body = await c.req.parseBody()
    const res = await fetch(`${WORKER_URL}/weather/datasets/upload`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
    return c.json(await res.json())
  })
  .get('/api/v1/weather/datasets', async (c) => {
    const res = await fetch(`${WORKER_URL}/weather/datasets`)
    return c.json(await res.json())
  })
  .post('/api/v1/weather/datasets/:id/report', async (c) => {
    const res = await fetch(`${WORKER_URL}/weather/datasets/${c.req.param('id')}/report`, { method: 'POST' })
    return c.json(await res.json())
  })
