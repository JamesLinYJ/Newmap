// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact HTTP 数据面
//
//   文件:       artifacts.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Database } from '../db/connection.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'

export function artifactRoutes(db: Database, runtimeRoot: string, security: SecurityServices) {
  const app = new Hono()

  app.get('/api/v1/results/:artifactId/metadata', async c => {
    const row = await getArtifact(db, c.req.param('artifactId'))
    if (!row) return c.json({ detail: '产物不存在' }, 404)
    await authorizeArtifact(security, c, row, 'read')
    return c.json({
      artifactId: String(row.artifact_id ?? ''),
      artifactType: String(row.artifact_type ?? ''),
      name: String(row.name ?? ''),
      uri: String(row.uri ?? ''),
      metadata: isRecord(row.metadata_json) ? row.metadata_json : {},
    })
  })

  const sendFile = async (c: { req: { param(name: string): string }; get(key: string): unknown }, download: boolean) => {
    const artifactId = c.req.param('artifactId')
    const row = await getArtifact(db, artifactId)
    if (!row) return new Response(JSON.stringify({ detail: '产物不存在' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    })
    await authorizeArtifact(security, c, row, 'read')
    const filePath = resolveRuntimePath(runtimeRoot, String(row.geojson_relative_path ?? ''))
    const bytes = await readFile(filePath)
    const headers: Record<string, string> = { 'Content-Type': contentTypeFor(String(row.artifact_type ?? '')) }
    if (download) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(String(row.name ?? artifactId))}"`
    return new Response(bytes, { headers })
  }

  app.get('/api/v1/results/:artifactId/geojson', c => sendFile(c, false))
  // 地图栅格和图表通过此地址内联读取；显式下载只走 artifacts/download。
  app.get('/api/v1/results/:artifactId/file', c => sendFile(c, false))
  app.get('/api/v1/artifacts/:artifactId/download', c => sendFile(c, true))
  return app
}

async function getArtifact(db: Database, artifactId: string): Promise<Record<string, unknown> | null> {
  const result = await db.execute(sql`
    SELECT artifact_id, run_id, workspace_id, created_by_user_id, visibility,
           name, artifact_type, uri, metadata_json, geojson_relative_path
    FROM platform_artifacts
    WHERE artifact_id = ${artifactId}
  `)
  return result.rows.length ? result.rows[0] as Record<string, unknown> : null
}

async function authorizeArtifact(
  security: SecurityServices,
  c: { get(key: string): unknown } | null,
  row: Record<string, unknown>,
  action: 'read',
): Promise<void> {
  const auth = c ? requireAuth(c) : null
  if (!auth) throw new Error('未登录。')
  await security.authorization.assertResourceWorkspace(auth, 'artifact', action, {
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
    createdByUserId: typeof row.created_by_user_id === 'string' ? row.created_by_user_id : null,
    visibility: typeof row.visibility === 'string' ? row.visibility : null,
    resourceId: String(row.artifact_id ?? ''),
  })
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const rootPath = path.resolve(runtimeRoot)
  const filePath = path.resolve(rootPath, relativePath)
  if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) throw new Error('产物路径非法')
  return filePath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentTypeFor(artifactType: string): string {
  if (artifactType === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (artifactType === 'geojson') return 'application/geo+json'
  if (artifactType === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (artifactType === 'npz') return 'application/octet-stream'
  if (artifactType === 'raster_png') return 'image/png'
  if (artifactType === 'audio_mp3') return 'audio/mpeg'
  return 'application/octet-stream'
}
