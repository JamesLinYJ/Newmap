// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据存储测试
//
//   文件:       platformStore.meteorology.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostgresPlatformStore } from './platformStore.js'

describe('PostgresPlatformStore meteorological datasets', () => {
  it('scopes dataset lists by threadId even when sessionId is not provided', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'alpha.nc', '2026-07-01T00:00:00.000Z'),
      datasetRow('dataset-b', 'session-a', 'thread-b', 'beta.nc', '2026-07-01T01:00:00.000Z'),
    ])
    const store = new PostgresPlatformStore(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-thread'))

    const rows = await store.listMeteorologicalDatasets({ threadId: 'thread-b' })

    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
    expect(fixture.queries[0]?.text).toContain('WHERE thread_id =')
  })

  it('applies filename filtering inside the thread scope without requiring sessionId', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'target.nc', '2026-07-01T00:00:00.000Z'),
      datasetRow('dataset-b', 'session-a', 'thread-b', 'target.nc', '2026-07-01T01:00:00.000Z'),
      datasetRow('dataset-c', 'session-a', 'thread-b', 'other.nc', '2026-07-01T02:00:00.000Z'),
    ])
    const store = new PostgresPlatformStore(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-filename'))

    const rows = await store.listMeteorologicalDatasets({ threadId: 'thread-b', filename: 'target.nc' })

    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
    expect(fixture.queries[0]?.text).toContain('thread_id =')
    expect(fixture.queries[0]?.text).toContain('lower(filename)')
  })
})

interface CapturedQuery {
  text: string
  values: unknown[]
}

type DatasetRow = Record<string, unknown>

function createMeteorologicalDb(rows: DatasetRow[]): { db: Database; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = []
  const db = {
    execute: async (query: unknown) => {
      const captured = captureQuery(query)
      queries.push(captured)
      return { rows: filterRows(rows, captured) }
    },
  } as unknown as Database
  return { db, queries }
}

// 这里不模拟数据库能力，只解释本模块生成的 SQL 参数顺序；
// 测试目标是确认作用域谓词进入查询，而不是做端到端 SQL 引擎替身。
function filterRows(rows: DatasetRow[], query: CapturedQuery): DatasetRow[] {
  let valueIndex = 0
  const sessionId = query.text.includes('session_id =') ? String(query.values[valueIndex++]) : null
  const threadId = query.text.includes('thread_id =') ? String(query.values[valueIndex++]) : null
  const filename = query.text.includes('lower(filename)') ? String(query.values[valueIndex++]).toLowerCase() : null
  const limit = Number(query.values.at(-1) ?? rows.length)

  return rows
    .filter(row => !sessionId || row.session_id === sessionId)
    .filter(row => !threadId || row.thread_id === threadId)
    .filter(row => !filename || String(row.filename).toLowerCase() === filename)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, Number.isFinite(limit) ? limit : rows.length)
}

function captureQuery(query: unknown): CapturedQuery {
  const chunks = Array.isArray((query as { queryChunks?: unknown }).queryChunks)
    ? (query as { queryChunks: unknown[] }).queryChunks
    : []
  const text: string[] = []
  const values: unknown[] = []
  for (const chunk of chunks) {
    if (isStringChunk(chunk)) {
      text.push(chunk.value.join(''))
    } else {
      text.push('?')
      values.push(chunk)
    }
  }
  return { text: text.join(''), values }
}

function isStringChunk(value: unknown): value is { value: string[] } {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { value?: unknown }).value)
}

function datasetRow(
  datasetId: string,
  sessionId: string,
  threadId: string,
  filename: string,
  updatedAt: string,
): DatasetRow {
  return {
    dataset_id: datasetId,
    session_id: sessionId,
    thread_id: threadId,
    filename,
    original_filename: filename,
    file_id: `${datasetId}-file`,
    file_relative_path: `uploads/${filename}`,
    size_bytes: 1,
    content_hash: null,
    media_type: 'application/netcdf',
    status: 'ready',
    metadata_json: {},
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}
