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

  it('persists todo_write payload into AgentState.todos', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-'))
    let store: PostgresPlatformStore | undefined
    try {
      store = new PostgresPlatformStore(noOpDb(), path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Todo 测试')
      const run = await store.createRun(session.id, '执行 Todo', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'todo_write', {}, {
        message: '已更新 Todo',
        payload: {
          todos: [
            { todoId: 'todo_1', title: '检查 GIS/气象 Agent 工具', status: 'running' },
            { todoId: 'todo_2', title: '执行 Playwright 验收', status: 'pending' },
          ],
        },
        warnings: [],
        resultId: 'result_todo',
        source: 'test',
      })

      expect(store.getRun(run.id).state.todos).toEqual([
        expect.objectContaining({ todoId: 'todo_1', title: '检查 GIS/气象 Agent 工具', status: 'running' }),
        expect.objectContaining({ todoId: 'todo_2', title: '执行 Playwright 验收', status: 'pending' }),
      ])
    } finally {
      await store?.conversationStore.flush()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists request_clarification payload as a pending DecisionRequest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-clarification-'))
    let store: PostgresPlatformStore | undefined
    try {
      store = new PostgresPlatformStore(noOpDb(), path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '澄清测试')
      const run = await store.createRun(session.id, '要画图', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'request_clarification', {}, {
        message: '需要确认平台',
        payload: {
          clarification: {
            clarificationId: 'clarification_platform',
            kind: 'platform',
            reason: '缺少目标平台',
            question: '目标平台是什么？',
            allowFreeText: true,
            options: [
              { optionId: 'browser', label: '浏览器 WebGL', description: '在浏览器中运行' },
            ],
          },
        },
        warnings: [],
        resultId: 'result_clarification',
        source: 'test',
      })

      const latest = store.getRun(run.id)
      expect(latest.state.clarification).toMatchObject({
        clarificationId: 'clarification_platform',
        question: '目标平台是什么？',
        selectedOptionId: null,
      })
      expect(latest.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: 'clarification_platform',
        kind: 'clarification',
        title: '需要补充信息',
        question: '目标平台是什么？',
        status: 'pending',
        allowFreeText: true,
        payload: expect.objectContaining({ clarificationKind: 'platform' }),
      }))
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
