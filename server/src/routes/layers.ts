// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层 HTTP 数据面
//
//   文件:       layers.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import type { PostGisRepository } from '../gis/postgis.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { Env } from '../framework/env.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { GeoJsonFeatureCollection } from '../gis/geojson.js'
import { parseGeoJsonEntity, toFeatureCollection } from '../gis/geojson.js'

interface ImportOptions {
  sourceType: string
  defaultCategory: string
  requireSession: boolean
  layerKey?: string | null
  defaultName?: string | null
  defaultDescription?: string | null
  defaultTags?: string[]
  sessionId?: string | null
  threadId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
  visibility?: 'private' | 'workspace' | 'public'
}

export function layerRoutes(postgis: PostGisRepository, store: PostgresPlatformStore, security: SecurityServices, env?: Env) {
  return new Hono()
    .post('/api/v1/layers/register', async (c) => {
      const tooLarge = checkContentLength(c.req.header('content-length'), env?.MAX_GEOJSON_UPLOAD_BYTES ?? env?.MAX_FILE_UPLOAD_BYTES)
      if (tooLarge) return c.json({ detail: tooLarge }, 413)
      const auth = requireAuth(c)
      const result = await importLayerFromForm(c.req.raw, postgis, env, {
        sourceType: 'upload',
        defaultCategory: 'upload',
        requireSession: true,
      }, async sessionId => {
        const session = store.getSession(sessionId)
        await security.authorization.assertResourceWorkspace(auth, 'session', 'update', {
          workspaceId: session.workspaceId,
          createdByUserId: session.createdByUserId,
          visibility: session.visibility,
          resourceId: session.id,
        })
        await security.authorization.enforce(auth, 'layer', 'create', { workspaceId: session.workspaceId ?? auth.defaultWorkspaceId })
        return { workspaceId: session.workspaceId ?? auth.defaultWorkspaceId, createdByUserId: auth.userId }
      })
      if ('error' in result) return c.json({ detail: result.error }, { status: result.status as never })
      if (result.layer.sessionId) await store.updateSession(result.layer.sessionId, { latestUploadedLayerKey: result.layer.layerKey })
      return c.json(result.layer)
    })
    .post('/api/v1/layers/import', async (c) => {
      const tooLarge = checkContentLength(c.req.header('content-length'), env?.MAX_GEOJSON_UPLOAD_BYTES ?? env?.MAX_FILE_UPLOAD_BYTES)
      if (tooLarge) return c.json({ detail: tooLarge }, 413)
      const auth = requireAuth(c)
      await security.authorization.enforce(auth, 'layer', 'create', { workspaceId: auth.defaultWorkspaceId })
      const result = await importLayerFromForm(c.req.raw, postgis, env, {
        sourceType: 'managed',
        defaultCategory: 'managed',
        requireSession: false,
        workspaceId: auth.defaultWorkspaceId,
        createdByUserId: auth.userId,
      })
      if ('error' in result) return c.json({ detail: result.error }, { status: result.status as never })
      return c.json(result.layer)
    })
    .post('/api/v1/layers/:layerKey/replace', async (c) => {
      const tooLarge = checkContentLength(c.req.header('content-length'), env?.MAX_GEOJSON_UPLOAD_BYTES ?? env?.MAX_FILE_UPLOAD_BYTES)
      if (tooLarge) return c.json({ detail: tooLarge }, 413)
      const existing = await postgis.getLayer(c.req.param('layerKey'))
      if (!existing) return c.json({ detail: '图层不存在' }, { status: 404 })
      if (existing.readonly) return c.json({ detail: '系统图层为只读，不能替换。' }, { status: 403 })
      const auth = requireAuth(c)
      await security.authorization.assertResourceWorkspace(auth, 'layer', 'update', {
        workspaceId: existing.workspaceId,
        createdByUserId: existing.createdByUserId,
        visibility: existing.visibility,
        resourceId: existing.layerKey,
      })
      const result = await importLayerFromForm(c.req.raw, postgis, env, {
        layerKey: existing.layerKey,
        sourceType: existing.sourceType,
        defaultCategory: existing.category,
        defaultName: existing.name,
        defaultDescription: existing.description,
        defaultTags: existing.tags,
        sessionId: existing.sessionId,
        threadId: existing.threadId,
        workspaceId: existing.workspaceId,
        createdByUserId: auth.userId,
        visibility: normalizeVisibility(existing.visibility),
        requireSession: false,
      })
      if ('error' in result) return c.json({ detail: result.error }, { status: result.status as never })
      return c.json(result.layer)
    })
}

async function importLayerFromForm(
  request: Request,
  postgis: PostGisRepository,
  env: Env | undefined,
  opts: ImportOptions,
  resolveOwner?: (sessionId: string) => Promise<{ workspaceId: string; createdByUserId: string } | null>,
) {
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!isFileLike(file)) return { error: '缺少上传文件。', status: 400 }
    if (!isSupportedGeoJsonFilename(file.name)) {
      return { error: `当前导入器只支持 GeoJSON/JSON 文件：${file.name}`, status: 415 }
    }
    const sessionId = formString(form, 'sessionId') ?? formString(form, 'session_id') ?? opts.sessionId ?? null
    if (opts.requireSession && !sessionId) return { error: 'sessionId 不能为空。', status: 400 }
    const owner = sessionId && resolveOwner ? await resolveOwner(sessionId) : null
    const threadId = formString(form, 'threadId') ?? formString(form, 'thread_id') ?? opts.threadId ?? null
    const collection = parseGeoJsonPayload(JSON.parse(await file.text()), env)
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
      workspaceId: owner?.workspaceId ?? opts.workspaceId ?? null,
      createdByUserId: owner?.createdByUserId ?? opts.createdByUserId ?? null,
      visibility: opts.visibility ?? 'workspace',
    })
    return { layer }
  } catch (error) {
    return { error: formatError(error, 'GeoJSON 导入失败'), status: 400 }
  }
}

function parseGeoJsonPayload(value: unknown, env?: Env): GeoJsonFeatureCollection {
  const collection = toFeatureCollection(parseGeoJsonEntity(value, 'GeoJSON'))
  const features = collection.features
  if (env?.MAX_GEOJSON_FEATURES && features.length > env.MAX_GEOJSON_FEATURES) {
    throw new Error(`GeoJSON feature 数量超过限制：${features.length}/${env.MAX_GEOJSON_FEATURES}`)
  }
  const coordinateCount = features.reduce((sum, feature) => sum + countCoordinates(feature.geometry), 0)
  if (env?.MAX_GEOJSON_COORDINATES && coordinateCount > env.MAX_GEOJSON_COORDINATES) {
    throw new Error(`GeoJSON 坐标数量超过限制：${coordinateCount}/${env.MAX_GEOJSON_COORDINATES}`)
  }
  return collection
}

function checkContentLength(value: string | undefined, limit?: number): string | null {
  if (!limit || !value) return null
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > limit) return `上传文件过大，限制为 ${Math.round(limit / 1024 / 1024)}MB。`
  return null
}

function countCoordinates(geometry: unknown): number {
  if (!isRecord(geometry)) return 0
  if (geometry.type === 'GeometryCollection') {
    return Array.isArray(geometry.geometries) ? geometry.geometries.reduce((sum, child) => sum + countCoordinates(child), 0) : 0
  }
  return countPositionArray(geometry.coordinates)
}

function countPositionArray(value: unknown): number {
  if (!Array.isArray(value)) return 0
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return 1
  return value.reduce((sum, child) => sum + countPositionArray(child), 0)
}

function isSupportedGeoJsonFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.geojson') || lower.endsWith('.json')
}

function normalizeVisibility(value: unknown): 'private' | 'workspace' | 'public' {
  return value === 'private' || value === 'public' ? value : 'workspace'
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseTags(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '') || name
}

function isFileLike(value: unknown): value is { name: string; text(): Promise<string> } {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'text' in value
    && typeof (value as { text?: unknown }).text === 'function'
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
