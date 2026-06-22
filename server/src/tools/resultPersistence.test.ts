// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具结果持久化契约测试
//
//   文件:       resultPersistence.test.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { persistToolExecutionResult } from './resultPersistence.js'

describe('tool result persistence', () => {
  it('persists inline GeoJSON identically for direct and agent tool paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-'))
    let store: PostgresPlatformStore | undefined
    try {
      store = new PostgresPlatformStore(noOpDb(), path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '结果测试')
      const run = await store.createRun(session.id, '执行工具', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'route_planner', {}, {
        message: '路线完成',
        payload: { route: line() },
        warnings: [],
        resultId: 'result_route',
        source: 'test',
        valueRefs: [{ refId: 'ref_route', kind: 'route', label: '路线', value: line() }],
      })

      const latest = store.getRun(run.id)
      expect(latest.state.artifacts).toHaveLength(1)
      expect(latest.state.toolValueRefs[0].refId).toBe('ref_route')
      const relativePath = String(latest.state.artifacts[0].metadata.relativePath)
      expect(JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))).toEqual(line())
    } finally {
      await store?.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function line() {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[120, 30], [121, 31]] } }
}

function noOpDb(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}
