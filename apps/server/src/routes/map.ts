// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图 HTTP 路由
//
//   文件:       map.ts
//
//   日期:       2026年06月26日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { z } from 'zod'
import type { MapLayerManifest } from '../schemas/types.js'
import { mapFeaturePageSchema, mapLayerManifestSchema, mapSceneSchema, mapTileJsonSchema } from '../schemas/types.js'
import {
  AUTHENTICATED_TILE_CACHE_CONTROL,
  buildTileJson,
} from '../map/mapTileDescriptor.js'
import { MapTileGateway } from '../map/mapTileGateway.js'
import { TiandituBasemapGateway, type TiandituTileKind } from '../map/tiandituBasemapGateway.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import { StoreNotFoundError } from '../store/storeErrors.js'
import { MapStore } from '../store/postgres/mapStore.js'
import { HttpClientError } from './errors.js'

const idSchema = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/u)
const tileParamsSchema = z.object({
  mapLayerId: idSchema,
  z: z.coerce.number().int().min(0).max(24),
  x: z.coerce.number().int().nonnegative(),
  y: z.coerce.number().int().nonnegative(),
})
const featureQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
const basemapTileParamsSchema = z.object({
  kind: z.enum(['labels', 'vector']),
  z: z.coerce.number().int().min(0).max(18),
  x: z.coerce.number().int().nonnegative(),
  y: z.coerce.number().int().nonnegative(),
})

export function mapRoutes(deps: {
  mapStore: MapStore
  tileGateway: MapTileGateway
  tiandituBasemapGateway: TiandituBasemapGateway
  security: SecurityServices
}) {
  const { mapStore, tileGateway, tiandituBasemapGateway, security } = deps
  const app = new Hono()

  app.get('/api/v1/map/basemaps', c => c.json(tiandituBasemapGateway.catalog()))

  app.get('/api/v1/map/basemaps/tianditu-vector/tiles/:kind/:z/:x/:y', async c => {
    const params = basemapTileParamsSchema.parse(c.req.param())
    const tile = await tiandituBasemapGateway.fetchTile(
      params.kind as TiandituTileKind,
      params.z,
      params.x,
      params.y,
      c.req.raw.signal,
    )
    return tileResponse(tile, tile.cacheControl)
  })

  app.get('/api/v1/map/scenes/:threadId', async c => {
    const threadId = parseId(c.req.param('threadId'), 'threadId')
    await authorizeThread(mapStore, security, c, threadId, 'read')
    const scene = await mapStore.getOrCreateScene(threadId)
    return c.json({
      scene: mapSceneSchema.parse(scene),
      layers: (await mapStore.listSceneManifests(threadId)).map(layer => mapLayerManifestSchema.parse(layer)),
    })
  })

  app.get('/api/v1/map/layers/:mapLayerId/manifest', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    const manifest = await mapStore.getManifest(mapLayerId)
    return manifest ? c.json(mapLayerManifestSchema.parse(manifest)) : c.json({ detail: '地图图层不存在。' }, 404)
  })

  app.get('/api/v1/map/layers/:mapLayerId/tilejson', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    const manifest = await mapStore.getManifest(mapLayerId)
    if (!manifest) return c.json({ detail: '地图图层不存在。' }, 404)
    if (!isTileSource(manifest)) return c.json({ detail: '当前图层不是瓦片数据源。' }, 409)
    return c.json(mapTileJsonSchema.parse(buildTileJson(manifest, `/api/v1/map/layers/${mapLayerId}/tiles/{z}/{x}/{y}`)))
  })

  app.get('/api/v1/map/layers/:mapLayerId/tiles/:z/:x/:y', async c => {
    const params = tileParamsSchema.parse(c.req.param())
    await authorizeLayer(mapStore, security, c, params.mapLayerId, 'read')
    const spec = await mapStore.getTileExecutionSpec(params.mapLayerId)
    if (!spec) return c.json({ detail: '地图图层不存在。' }, 404)
    const tile = await tileGateway.fetchTile(spec, params.z, params.x, params.y, c.req.raw.signal)
    return tileResponse(tile, AUTHENTICATED_TILE_CACHE_CONTROL)
  })

  app.get('/api/v1/map/layers/:mapLayerId/features', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    const query = featureQuerySchema.parse(c.req.query())
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    return c.json(mapFeaturePageSchema.parse(await mapStore.listFeatures(mapLayerId, query.offset, query.limit)))
  })

  app.get('/api/v1/map/layers/:mapLayerId/download', async c => {
    const mapLayerId = parseId(c.req.param('mapLayerId'), 'mapLayerId')
    await authorizeLayer(mapStore, security, c, mapLayerId, 'read')
    const manifest = await mapStore.getManifest(mapLayerId)
    if (!manifest) return c.json({ detail: '地图图层不存在。' }, 404)
    if (manifest.source.kind !== 'vector_tiles' && manifest.source.kind !== 'geojson') {
      return c.json({ detail: '该图层应从关联结果文件下载。' }, 409)
    }
    const filename = `${manifest.title.replaceAll(/[\\/:*?"<>|]/g, '_')}.geojson`
    return c.json(await mapStore.exportFeatureCollection(mapLayerId), 200, {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Type': 'application/geo+json; charset=utf-8',
    })
  })

  return app
}

async function authorizeThread(
  mapStore: MapStore,
  security: SecurityServices,
  c: { get(key: string): unknown },
  threadId: string,
  action: 'read' | 'update',
): Promise<void> {
  const scope = await mapStore.getThreadScope(threadId)
  if (!scope) throw new StoreNotFoundError(`线程 '${threadId}' 不存在`)
  await security.authorization.assertResourceWorkspace(requireAuth(c), 'thread', action, scope)
}

async function authorizeLayer(
  mapStore: MapStore,
  security: SecurityServices,
  c: { get(key: string): unknown },
  mapLayerId: string,
  action: 'read',
): Promise<void> {
  const scope = await mapStore.getLayerScope(mapLayerId)
  if (!scope) throw new StoreNotFoundError(`地图图层 '${mapLayerId}' 不存在`)
  const auth = requireAuth(c)
  if (scope.system) {
    await security.authorization.enforce(auth, 'layer', action, {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: mapLayerId,
    })
    return
  }
  await security.authorization.assertResourceWorkspace(auth, 'layer', action, scope)
}

function isTileSource(manifest: MapLayerManifest): boolean {
  return ['vector_tiles', 'raster_tiles', 'raster_dem'].includes(manifest.source.kind)
}

function tileResponse(
  tile: { body: ArrayBuffer; contentType: string; cacheControl: string; etag: string | null },
  cacheControl: string,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': tile.contentType,
    'Cache-Control': cacheControl,
  }
  if (tile.etag) headers.ETag = tile.etag
  return new Response(tile.body, { headers })
}

function parseId(value: unknown, label: string): string {
  const parsed = idSchema.safeParse(value)
  if (!parsed.success) throw new HttpClientError(`${label} 无效`)
  return parsed.data
}
