import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Database } from '../db/connection.js'
import type { ArtifactRef, WeatherDatasetRecord, WeatherJobRecord } from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { makeId } from '../utils/ids.js'
import { getEnv } from '../framework/env.js'

export function weatherRoutes(db: Database, store: PostgresPlatformStore, runtimeRoot: string) {
  return new Hono()
    .get('/api/v1/weather/datasets', async (c) => {
      const sessionId = c.req.query('sessionId') ?? null
      const threadId = c.req.query('threadId') ?? null
      const result = await db.execute(sql`
        SELECT dataset_id, session_id, thread_id, filename, status,
               storage_relative_path, metadata_json, created_at, updated_at
        FROM platform_weather_datasets
        WHERE 1 = 1
        ${sessionId ? sql`AND session_id = ${sessionId}` : sql``}
        ${threadId ? sql`AND (thread_id = ${threadId} OR thread_id IS NULL)` : sql``}
        ORDER BY updated_at DESC
      `)
      return c.json(result.rows.map(row => mapDataset(row as Record<string, unknown>)))
    })
    .get('/api/v1/weather/jobs/:jobId', async (c) => {
      const result = await db.execute(sql`
        SELECT job_id, dataset_id, job_type, status, payload_json,
               result_json, error, created_at, updated_at
        FROM platform_weather_jobs
        WHERE job_id = ${c.req.param('jobId')}
      `)
      if (result.rows.length === 0) return c.json({ detail: '气象任务不存在' }, 404)
      return c.json(mapJob(result.rows[0] as Record<string, unknown>))
    })
    .post('/api/v1/weather/datasets', async (c) => {
      try {
        const form = await c.req.formData()
        const file = requireFile(form.get('file'))
        const sessionId = formString(form, 'sessionId')
        if (!sessionId) return c.json({ detail: 'sessionId 不能为空。' }, 400)
        store.getSession(sessionId)
        if (!isSupportedWeatherFilename(file.name)) {
          return c.json({ detail: `不支持的气象文件格式：${file.name}` }, 415)
        }

        const threadId = formString(form, 'threadId')
        const datasetId = makeId('weather')
        const cleanName = sanitizeFilename(file.name)
        const datasetDir = path.resolve(runtimeRoot, 'weather', datasetId)
        await mkdir(datasetDir, { recursive: true })
        const bytes = Buffer.from(await file.arrayBuffer())
        await writeFile(path.join(datasetDir, cleanName), bytes)
        const now = new Date()
        const metadata = {
          filename: cleanName,
          sizeBytes: bytes.byteLength,
          uploadedAt: now.toISOString(),
          source: 'ts-upload',
        }
        const storageRelativePath = path.posix.join('weather', datasetId, cleanName)
        await db.execute(sql`
          INSERT INTO platform_weather_datasets (
            dataset_id, session_id, thread_id, filename, status,
            storage_relative_path, metadata_json, created_at, updated_at
          )
          VALUES (
            ${datasetId}, ${sessionId}, ${threadId}, ${cleanName}, ${'uploaded'},
            ${storageRelativePath}, ${JSON.stringify(metadata)}::jsonb, ${now}, ${now}
          )
        `)
        await store.updateSession(sessionId, { latestWeatherDatasetId: datasetId })
        const dataset = mapDataset({
          dataset_id: datasetId,
          session_id: sessionId,
          thread_id: threadId,
          filename: cleanName,
          status: 'uploaded',
          storage_relative_path: storageRelativePath,
          metadata_json: metadata,
          created_at: now,
          updated_at: now,
        })
        return c.json({ dataset, job: null })
      } catch (error) {
        return c.json({ detail: formatError(error, '气象数据上传失败') }, 400)
      }
    })
    .post('/api/v1/weather/datasets/:id/report', async (c) => {
      try {
        const body = await c.req.json<{
          llmInterpretation?: string
          runId?: string | null
          resultName?: string | null
        }>()
        const dataset = await getDataset(db, c.req.param('id'))
        if (!dataset) return c.json({ detail: '气象数据集不存在' }, 404)
        const interpretation = body.llmInterpretation?.trim()
        if (!interpretation) return c.json({ detail: 'llmInterpretation 不能为空。' }, 400)

        const artifactId = makeId('artifact')
        const boundRun = body.runId?.trim() ? store.getRun(body.runId.trim()) : null
        const runId = boundRun?.id ?? 'weather_report'
        const artifactDir = path.resolve(runtimeRoot, 'artifacts', runId)
        await mkdir(artifactDir, { recursive: true })
        const filename = `${artifactId}.docx`
        const outputPath = path.join(artifactDir, filename)
        const report = await requestWeatherReport({
          datasetId: dataset.datasetId,
          llmInterpretation: interpretation,
          outputPath,
        })
        const relativePath = path.posix.join('artifacts', runId, filename)
        const artifact: ArtifactRef = {
          artifactId,
          runId,
          artifactType: 'docx',
          name: body.resultName?.trim() || `${dataset.filename} 解读报告`,
          uri: `/api/v1/artifacts/${artifactId}/download`,
          metadata: {
            datasetId: dataset.datasetId,
            storageRelativePath: dataset.storageRelativePath,
            relativePath,
            report,
          },
          isIntermediate: false,
        }
        await db.execute(sql`
          INSERT INTO platform_artifacts (
            artifact_id, run_id, artifact_type, name, uri, metadata_json, geojson_relative_path, created_at
          )
          VALUES (
            ${artifact.artifactId}, ${artifact.runId}, ${artifact.artifactType}, ${artifact.name},
            ${artifact.uri}, ${JSON.stringify(artifact.metadata)}::jsonb, ${relativePath}, ${new Date()}
          )
          ON CONFLICT (artifact_id) DO NOTHING
        `)
        if (boundRun) {
          store.updateRunState(runId, { artifacts: [...boundRun.state.artifacts, artifact] })
        }
        return c.json({ artifact, payload: report })
      } catch (error) {
        return c.json({ detail: formatError(error, '气象报告生成失败') }, 400)
      }
    })
}

function mapDataset(row: Record<string, unknown>): WeatherDatasetRecord {
  return {
    datasetId: String(row.dataset_id ?? ''),
    sessionId: String(row.session_id ?? ''),
    threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
    filename: String(row.filename ?? ''),
    status: String(row.status ?? 'uploaded'),
    storageRelativePath: String(row.storage_relative_path ?? ''),
    metadata: isRecord(row.metadata_json) ? row.metadata_json : {},
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
  }
}

function mapJob(row: Record<string, unknown>): WeatherJobRecord {
  return {
    jobId: String(row.job_id ?? ''),
    datasetId: String(row.dataset_id ?? ''),
    threadId: null,
    jobType: String(row.job_type ?? 'parse'),
    status: String(row.status ?? 'queued'),
    payload: isRecord(row.payload_json) ? row.payload_json : {},
    result: isRecord(row.result_json) ? row.result_json : {},
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
  }
}

function formatTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  return new Date(0).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function getDataset(db: Database, datasetId: string): Promise<WeatherDatasetRecord | null> {
  const result = await db.execute(sql`
    SELECT dataset_id, session_id, thread_id, filename, status,
           storage_relative_path, metadata_json, created_at, updated_at
    FROM platform_weather_datasets
    WHERE dataset_id = ${datasetId}
  `)
  if (result.rows.length === 0) return null
  return mapDataset(result.rows[0] as Record<string, unknown>)
}

async function requestWeatherReport(payload: {
  datasetId: string
  llmInterpretation: string
  outputPath: string
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${getEnv().WORKER_URL}/weather/datasets/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `sidecar HTTP ${response.status}`)
  }
  return response.json() as Promise<Record<string, unknown>>
}

interface FileLike {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
}

function requireFile(value: unknown): FileLike {
  if (!isFileLike(value)) throw new Error('缺少上传文件。')
  return value
}

function isFileLike(value: unknown): value is FileLike {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'arrayBuffer' in value
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_')
  return base || 'weather.bin'
}

function isSupportedWeatherFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return ['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5', '.bz2']
    .some(suffix => lower.endsWith(suffix))
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}
