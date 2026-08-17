// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连续对话上下文与压缩测试
//
//   文件:       contextManager.test.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import {
  assembleThreadContext,
  compactThreadIfNeeded,
  ContextBudgetExceededError,
  rebuildThreadMemory,
} from './contextManager.js'

async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

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
      await removeTempRoot(root)
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
      await removeTempRoot(root)
    }
  })

  it('hydrates content-addressed tool results and places explicit resource reuse before current input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-objects-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '资源恢复')
      const run = await store.createRun(session.id, '沿用已上传文件继续分析', { threadId: thread.id })
      await new RuntimeFileStore(root).save(
        await stageTestFile(root, 'ghost.nc', Buffer.from([9, 9, 9])),
        thread.id,
      )
      await store.fileLifecycle.upload({
        file: await stageTestFile(root, 'sample.nc', Buffer.from([1, 2, 3])),
        workspaceId: thread.workspaceId,
        sessionId: thread.sessionId,
        threadId: thread.id,
        createdByUserId: thread.createdByUserId,
      })
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
      const contentRef = await store.putConversationObject(fullResult, 'application/json')
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
      expect(assembled.messages[resourceIndex]?.content).toContain('name=sample.nc')
      expect(assembled.messages[resourceIndex]?.content).not.toContain('ghost.nc')
      expect(assembled.messages.some(message => message.role === 'tool' && message.content === fullResult)).toBe(true)

      expect(await store.activeTranscript(thread.id)).toHaveLength(3)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('does not hydrate an object that cannot fit the transcript byte budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-hard-ref-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '对象预算')
      const run = await store.createRun(session.id, '检查历史事实', { threadId: thread.id })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: '检查历史事实' },
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_call',
        payload: { callId: 'call_oversized_ref', name: 'inspect_dataset', arguments: {} },
      })
      const fullResult = JSON.stringify({ body: '敏感大结果'.repeat(20_000) })
      const contentRef = await store.putConversationObject(fullResult, 'application/json')
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'tool_result',
        payload: {
          callId: 'call_oversized_ref',
          name: 'inspect_dataset',
          summary: '大结果的有界摘要',
          content: null,
          contentRef,
        },
      })
      const readObject = vi.spyOn(store, 'readConversationObject')
      const config = {
        ...defaultRuntimeConfig().context,
        contextWindowTokens: 240,
        hardLimitRatio: 0.5,
        preserveRecentTurns: 1,
      }

      const assembled = await assembleThreadContext(store, thread.id, config, '系统提示')

      expect(readObject).not.toHaveBeenCalled()
      expect(JSON.stringify(assembled.messages)).not.toContain(fullResult)
      expect(assembled.report.estimatedTokens).toBeLessThanOrEqual(120)
      expect(assembled.report.hardLimitReached).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('never returns oversized preserved history after the final exact budget pass', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-hard-inline-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '最终预算')
      await store.appendTranscript({
        threadId: thread.id,
        kind: 'message',
        payload: { role: 'user', content: `超大历史问题：${'甲'.repeat(20_000)}` },
      })
      await store.appendTranscript({
        threadId: thread.id,
        kind: 'message',
        payload: { role: 'assistant', content: `超大历史回答：${'乙'.repeat(20_000)}` },
      })
      const config = {
        ...defaultRuntimeConfig().context,
        contextWindowTokens: 200,
        hardLimitRatio: 0.5,
        preserveRecentTurns: 1,
      }

      const assembled = await assembleThreadContext(store, thread.id, config, '系统提示')

      expect(assembled.report.estimatedTokens).toBeLessThanOrEqual(100)
      expect(assembled.report.omittedEntryCount).toBe(2)
      expect(assembled.messages).toEqual([{ role: 'system', content: '系统提示' }])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('fails before model execution when mandatory context alone exceeds the hard budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-hard-mandatory-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '强制区超限')
      const config = {
        ...defaultRuntimeConfig().context,
        contextWindowTokens: 100,
        hardLimitRatio: 0.5,
      }

      await expect(assembleThreadContext(
        store,
        thread.id,
        config,
        `不可裁剪的系统规则：${'规则'.repeat(2_000)}`,
      )).rejects.toEqual(expect.objectContaining({
        name: 'ContextBudgetExceededError',
        code: 'context_budget_exceeded',
        section: 'mandatory_context',
      } satisfies Partial<ContextBudgetExceededError>))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('injects only ownership-checked Artifact paths for explicit cross-run reuse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-artifacts-'))
    try {
      const store = await createStore(root)
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '跨运行产物')
      const previous = await store.createRun(session.id, '生成地图', { threadId: thread.id })
      const artifactId = 'artifact_previous_map'
      const relativePath = `artifacts/${previous.id}/${artifactId}.png`
      const absolutePath = path.resolve(root, relativePath)
      await mkdir(path.dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, Uint8Array.from([137, 80, 78, 71]))
      await store.persistArtifact({
        artifactId,
        runId: previous.id,
        artifactType: 'raster_png',
        name: '杭州风险区划图.png',
        uri: `/api/v1/results/${artifactId}/file`,
        display: {
          surfaces: ['download'],
          primarySurface: 'download',
          map: null,
        },
        metadata: { relativePath },
        isIntermediate: false,
      })
      const current = await store.createRun(session.id, '继续使用上次产物', { threadId: thread.id })
      await store.appendTranscript({
        threadId: thread.id,
        runId: current.id,
        kind: 'message',
        payload: { role: 'user', content: current.userQuery },
      })
      const resources = await store.listArtifactsVisibleToRun(current.id, { limit: 24 })

      const assembled = await assembleThreadContext(
        store,
        thread.id,
        defaultRuntimeConfig().context,
        '系统提示',
        { excludeRunId: current.id, artifactResources: resources },
      )
      const withoutResources = await assembleThreadContext(
        store,
        thread.id,
        defaultRuntimeConfig().context,
        '系统提示',
        { excludeRunId: current.id, artifactResources: [] },
      )
      const resourceMessage = assembled.messages.find(message => message.content?.includes('<thread-resources>'))?.content
      const resourceTokens = assembled.report.sections.find(section => section.name === 'resources')?.estimatedTokens ?? 0

      expect(resourceMessage).toContain(`artifactId=${artifactId}`)
      expect(resourceMessage).toContain(`originRunId=${previous.id}`)
      expect(resourceMessage).toContain(`sandboxPath=artifacts/${previous.id}/${artifactId}.png`)
      expect(resourceMessage).not.toContain(root)
      expect(resourceTokens).toBeGreaterThan(0)
      expect(assembled.report.estimatedTokens - withoutResources.report.estimatedTokens).toBe(resourceTokens)
    } finally {
      await removeTempRoot(root)
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
      await removeTempRoot(root)
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
      await removeTempRoot(root)
    }
  })
})

async function stageTestFile(root: string, name: string, content: Buffer) {
  const tempPath = path.join(root, 'test-staging', `${randomUUID()}.upload`)
  await mkdir(path.dirname(tempPath), { recursive: true })
  await writeFile(tempPath, content)
  return {
    name,
    tempPath,
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mediaType: 'application/octet-stream',
  }
}

async function createStore(root: string): Promise<PlatformPersistenceFacade> {
  const store = createTestPersistenceFacade(root)
  await store.initialize()
  return store
}
