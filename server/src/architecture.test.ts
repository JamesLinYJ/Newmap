// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话事实源架构测试
//
//   文件:       architecture.test.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from './db/connection.js'
import type { ConversationItem } from './schemas/types.js'
import { PostgresPlatformStore } from './store/platformStore.js'

describe('conversation architecture', () => {
  it('keeps removed response/message-frame models out of runtime source', async () => {
    const root = path.resolve(process.cwd(), '..')
    const files = await collectSourceFiles([
      path.join(root, 'server/src'),
      path.join(root, 'apps/web/src'),
      path.join(root, 'packages/shared-types/src-ts'),
    ])
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

    const forbidden = [
      'final' + 'Response',
      'Agent' + 'FinalResponse',
      'agent' + 'FinalResponse',
      'message' + '_fra' + 'me',
      'Agent' + 'MessageFrame',
      'append' + '_message' + '_fra' + 'me',
      'subscribe' + '_messages',
      'list' + '_messages',
      'as ' + 'any',
    ]

    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('replays completed conversation items from per-run files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-items-'))
    try {
      const db = noOpDb()
      const store = new PostgresPlatformStore(db, dir)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '测试')
      const run = await store.createRun(session.id, '查询杭州', { threadId: thread.id })

      store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'user', body: '查询杭州' }))
      store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'assistant', body: '杭州有雨。' }))
      store.appendItem(item({ runId: run.id, threadId: thread.id, itemType: 'result', role: null, body: null, metadata: { resultType: 'success' } }))
      await store.conversationStore.flush()

      const restored = new PostgresPlatformStore(db, dir)
      await restored.initialize()
      const restoredItems = await restored.listItems(run.id)

      expect(restoredItems.map((entry) => entry.itemType)).toEqual(['message', 'message', 'result'])
      expect(restoredItems[1].body).toBe('杭州有雨。')
      expect(restoredItems[2].body).toBeNull()
      expect(restored.getThread(thread.id).latestAssistantSummary).toBe('杭州有雨。')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('replays the latest thread projection and keeps deleted threads removed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-threads-'))
    try {
      const db = noOpDb()
      const store = new PostgresPlatformStore(db, dir)
      await store.initialize()
      const session = await store.createSession()
      const first = await store.createThread(session.id, '保留线程')
      const deleted = await store.createThread(session.id, '删除线程')
      await store.deleteThread(deleted.id)
      await store.conversationStore.flush()

      const restored = new PostgresPlatformStore(db, dir)
      await restored.initialize()

      expect(restored.getSession(session.id).latestThreadId).toBe(first.id)
      expect(restored.listThreadsForSession(session.id).map(thread => thread.id)).toEqual([first.id])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rebuilds derived indexes and pages run summaries without thread fan-out', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-run-index-'))
    try {
      const db = noOpDb()
      const store = new PostgresPlatformStore(db, dir)
      await store.initialize()
      const session = await store.createSession()
      const threadIds: string[] = []

      for (let index = 0; index < 28; index += 1) {
        const thread = await store.createThread(session.id, `线程 ${index + 1}`)
        threadIds.push(thread.id)
        await store.createRun(session.id, `查询 ${index + 1}`, { threadId: thread.id })
      }

      const first = store.listRunSummaries({ sessionId: session.id, limit: 20 })
      const second = store.listRunSummaries({ sessionId: session.id, limit: 20, cursor: first.nextCursor })
      expect(first.items).toHaveLength(20)
      expect(first.nextCursor).not.toBeNull()
      expect(second.items).toHaveLength(8)
      expect(new Set([...first.items, ...second.items].map(run => run.id)).size).toBe(28)

      await store.deleteThread(threadIds[0])
      expect(store.listRunSummaries({ sessionId: session.id, limit: 100 }).items).toHaveLength(27)
      await store.conversationStore.flush()

      const restored = new PostgresPlatformStore(db, dir)
      await restored.initialize()
      expect(restored.listThreadsForSession(session.id)).toHaveLength(27)
      expect(restored.listRunSummaries({ sessionId: session.id, limit: 100 }).items).toHaveLength(27)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function collectSourceFiles(roots: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    await collect(root, files)
  }
  return files.filter((file) => /\.(ts|tsx)$/u.test(file))
}

async function collect(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      await collect(fullPath, files)
    } else {
      files.push(fullPath)
    }
  }
}

function noOpDb(): Database {
  return {
    execute: async () => ({ rows: [] }),
  } as Database
}

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: overrides.itemId ?? `item_${overrides.role ?? overrides.itemType ?? 'entry'}`,
    itemType: overrides.itemType ?? 'message',
    runId: overrides.runId ?? 'run_1',
    threadId: overrides.threadId ?? 'thread_1',
    turnId: null,
    callId: null,
    role: overrides.role ?? 'assistant',
    body: overrides.body ?? null,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: overrides.status ?? 'completed',
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  }
}
