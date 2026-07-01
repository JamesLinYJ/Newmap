// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据 HTTP 数据面
//
//   文件:       meteorology.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 气象数据路由只索引当前 runtime 文件对象，不复制二进制数据。
// Agent 工具通过 datasetId / latest_upload 解析到同一条 fileRelativePath。

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Database } from '../db/connection.js'
import type {
  MeteorologicalDatasetRecord,
  MeteorologicalJobRecord,
} from '../schemas/types.js'
import { RuntimeFileStore, type FileLike } from '../store/fileStore.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { makeId, nowUtc } from '../utils/ids.js'

const METEOROLOGICAL_SUFFIXES = [
  '.nc',
  '.nc4',
  '.grib',
  '.grb',
  '.grb2',
  '.tif',
  '.tiff',
  '.h5',
  '.hdf5',
  '.bz2',
] as const

export async function ensureMeteorologicalTables(db: Database): Promise<void> {
  // 本地开发没有独立 migration runner；启动时显式创建 canonical 表。
  // 表名固定使用 meteorological，不提供旧命名兼容表或别名。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_meteorological_datasets (
      dataset_id text PRIMARY KEY,
      session_id text NOT NULL,
      thread_id text,
      filename text NOT NULL,
      original_filename text NOT NULL,
      file_id text,
      file_relative_path text NOT NULL,
      size_bytes integer NOT NULL DEFAULT 0,
      content_hash text,
      media_type text NOT NULL DEFAULT 'application/octet-stream',
      status text NOT NULL DEFAULT 'ready',
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_meteorological_datasets_session_updated
    ON platform_meteorological_datasets (session_id, updated_at)
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_meteorological_datasets_thread_updated
    ON platform_meteorological_datasets (thread_id, updated_at)
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_meteorological_jobs (
      job_id text PRIMARY KEY,
      dataset_id text NOT NULL,
      session_id text NOT NULL,
      thread_id text,
      kind text NOT NULL,
      status text NOT NULL,
      message text,
      payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_meteorological_jobs_dataset_updated
    ON platform_meteorological_jobs (dataset_id, updated_at)
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_meteorological_jobs_session_updated
    ON platform_meteorological_jobs (session_id, updated_at)
  `)
}

export function meteorologyRoutes(db: Database, runtimeRoot: string, store: PostgresPlatformStore) {
  const files = new RuntimeFileStore(runtimeRoot)
  const app = new Hono()

  app.get('/api/v1/meteorology/datasets', async c => {
    const sessionId = queryString(c.req.query('sessionId') ?? c.req.query('session_id'))
    const threadId = queryString(c.req.query('threadId') ?? c.req.query('thread_id'))
    const filename = queryString(c.req.query('filename'))
    const rows = await listDatasets(db, { sessionId, threadId, filename })
    return c.json(rows)
  })

  app.post('/api/v1/meteorology/datasets', async c => {
    try {
      const form = await c.req.formData()
      const sessionId = formString(form, 'sessionId') ?? formString(form, 'session_id')
      if (!sessionId) return c.json({ detail: 'sessionId 不能为空。' }, 400)
      store.getSession(sessionId)
      const threadId = formString(form, 'threadId') ?? formString(form, 'thread_id')
      const file = requireFile(form.get('file'))
      if (!isSupportedMeteorologicalFilename(file.name)) {
        return c.json({ detail: `不支持的气象数据格式：${file.name}` }, 415)
      }

      const sourceRelativePath = formString(form, 'sourceRelativePath') ?? formString(form, 'relativePath')
      const stored = await files.save(file, threadId, null, sourceRelativePath)
      if (threadId) await store.recordAttachment(threadId, stored)
      const now = nowUtc()
      const dataset: MeteorologicalDatasetRecord = {
        datasetId: makeId('meteorological_dataset'),
        sessionId,
        threadId,
        filename: stored.name,
        originalFilename: file.name,
        fileId: stored.id,
        fileRelativePath: stored.relativePath,
        sizeBytes: stored.sizeBytes,
        contentHash: stored.contentHash,
        mediaType: stored.mediaType,
        status: 'ready',
        metadata: {
          source: 'upload',
          inputKind: inputKind(stored.name),
          ...(stored.sourceRelativePath ? { sourceRelativePath: stored.sourceRelativePath } : {}),
        },
        createdAt: now,
        updatedAt: now,
      }
      await insertDataset(db, dataset)
      await store.updateSession(sessionId, { latestMeteorologicalDatasetId: dataset.datasetId })
      return c.json({ dataset, job: null })
    } catch (error) {
      return c.json({ detail: formatError(error, '气象数据上传失败') }, 400)
    }
  })

  app.get('/api/v1/meteorology/jobs/:jobId', async c => {
    const job = await getJob(db, c.req.param('jobId'))
    if (!job) return c.json({ detail: '气象处理任务不存在' }, 404)
    return c.json(job)
  })

  app.post('/api/v1/meteorology/datasets/:datasetId/report', async c => {
    const dataset = await getDataset(db, c.req.param('datasetId'))
    if (!dataset) return c.json({ detail: '气象数据集不存在' }, 404)
    const now = nowUtc()
    const payload = await safeJson(c.req.raw)
    const job: MeteorologicalJobRecord = {
      jobId: makeId('meteorological_job'),
      datasetId: dataset.datasetId,
      sessionId: dataset.sessionId,
      threadId: dataset.threadId,
      kind: 'report',
      status: 'queued',
      message: '气象报告任务已创建；报告正文必须由 meteorological_report 工具基于 interpretation_ref 生成。',
      payload,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    await insertJob(db, job)
    return c.json(job, 202)
  })

  return app
}

export async function resolveLatestMeteorologicalDataset(
  db: Database,
  params: { sessionId: string; threadId?: string | null; datasetId?: string | null; filename?: string | null },
): Promise<MeteorologicalDatasetRecord | null> {
  if (params.datasetId && params.datasetId !== 'latest_upload') {
    return getDataset(db, params.datasetId)
  }
  const matches = await listDatasets(db, {
    sessionId: params.sessionId,
    threadId: params.threadId ?? null,
    filename: params.filename ?? null,
    limit: 1,
  })
  return matches[0] ?? null
}

async function listDatasets(
  db: Database,
  filters: { sessionId?: string | null; threadId?: string | null; filename?: string | null; limit?: number },
): Promise<MeteorologicalDatasetRecord[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 500))
  if (filters.filename && filters.threadId && filters.sessionId) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE session_id = ${filters.sessionId}
        AND thread_id = ${filters.threadId}
        AND lower(filename) = lower(${filters.filename})
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  if (filters.filename && filters.threadId) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE thread_id = ${filters.threadId}
        AND lower(filename) = lower(${filters.filename})
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  if (filters.filename && filters.sessionId) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE session_id = ${filters.sessionId}
        AND lower(filename) = lower(${filters.filename})
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  if (filters.threadId && filters.sessionId) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE session_id = ${filters.sessionId}
        AND thread_id = ${filters.threadId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  if (filters.threadId) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE thread_id = ${filters.threadId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  if (filters.sessionId) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE session_id = ${filters.sessionId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  if (filters.filename) {
    const result = await db.execute(sql`
      SELECT *
      FROM platform_meteorological_datasets
      WHERE lower(filename) = lower(${filters.filename})
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
  }
  const result = await db.execute(sql`
    SELECT *
    FROM platform_meteorological_datasets
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `)
  return result.rows.map(row => mapDatasetRow(row as Record<string, unknown>))
}

async function getDataset(db: Database, datasetId: string): Promise<MeteorologicalDatasetRecord | null> {
  const result = await db.execute(sql`
    SELECT *
    FROM platform_meteorological_datasets
    WHERE dataset_id = ${datasetId}
    LIMIT 1
  `)
  return result.rows[0] ? mapDatasetRow(result.rows[0] as Record<string, unknown>) : null
}

async function getJob(db: Database, jobId: string): Promise<MeteorologicalJobRecord | null> {
  const result = await db.execute(sql`
    SELECT *
    FROM platform_meteorological_jobs
    WHERE job_id = ${jobId}
    LIMIT 1
  `)
  return result.rows[0] ? mapJobRow(result.rows[0] as Record<string, unknown>) : null
}

async function insertDataset(db: Database, dataset: MeteorologicalDatasetRecord): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_meteorological_datasets (
      dataset_id, session_id, thread_id, filename, original_filename, file_id,
      file_relative_path, size_bytes, content_hash, media_type, status,
      metadata_json, created_at, updated_at
    )
    VALUES (
      ${dataset.datasetId}, ${dataset.sessionId}, ${dataset.threadId}, ${dataset.filename},
      ${dataset.originalFilename}, ${dataset.fileId}, ${dataset.fileRelativePath},
      ${dataset.sizeBytes}, ${dataset.contentHash}, ${dataset.mediaType}, ${dataset.status},
      ${JSON.stringify(dataset.metadata)}::jsonb, ${new Date(dataset.createdAt)}, ${new Date(dataset.updatedAt)}
    )
  `)
}

async function insertJob(db: Database, job: MeteorologicalJobRecord): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_meteorological_jobs (
      job_id, dataset_id, session_id, thread_id, kind, status, message,
      payload_json, created_at, updated_at, completed_at
    )
    VALUES (
      ${job.jobId}, ${job.datasetId}, ${job.sessionId}, ${job.threadId}, ${job.kind},
      ${job.status}, ${job.message}, ${JSON.stringify(job.payload)}::jsonb,
      ${new Date(job.createdAt)}, ${new Date(job.updatedAt)},
      ${job.completedAt ? new Date(job.completedAt) : null}
    )
  `)
}

function mapDatasetRow(row: Record<string, unknown>): MeteorologicalDatasetRecord {
  return {
    datasetId: String(row.dataset_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
    filename: String(row.filename ?? ''),
    originalFilename: String(row.original_filename ?? row.filename ?? ''),
    fileId: typeof row.file_id === 'string' ? row.file_id : null,
    fileRelativePath: String(row.file_relative_path ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    contentHash: typeof row.content_hash === 'string' ? row.content_hash : null,
    mediaType: String(row.media_type ?? 'application/octet-stream'),
    status: String(row.status ?? 'ready'),
    metadata: isRecord(row.metadata_json) ? row.metadata_json : {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function mapJobRow(row: Record<string, unknown>): MeteorologicalJobRecord {
  return {
    jobId: String(row.job_id ?? ''),
    datasetId: String(row.dataset_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
    kind: String(row.kind ?? ''),
    status: String(row.status ?? ''),
    message: typeof row.message === 'string' ? row.message : null,
    payload: isRecord(row.payload_json) ? row.payload_json : {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : null,
  }
}

function isSupportedMeteorologicalFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return METEOROLOGICAL_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

function inputKind(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.bz2')) return 'radar'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'raster'
  return 'dataset'
}

function requireFile(value: unknown): FileLike {
  if (!isFileLike(value)) throw new Error('缺少上传文件。')
  return value
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key)
  return queryString(value)
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isFileLike(value: unknown): value is FileLike {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'arrayBuffer' in value
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value ?? ''))
  return Number.isNaN(parsed.getTime()) ? nowUtc() : parsed.toISOString()
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json()
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
