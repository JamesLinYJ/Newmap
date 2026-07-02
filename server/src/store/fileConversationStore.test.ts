// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件型会话事实源测试
//
//   文件:       fileConversationStore.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostgresPlatformStore } from './platformStore.js'

describe('FileConversationStore', () => {
  it('serializes concurrent parent-chain writes and restores them after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-files-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并发父链')

      await Promise.all(Array.from({ length: 24 }, (_, index) => store.appendTranscript({
        threadId: thread.id,
        kind: 'message',
        payload: { role: index % 2 ? 'assistant' : 'user', content: `消息 ${index + 1}` },
      })))

      const chain = await store.activeTranscript(thread.id)
      expect(chain).toHaveLength(24)
      expect(chain.map(entry => entry.seq)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1))
      expect(new Set(chain.map(entry => entry.entryId)).size).toBe(24)

      const restored = await createStore(root)
      expect((await restored.activeTranscript(thread.id)).map(entry => entry.payload.content)).toEqual(
        chain.map(entry => entry.payload.content),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forks a self-contained ancestor chain and supports trash restore and object dedupe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-fork-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const source = await store.createThread(session.id, '原线程')
      const user = await store.appendTranscript({ threadId: source.id, kind: 'message', payload: { role: 'user', content: '记住杭州。' } })
      const assistant = await store.appendTranscript({ threadId: source.id, kind: 'message', payload: { role: 'assistant', content: '已记住杭州。' } })

      const forked = await store.forkThread(source.id, assistant.entryId, '杭州分支')
      expect((await store.activeTranscript(forked.id)).map(entry => entry.payload.content)).toEqual(['记住杭州。', '已记住杭州。'])
      expect((await store.getThreadManifest(forked.id)).forkedFrom).toEqual({ threadId: source.id, entryId: assistant.entryId })

      const firstObject = await store.conversationStore.putObject('same-content', 'text/plain')
      const secondObject = await store.conversationStore.putObject('same-content', 'text/plain')
      expect(firstObject).toEqual(secondObject)

      await store.deleteThread(source.id)
      expect(await store.listTrash(session.id)).toHaveLength(1)
      expect((await store.activeTranscript(forked.id)).at(-1)?.payload.content).toBe('已记住杭州。')
      await store.restoreThread(source.id)
      expect(store.getThread(source.id).status).toBe('active')
      expect((await store.activeTranscript(source.id)).at(-1)?.entryId).toBe(assistant.entryId)
      expect(user.parentEntryId).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a partial final line and records recoverable interior corruption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-corrupt-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '损坏恢复')
      await store.appendTranscript({ threadId: thread.id, kind: 'message', payload: { role: 'user', content: '完整消息' } })
      const transcriptPath = path.join(root, 'sessions', session.id, 'threads', thread.id, 'transcript.jsonl')

      await appendFile(transcriptPath, '{"partial":', 'utf8')
      expect(await store.activeTranscript(thread.id)).toHaveLength(1)

      const valid = (await readFile(transcriptPath, 'utf8')).split('\n')[0]
      await rm(transcriptPath, { force: true })
      await appendFile(transcriptPath, `${valid}\nnot-json\n`, 'utf8')
      expect(await store.activeTranscript(thread.id)).toHaveLength(1)
      expect((await store.getThreadManifest(thread.id)).quarantined).toBe(false)
      const ledger = await readFile(path.join(root, 'sessions', session.id, 'threads', thread.id, 'corruption.jsonl'), 'utf8')
      expect(ledger).toContain('"lineNumber":2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // 到期回收站在启动扫描中物理清理；仅被该线程引用的内容对象随后才可回收。
  it('purges expired trash and garbage-collects its unreferenced objects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-conversation-trash-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '到期线程')
      const contentRef = await store.conversationStore.putObject('expired-only-content', 'text/plain')
      await store.appendTranscript({
        threadId: thread.id,
        kind: 'message',
        payload: { role: 'assistant', content: '大型内容见引用', contentRef },
      })
      await store.conversationStore.moveThreadToTrash(thread.id, -1)

      const restored = await createStore(root)
      expect(await restored.listTrash(session.id)).toHaveLength(0)
      await expect(stat(path.join(root, contentRef.relativePath))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function createStore(root: string): Promise<PostgresPlatformStore> {
  const store = new PostgresPlatformStore({ execute: async () => ({ rows: [] }) } as Database, root)
  await store.initialize()
  return store
}
