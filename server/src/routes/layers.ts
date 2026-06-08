import { Hono } from 'hono'
import type { PostGisRepository } from '../gis/postgis.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'

export function layerRoutes(postgis: PostGisRepository, store: PostgresPlatformStore) {
  return new Hono()
    .get('/api/v1/layers', async (c) => {
      const sessionId = c.req.query('sessionId') ?? null
      try {
        return c.json(await postgis.listLayers(sessionId))
      } catch (error) {
        return c.json({ detail: formatError(error, '图层目录读取失败') }, 500)
      }
    })
    .get('/api/v1/layers/:layerKey', async (c) => {
      try {
        const layer = await postgis.getLayer(c.req.param('layerKey'))
        if (!layer) return c.json({ detail: '图层不存在' }, 404)
        return c.json(layer)
      } catch (error) {
        return c.json({ detail: formatError(error, '图层读取失败') }, 500)
      }
    })
    .post('/api/v1/layers', async (c) => {
      try {
        const body = await c.req.json<Record<string, unknown>>()
        const collection = parseGeoJsonPayload(body.geojson ?? body.collection ?? body)
        return c.json(await postgis.importGeoJsonLayer({
          name: stringField(body.name) ?? '自定义图层',
          description: stringField(body.description) ?? '',
          sourceType: stringField(body.sourceType) ?? 'upload',
          category: stringField(body.category) ?? 'upload',
          status: stringField(body.status) ?? 'active',
          tags: stringArrayField(body.tags),
          sessionId: stringField(body.sessionId),
          threadId: stringField(body.threadId),
          sourceFilename: stringField(body.sourceFilename),
          collection,
        }))
      } catch (error) {
        return c.json({ detail: formatError(error, '图层创建失败') }, 400)
      }
    })
    .patch('/api/v1/layers/:layerKey', async (c) => {
      try {
        const body = await c.req.json<Record<string, unknown>>()
        return c.json(await postgis.updateLayerMetadata(c.req.param('layerKey'), {
          name: stringField(body.name) ?? undefined,
          description: stringField(body.description) ?? undefined,
          category: stringField(body.category) ?? undefined,
          status: stringField(body.status) ?? undefined,
          tags: Array.isArray(body.tags) ? stringArrayField(body.tags) : undefined,
          analysisCapabilities: Array.isArray(body.analysisCapabilities) ? stringArrayField(body.analysisCapabilities) : undefined,
          sourceConfigSummary: body.sourceConfigSummary === null ? null : stringField(body.sourceConfigSummary) ?? undefined,
        }))
      } catch (error) {
        return c.json({ detail: formatError(error, '图层元数据更新失败') }, 400)
      }
    })
    .delete('/api/v1/layers/:layerKey', async (c) => {
      try {
        const deleted = await postgis.deleteLayer(c.req.param('layerKey'))
        if (!deleted) return c.json({ detail: '图层不存在' }, 404)
        return c.json({ deleted: true, layerKey: c.req.param('layerKey') })
      } catch (error) {
        return c.json({ detail: formatError(error, '图层删除失败') }, 400)
      }
    })
    .post('/api/v1/layers/register', async (c) => {
      const result = await importLayerFromForm(c.req.raw, postgis, {
        sourceType: 'upload',
        defaultCategory: 'upload',
        requireSession: true,
      })
      if ('error' in result) return c.json({ detail: result.error }, result.status)
      if (result.layer.sessionId) {
        await store.updateSession(result.layer.sessionId, { latestUploadedLayerKey: result.layer.layerKey })
      }
      return c.json(result.layer)
    })
    .post('/api/v1/layers/import', async (c) => {
      const result = await importLayerFromForm(c.req.raw, postgis, {
        sourceType: 'managed',
        defaultCategory: 'managed',
        requireSession: false,
      })
      if ('error' in result) return c.json({ detail: result.error }, result.status)
      return c.json(result.layer)
    })
    .post('/api/v1/layers/:layerKey/replace', async (c) => {
      const existing = await postgis.getLayer(c.req.param('layerKey'))
      if (!existing) return c.json({ detail: '图层不存在' }, 404)
      const result = await importLayerFromForm(c.req.raw, postgis, {
        layerKey: existing.layerKey,
        sourceType: existing.sourceType,
        defaultCategory: existing.category,
        defaultName: existing.name,
        defaultDescription: existing.description,
        defaultTags: existing.tags,
        sessionId: existing.sessionId,
        threadId: existing.threadId,
        requireSession: false,
      })
      if ('error' in result) return c.json({ detail: result.error }, result.status)
      return c.json(result.layer)
    })
}

function formatError(error: unknown, prefix: string) {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}

async function importLayerFromForm(
  request: Request,
  postgis: PostGisRepository,
  opts: {
    layerKey?: string | null
    sourceType: string
    defaultCategory: string
    defaultName?: string | null
    defaultDescription?: string | null
    defaultTags?: string[]
    sessionId?: string | null
    threadId?: string | null
    requireSession: boolean
  },
): Promise<{ layer: Awaited<ReturnType<PostGisRepository['importGeoJsonLayer']>> } | { error: string; status: 400 | 415 }> {
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!isFileLike(file)) return { error: '缺少上传文件。', status: 400 }
    if (!isSupportedGeoJsonFilename(file.name)) {
      return { error: `当前 TS 导入器只支持 GeoJSON/JSON 文件：${file.name}`, status: 415 }
    }
    const sessionId = formString(form, 'sessionId') ?? formString(form, 'session_id') ?? opts.sessionId ?? null
    if (opts.requireSession && !sessionId) return { error: 'sessionId 不能为空。', status: 400 }
    const threadId = formString(form, 'threadId') ?? formString(form, 'thread_id') ?? opts.threadId ?? null
    const collection = parseGeoJsonPayload(JSON.parse(await file.text()))
    const layer = await postgis.importGeoJsonLayer({
      layerKey: opts.layerKey,
      name: formString(form, 'name') ?? opts.defaultName ?? stripExtension(file.name),
      description: formString(form, 'description') ?? opts.defaultDescription ?? '',
      sourceType: opts.sourceType,
      category: formString(form, 'category') ?? opts.defaultCategory,
      status: formString(form, 'status') ?? 'active',
      tags: parseTags(form.get('tags')) ?? opts.defaultTags ?? [],
      sessionId,
      threadId,
      sourceFilename: file.name,
      collection,
    })
    return { layer }
  } catch (error) {
    return { error: formatError(error, 'GeoJSON 导入失败'), status: 400 }
  }
}

function parseGeoJsonPayload(value: unknown): FeatureCollection<Geometry, GeoJsonProperties> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('GeoJSON 必须是 FeatureCollection、Feature 或 Geometry')
  }
  if (isGeoJsonFeatureCollection(value)) {
    return value
  }
  if (isGeoJsonFeature(value)) {
    return { type: 'FeatureCollection', features: [value] }
  }
  if (isGeoJsonGeometry(value)) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: value }],
    }
  }
  throw new Error(`不支持的 GeoJSON 类型：${value.type}`)
}

function isGeoJsonFeatureCollection(value: unknown): value is FeatureCollection<Geometry, GeoJsonProperties> {
  return isRecord(value)
    && value.type === 'FeatureCollection'
    && Array.isArray(value.features)
    && value.features.every(isGeoJsonFeature)
}

function isGeoJsonFeature(value: unknown): value is Feature<Geometry, GeoJsonProperties> {
  return isRecord(value)
    && value.type === 'Feature'
    && isGeoJsonGeometry(value.geometry)
    && (value.properties === null || value.properties === undefined || isRecord(value.properties))
}

function isGeoJsonGeometry(value: unknown): value is Geometry {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'GeometryCollection') {
    return Array.isArray(value.geometries) && value.geometries.every(isGeoJsonGeometry)
  }
  return ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(value.type)
    && Array.isArray(value.coordinates)
}

function isSupportedGeoJsonFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.geojson') || lower.endsWith('.json')
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringArrayField(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
  return []
}

function parseTags(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '') || name
}

interface FileLike {
  name: string
  text(): Promise<string>
}

function isFileLike(value: unknown): value is FileLike {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'text' in value
    && typeof (value as { text?: unknown }).text === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
