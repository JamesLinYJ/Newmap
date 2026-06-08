import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Database } from '../db/connection.js'

export function artifactRoutes(db: Database, runtimeRoot: string) {
  return new Hono()
    .get('/api/v1/artifacts/:artifactId/download', async (c) => {
      const artifactId = c.req.param('artifactId')
      const result = await db.execute(sql`
        SELECT name, artifact_type, metadata_json, geojson_relative_path
        FROM platform_artifacts
        WHERE artifact_id = ${artifactId}
      `)
      if (result.rows.length === 0) return c.json({ detail: '产物不存在' }, 404)
      const row = result.rows[0] as Record<string, unknown>
      const relativePath = String(row.geojson_relative_path ?? '')
      const filePath = path.resolve(runtimeRoot, relativePath)
      const rootPath = path.resolve(runtimeRoot)
      if (!filePath.startsWith(rootPath + path.sep)) return c.json({ detail: '产物路径非法' }, 400)
      const bytes = await readFile(filePath)
      return new Response(bytes, {
        headers: {
          'Content-Type': contentTypeFor(String(row.artifact_type ?? '')),
          'Content-Disposition': `attachment; filename="${encodeURIComponent(String(row.name ?? artifactId))}"`,
        },
      })
    })
}

function contentTypeFor(artifactType: string): string {
  if (artifactType === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (artifactType === 'geojson') return 'application/geo+json'
  return 'application/octet-stream'
}
