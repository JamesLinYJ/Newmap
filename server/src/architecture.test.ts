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

  it('replays completed conversation items from the session log', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-items-'))
    try {
      const db = {} as Database
      const store = new PostgresPlatformStore(db, dir)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '测试')
      const run = store.createRun(session.id, '查询杭州', { threadId: thread.id })

      store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'user', body: '查询杭州' }))
      store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'assistant', body: '杭州有雨。' }))
      store.appendItem(item({ runId: run.id, threadId: thread.id, itemType: 'result', role: null, body: null, metadata: { resultType: 'success' } }))
      await store.sessionLog.flush()

      const restored = new PostgresPlatformStore(db, dir)
      await restored.initialize()
      const restoredItems = restored.listItems(run.id)

      expect(restoredItems.map((entry) => entry.itemType)).toEqual(['message', 'message', 'result'])
      expect(restoredItems[1].body).toBe('杭州有雨。')
      expect(restoredItems[2].body).toBeNull()
      expect(restored.getThread(thread.id).latestAssistantSummary).toBe('杭州有雨。')
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
