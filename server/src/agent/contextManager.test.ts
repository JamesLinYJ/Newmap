// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连续对话上下文与压缩测试
//
//   文件:       contextManager.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { assembleThreadContext, compactThreadIfNeeded, rebuildThreadMemory } from './contextManager.js'

describe('thread context management', () => {
  it('compacts complete turns while preserving recent messages and the immutable source history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-compact-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '压缩测试')
      for (let index = 1; index <= 8; index += 1) {
        await store.appendTranscript({ threadId: thread.id, kind: 'message', payload: { role: 'user', content: `问题 ${index} ${'背景'.repeat(80)}` } })
        await store.appendTranscript({ threadId: thread.id, kind: 'message', payload: { role: 'assistant', content: `回答 ${index} ${'事实'.repeat(80)}` } })
      }
      const before = await store.activeTranscript(thread.id)
      const config = { ...defaultRuntimeConfig().context, preserveRecentTurns: 2, contextWindowTokens: 800 }
      const record = await compactThreadIfNeeded(store, thread.id, config, async () => '## 当前目标\n继续回答\n## 已确认事实\n问题 1-6 已处理', true)

      expect(record?.strategy).toBe('model')
      expect((await store.listCompactions(thread.id))).toHaveLength(1)
      const after = await store.activeTranscript(thread.id)
      expect(after.length).toBeGreaterThan(before.length)
      expect(after.some(entry => entry.entryId === before[0].entryId)).toBe(true)

      const assembled = await assembleThreadContext(store, thread.id, config, '系统提示')
      expect(assembled.messages.some(message => message.content?.includes('<conversation-summary>'))).toBe(true)
      expect(assembled.messages.some(message => message.content?.startsWith('问题 7'))).toBe(true)
      expect(assembled.messages.some(message => message.content?.startsWith('问题 1 '))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves user-pinned memory byte-for-byte during automatic rebuild', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-memory-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '记忆测试')
      await store.appendTranscript({ threadId: thread.id, kind: 'message', payload: { role: 'user', content: '所有结果使用杭州时区。' } })
      const initial = await store.updateThreadMemory(
        thread.id,
        '## 自动记忆\n旧内容\n\n## 用户固定记忆\n<!-- user-notes:start -->\n必须使用杭州时区。\n<!-- user-notes:end -->',
        0,
      )
      const config = { ...defaultRuntimeConfig().context, memoryInitTokens: 1, memoryUpdateTokens: 1 }
      const rebuilt = await rebuildThreadMemory(store, thread.id, config, async () => '## 当前目标\n生成降水分析', true)

      expect(rebuilt.version).toBe(initial.version + 1)
      expect(rebuilt.pinnedContent).toBe('必须使用杭州时区。')
      expect(rebuilt.content).toContain('必须使用杭州时区。')
      expect(rebuilt.generatedContent).toContain('生成降水分析')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hydrates content-addressed tool results and places explicit resource reuse before current input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-objects-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '资源恢复')
      const run = await store.createRun(session.id, '沿用已上传文件继续分析', { threadId: thread.id })
      await new RuntimeFileStore(root).save({
        name: 'sample.nc',
        async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer },
      }, thread.id)
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: run.userQuery },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_call',
        payload: { callId: 'call_large', name: 'inspect_dataset', arguments: {} },
      })
      const fullResult = JSON.stringify({ fact: '完整工具结果', values: Array.from({ length: 30 }, (_, index) => index) })
      const contentRef = await store.conversationStore.putObject(fullResult, 'application/json')
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_result',
        payload: { callId: 'call_large', name: 'inspect_dataset', summary: '结果过大', content: null, contentRef },
      })

      const assembled = await assembleThreadContext(store, thread.id, defaultRuntimeConfig().context, '系统提示')
      const resourceIndex = assembled.messages.findIndex(message => message.content?.includes('<thread-resources>'))
      const userIndex = assembled.messages.findIndex(message => message.content === run.userQuery)
      expect(resourceIndex).toBeGreaterThanOrEqual(0)
      expect(resourceIndex).toBeLessThan(userIndex)
      expect(assembled.messages.some(message => message.role === 'tool' && message.content === fullResult)).toBe(true)

      const agentTranscript = path.join(root, 'sessions', session.id, 'threads', thread.id, 'runs', run.id, 'agents', 'supervisor', 'transcript.jsonl')
      expect((await readFile(agentTranscript, 'utf8')).trim().split('\n')).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects asynchronous tool transcript entries into valid chat-completions order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-tools-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '工具顺序恢复')
      const run = await store.createRun(session.id, '继续使用上一轮工具结果', { threadId: thread.id })

      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: run.userQuery },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_call',
        payload: { callId: 'call_a', name: 'list_layers', arguments: { query: '杭州' } },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'checkpoint',
        payload: {
          type: 'assistant_content_for_tool_call',
          callId: 'call_a',
          content: '我先检查系统图层。',
        },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_call',
        payload: { callId: 'call_b', name: 'inspect_dataset', arguments: { dataset_ref: 'ref_nc' } },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_call',
        payload: { callId: 'call_orphan', name: 'render_map', arguments: { dataset_ref: 'ref_missing' } },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_result',
        payload: { callId: 'call_a', name: 'list_layers', content: '{"layers":["hangzhou_districts"]}' },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_result',
        payload: { callId: 'call_b', name: 'inspect_dataset', content: '{"variables":["QPF"]}' },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'assistant', content: '已经找到杭州区划和降水变量。' },
      })

      const assembled = await assembleThreadContext(store, thread.id, defaultRuntimeConfig().context, '系统提示')
      const toolCallIds = assembled.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? [])
      const callAIndex = assembled.messages.findIndex(message => message.tool_calls?.[0]?.id === 'call_a')
      const callBIndex = assembled.messages.findIndex(message => message.tool_calls?.[0]?.id === 'call_b')

      expect(toolCallIds).toEqual(['call_a', 'call_b'])
      expect(assembled.messages[callAIndex]).toMatchObject({ role: 'assistant', content: '我先检查系统图层。' })
      expect(assembled.messages[callAIndex + 1]).toMatchObject({ role: 'tool', tool_call_id: 'call_a' })
      expect(assembled.messages[callBIndex + 1]).toMatchObject({ role: 'tool', tool_call_id: 'call_b' })
      expect(JSON.stringify(assembled.messages)).not.toContain('call_orphan')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('excludes the current run from automatic memory updates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-current-run-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '当前轮隔离')
      await store.appendTranscript({ threadId: thread.id, runId: 'run_previous', kind: 'message', payload: { role: 'user', content: '历史目标' } })
      const previousAssistant = await store.appendTranscript({ threadId: thread.id, runId: 'run_previous', kind: 'message', payload: { role: 'assistant', content: '历史结论' } })
      await store.appendTranscript({ threadId: thread.id, runId: 'run_current', kind: 'message', payload: { role: 'user', content: '本轮秘密输入' } })
      let summaryPrompt = ''

      const memory = await rebuildThreadMemory(
        store,
        thread.id,
        { ...defaultRuntimeConfig().context, memoryInitTokens: 1 },
        async prompt => { summaryPrompt = prompt; return '只记录历史目标与历史结论' },
        false,
        'run_current',
      )

      expect(summaryPrompt).toContain('历史结论')
      expect(summaryPrompt).not.toContain('本轮秘密输入')
      expect(memory.basedOnEntryId).toBe(previousAssistant.entryId)
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
