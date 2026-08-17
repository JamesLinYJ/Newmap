// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图 HTTP 错误语义测试
//
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import type { MapTileGateway } from '../map/mapTileGateway.js'
import type { TiandituBasemapGateway } from '../map/tiandituBasemapGateway.js'
import type { SecurityServices } from '../security/routes.js'
import type { MapStore } from '../store/postgres/mapStore.js'
import { routeErrorResponse } from './errors.js'
import { mapRoutes } from './map.js'

describe('map HTTP error boundary', () => {
  it('returns 400 for invalid path and pagination parameters', async () => {
    const app = testApp({
      getLayerScope: vi.fn(),
    })

    const invalidId = await app.request('/api/v1/map/layers/not%20valid/manifest')
    expect(invalidId.status).toBe(400)
    await expect(invalidId.json()).resolves.toEqual({ detail: 'mapLayerId 无效' })

    const invalidQuery = await app.request('/api/v1/map/layers/layer_1/features?offset=-1&limit=0')
    expect(invalidQuery.status).toBe(400)
    await expect(invalidQuery.json()).resolves.toEqual({ detail: '请求参数无效。' })
  })

  it('returns 404 when the authorized resource identity does not exist', async () => {
    const app = testApp({
      getLayerScope: vi.fn().mockResolvedValue(null),
      getThreadScope: vi.fn().mockResolvedValue(null),
    })

    const missingLayer = await app.request('/api/v1/map/layers/missing_layer/manifest')
    expect(missingLayer.status).toBe(404)
    await expect(missingLayer.json()).resolves.toEqual({ detail: "地图图层 'missing_layer' 不存在" })

    const missingThread = await app.request('/api/v1/map/scenes/missing_thread')
    expect(missingThread.status).toBe(404)
    await expect(missingThread.json()).resolves.toEqual({ detail: "线程 'missing_thread' 不存在" })
  })
})

function testApp(mapStore: Record<string, unknown>): Hono {
  const app = new Hono()
  app.route('/', mapRoutes({
    mapStore: mapStore as unknown as MapStore,
    tileGateway: {} as MapTileGateway,
    tiandituBasemapGateway: { catalog: () => [] } as unknown as TiandituBasemapGateway,
    security: {} as SecurityServices,
  }))
  app.onError((error, context) => {
    const response = routeErrorResponse(error)
    return context.json({ detail: response.detail }, response.status as never)
  })
  return app
}
