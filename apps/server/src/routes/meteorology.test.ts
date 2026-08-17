// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据路由测试
//
//   文件:       meteorology.test.ts
//
//   日期:       2026年07月01日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import os from 'node:os'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { ensureMeteorologicalTables, meteorologyRoutes } from './meteorology.js'
import { verifySchema } from '../security/database.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'

describe('meteorology routes', () => {
  it('passes threadId and filename query parameters into dataset filtering', async () => {
    const calls: unknown[] = []
    const store = {
      meteorology: {
        listMeteorologicalDatasets: async (filters: unknown) => {
          calls.push(filters)
          return [{ datasetId: 'dataset-b' }]
        },
      },
    } as unknown as PlatformPersistenceFacade
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', TEST_AUTH)
      await next()
    })
    app.route('/', meteorologyRoutes(os.tmpdir(), emptyFileLifecycle(), store, testSecurity(), {
      MAX_METEOROLOGY_UPLOAD_BYTES: 500 * 1024 * 1024,
    }))

    const response = await app.request('/api/v1/meteorology/datasets?threadId=thread-b&filename=target.nc')
    const rows = await response.json() as Array<{ datasetId: string }>

    expect(response.status).toBe(200)
    expect(calls).toEqual([{
      workspaceId: 'workspace-test',
      sessionId: null,
      threadId: 'thread-b',
      filename: 'target.nc',
    }])
    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
  })

  it('compensates a published file when the dataset/session transaction fails', async () => {
    const deleted: string[] = []
    const store = {
      getSession: () => ({
        id: 'session-test',
        workspaceId: 'workspace-test',
        createdByUserId: 'user-test',
        visibility: 'workspace',
      }),
      getThread: () => ({
        id: 'thread-test',
        sessionId: 'session-test',
        workspaceId: 'workspace-test',
        createdByUserId: 'user-test',
        visibility: 'workspace',
      }),
      createMeteorologicalDataset: async () => { throw new Error('dataset/session transaction failed') },
    } as unknown as PlatformPersistenceFacade
    const files: FileLifecyclePort = {
      upload: async () => ({
        id: 'file-uploaded',
        name: 'weather.nc',
        sourceRelativePath: null,
        size: '7 B',
        sizeBytes: 7,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        threadId: 'thread-test',
        relativePath: 'files/thread-test/file-uploaded/weather.nc',
        contentHash: 'a'.repeat(64),
        mediaType: 'application/x-netcdf',
      }),
      list: async () => [],
      delete: async fileId => { deleted.push(fileId); return true },
      cloneThreadFiles: async () => [],
      purgeThreadFiles: async () => undefined,
    }
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', TEST_AUTH)
      await next()
    })
    app.route('/', meteorologyRoutes(os.tmpdir(), files, store, testSecurity(), {
      MAX_METEOROLOGY_UPLOAD_BYTES: 500 * 1024 * 1024,
    }))

    const form = new FormData()
    form.set('sessionId', 'session-test')
    form.set('threadId', 'thread-test')
    form.append('file', new Blob(['netcdf'], { type: 'application/x-netcdf' }), 'weather.nc')
    const response = await app.request('/api/v1/meteorology/datasets', { method: 'POST', body: form })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ detail: '气象数据上传失败。' })
    expect(deleted).toEqual(['file-uploaded'])
  })

  it('rejects malformed report JSON instead of creating an empty-payload job', async () => {
    const createdJobs: unknown[] = []
    const store = {
      meteorology: {
        getMeteorologicalDataset: async () => ({
          datasetId: 'dataset-test',
          workspaceId: 'workspace-test',
          createdByUserId: 'user-test',
          visibility: 'workspace',
          sessionId: 'session-test',
          threadId: 'thread-test',
        }),
        createMeteorologicalJob: async (job: unknown) => { createdJobs.push(job) },
      },
    } as unknown as PlatformPersistenceFacade
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', TEST_AUTH)
      await next()
    })
    app.route('/', meteorologyRoutes(os.tmpdir(), emptyFileLifecycle(), store, testSecurity(), {
      MAX_METEOROLOGY_UPLOAD_BYTES: 500 * 1024 * 1024,
    }))

    const response = await app.request('/api/v1/meteorology/datasets/dataset-test/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ detail: '请求体必须是有效的 JSON 对象。' })
    expect(createdJobs).toEqual([])
  })
})

function emptyFileLifecycle(): FileLifecyclePort {
  return {
    upload: async () => { throw new Error('测试不应上传文件。') },
    list: async () => [],
    delete: async () => false,
    cloneThreadFiles: async () => [],
    purgeThreadFiles: async () => undefined,
  }
}

const TEST_AUTH: AuthContext = {
  userId: 'user-test',
  subject: 'auth-user-test',
  email: 'tester@geo-agent-platform.local',
  displayName: '测试用户',
  authSessionId: 'session-test',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: 'csrf-test',
  defaultWorkspaceId: 'workspace-test',
  roles: [{ workspaceId: 'workspace-test', role: 'analyst' }],
}

function testSecurity(): SecurityServices {
  return {
    auth: {
      requireCsrf: () => {},
      isTrustedOrigin: () => true,
      authenticateRequest: async () => TEST_AUTH,
      isAuthContextActive: async () => true,
    },
    authorization: {
      enforce: async () => {},
      assertResourceWorkspace: async () => {},
      can: async () => true,
      audit: async () => {},
      reload: async () => {},
    },
    db: { execute: async () => ({ rows: [] }) } as unknown as Database,
  } as unknown as SecurityServices
}

function noOpDb(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}

// ---------------------------------------------------------------------------
// Schema verification tests for ensureMeteorologicalTables
// ---------------------------------------------------------------------------

interface FakeDbConfig {
  tables: Record<string, string[]>
}

function meteoFakeDb(config: FakeDbConfig): Database {
  return {
    execute: async (query: unknown) => {
      const text = sqlText(query)
      if (text.includes('information_schema.tables')) {
        // The ANY($1::text[]) param is the required table list; return all configured
        return { rows: Object.keys(config.tables).map(t => ({ table_name: t })) }
      }
      if (text.includes('information_schema.columns')) {
        // Single param: the table name
        const tableName = String(paramValues(query)[0] ?? '')
        const columns = config.tables[tableName] ?? []
        return { rows: columns.map(c => ({ column_name: c })) }
      }
      return { rows: [] }
    },
  } as unknown as Database
}

function sqlText(query: unknown): string {
  const parts: string[] = []
  for (const chunk of chunksOf(query)) {
    if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) {
      const arr = (chunk as { value: unknown[] }).value
      if (arr.every(item => typeof item === 'string')) parts.push(arr.join(''))
    }
  }
  return parts.join('')
}

function paramValues(query: unknown): unknown[] {
  const values: unknown[] = []
  for (const chunk of chunksOf(query)) {
    // Drizzle queryChunks: string parts are wrapped {value: string[]};
    // param values are raw scalars — skip objects.
    if (typeof chunk === 'object' && chunk !== null) continue
    values.push(chunk)
  }
  return values
}

function chunksOf(value: unknown): unknown[] {
  const qc = (value as { queryChunks?: unknown[] })?.queryChunks
  return Array.isArray(qc) ? qc : []
}

describe('ensureMeteorologicalTables', () => {
  it('passes when all meteorological tables and columns exist', async () => {
    const db = meteoFakeDb({
      tables: {
        platform_meteorological_datasets: [
          'dataset_id', 'workspace_id', 'created_by_user_id', 'visibility',
          'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
          'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
          'metadata_json', 'created_at', 'updated_at',
        ],
        platform_meteorological_jobs: [
          'job_id', 'dataset_id', 'workspace_id', 'created_by_user_id',
          'session_id', 'thread_id', 'kind', 'status', 'message',
          'payload_json', 'created_at', 'updated_at', 'completed_at',
        ],
      },
    })
    await expect(ensureMeteorologicalTables(db)).resolves.toBeUndefined()
  })

  it('throws when a meteorological table is missing', async () => {
    const db = meteoFakeDb({
      tables: {
        platform_meteorological_datasets: [
          'dataset_id', 'workspace_id', 'created_by_user_id', 'visibility',
          'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
          'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
          'metadata_json', 'created_at', 'updated_at',
        ],
        // missing platform_meteorological_jobs
      },
    })
    await expect(ensureMeteorologicalTables(db)).rejects.toThrow(/缺少表/)
  })

  it('throws when a meteorological column is missing', async () => {
    const db = meteoFakeDb({
      tables: {
        platform_meteorological_datasets: [
          'dataset_id', 'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
          'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
          'metadata_json', 'created_at', 'updated_at',
          // missing workspace_id, created_by_user_id, visibility
        ],
        platform_meteorological_jobs: [
          'job_id', 'dataset_id', 'workspace_id', 'created_by_user_id',
          'session_id', 'thread_id', 'kind', 'status', 'message',
          'payload_json', 'created_at', 'updated_at', 'completed_at',
        ],
      },
    })
    await expect(ensureMeteorologicalTables(db)).rejects.toThrow(/缺少列/)
  })
})
