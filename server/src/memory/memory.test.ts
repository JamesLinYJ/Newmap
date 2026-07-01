// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆系统核心测试
//
//   文件:       memory.test.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, mkdir, symlink, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { parseMemoryMarkdown, truncateEntrypointContent } from './markdown.js'
import { createMemoryPathConfig, resolveMemoryFilePath, validateRelativeMemoryPath } from './paths.js'
import { scanMemoryFiles } from './scan.js'
import { createMemoryRuntime, dreamMemories, extractMemoriesFromThread, readMemory, rebuildSessionMemory, searchMemories, writeMemory } from './service.js'

const tempRoots: string[] = []

describe('memory core', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('rejects traversal, encoded traversal, unicode traversal, null bytes, and symlink escape', async () => {
    expect(() => validateRelativeMemoryPath('../x.md')).toThrow('逃逸')
    expect(() => validateRelativeMemoryPath('a/%2e%2e%2fx.md')).toThrow('URL 编码')
    expect(() => validateRelativeMemoryPath('．．/x.md')).toThrow('Unicode')
    expect(() => validateRelativeMemoryPath('x\0.md')).toThrow('空字节')

    const root = await makeTempRoot()
    const outside = path.join(root, 'outside')
    const runtimeRoot = path.join(root, 'runtime')
    const privateDir = path.join(root, 'private')
    await mkdir(outside, { recursive: true })
    await mkdir(privateDir, { recursive: true })
    const config = createMemoryPathConfig(runtimeRoot, {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: privateDir,
      teamMemoryDir: path.join(root, 'team'),
    }, root)
    const link = path.join(privateDir, 'linked')
    try {
      await symlink(outside, link, 'dir')
    } catch {
      return
    }
    await expect(resolveMemoryFilePath(config, 'private', 'linked/escape.md')).rejects.toThrow('符号链接逃逸')
  })

  it('validates frontmatter, strips block comments, and extracts includes outside code', () => {
    const parsed = parseMemoryMarkdown([
      '---',
      'name: Review rule',
      'description: Review style preference',
      'type: feedback',
      'paths: src/**, tests/**',
      '---',
      '<!-- hidden -->',
      '正文 @./notes.md `@./inline.md`',
      '```',
      '@./code.md',
      '```',
    ].join('\n'), path.resolve('memory/review.md'), path.resolve('memory/review.md'))

    expect(parsed.frontmatter?.type).toBe('feedback')
    expect(parsed.content).not.toContain('hidden')
    expect(parsed.globs).toEqual(['src', 'tests'])
    expect(parsed.includePaths).toEqual([path.resolve('memory/notes.md')])
    expect(() => parseMemoryMarkdown([
      '---',
      'name: Bad',
      'description: Bad type',
      'type: architecture',
      '---',
      'body',
    ].join('\n'), 'bad.md')).toThrow()
  })

  it('truncates MEMORY.md by line and byte limits with an explicit warning', () => {
    const raw = Array.from({ length: 205 }, (_, index) => `- item ${index}`).join('\n')
    const truncated = truncateEntrypointContent(raw, 200, 25_000)

    expect(truncated.wasLineTruncated).toBe(true)
    expect(truncated.content).toContain('警告：MEMORY.md 已超过')
    expect(truncated.content.split('\n').length).toBeGreaterThan(200)
  })

  it('scans Markdown memory files newest first and excludes MEMORY.md', async () => {
    const root = await makeTempRoot()
    const oldFile = path.join(root, 'old.md')
    const newFile = path.join(root, 'new.md')
    await writeFile(oldFile, frontmatter('Old', 'Old memory', 'project'), 'utf8')
    await writeFile(newFile, frontmatter('New', 'New memory', 'feedback'), 'utf8')
    await writeFile(path.join(root, 'MEMORY.md'), '- [Old](old.md)', 'utf8')

    const oldDate = new Date('2026-01-01T00:00:00Z')
    const newDate = new Date('2026-01-02T00:00:00Z')
    await utimes(oldFile, oldDate, oldDate)
    await utimes(newFile, newDate, newDate)

    const records = await scanMemoryFiles(root, 'team')
    expect(records.map(record => record.relativePath)).toEqual(['new.md', 'old.md'])
    expect(records.map(record => record.type)).toEqual(['feedback', 'project'])
  })

  it('limits deterministic memory search to configured relevant results', async () => {
    const root = await makeTempRoot()
    const runtime = createMemoryRuntime(path.join(root, 'runtime'), {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: path.join(root, 'private'),
      teamMemoryDir: path.join(root, 'team'),
      memoryRelevantLimit: 3,
    }, root)
    for (let index = 0; index < 6; index += 1) {
      await writeMemory(runtime, {
        scope: 'private',
        type: 'project',
        name: `Rainfall memory ${index}`,
        description: `rainfall analysis context ${index}`,
        content: '长期项目背景。',
      })
    }

    const matches = await searchMemories(runtime, 'rainfall analysis')
    expect(matches).toHaveLength(3)
    expect(matches.every(match => match.record.relativePath.endsWith('.md'))).toBe(true)
  })

  it('extracts memories through restricted memory tool operations only', async () => {
    const root = await makeTempRoot()
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '受限提取')
    const run = await store.createRun(session.id, '请记住：不要用 hack，要从根因修复。', { threadId: thread.id })
    await store.appendTranscript({
      threadId: thread.id,
      runId: run.id,
      kind: 'message',
      payload: { role: 'user', content: '请记住：不要用 hack，要从根因修复。' },
    })
    const runtime = createMemoryRuntime(path.join(root, 'runtime'), {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: path.join(root, 'private'),
      teamMemoryDir: path.join(root, 'team'),
    }, root)
    const existing = await writeMemory(runtime, {
      scope: 'private',
      type: 'feedback',
      name: 'Review rule',
      description: 'User prefers root-cause fixes',
      content: '已有规则：不要用 fallback 掩盖问题。',
      relativePath: 'feedback/review-rule.md',
    })

    let calls = 0
    const written = await extractMemoriesFromThread(runtime, store, thread.id, run.id, async (prompt) => {
      calls += 1
      if (calls === 1) {
        expect(prompt).toContain('只能请求 read_memory')
        return { operations: [{ tool: 'read_memory', arguments: { scope: 'private', relativePath: existing.relativePath } }] }
      }
      expect(prompt).toContain('记忆工具观察')
      return {
        operations: [{
          tool: 'write_memory',
          arguments: {
            scope: 'private',
            type: 'feedback',
            name: 'Review rule',
            description: 'User requires root-cause fixes instead of hack patches',
            content: '规则：修改要从根因修复，不要用 fallback 或 hack 掩盖问题。',
            relativePath: existing.relativePath,
          },
        }],
      }
    })

    expect(calls).toBe(2)
    expect(written).toHaveLength(1)
    const updated = await readMemory(runtime, 'private', existing.relativePath)
    expect(updated.content).toContain('根因修复')
  })

  it('rejects non-memory tools in automatic extraction output', async () => {
    const root = await makeTempRoot()
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '提取白名单')
    const run = await store.createRun(session.id, '记住一个规则', { threadId: thread.id })
    await store.appendTranscript({
      threadId: thread.id,
      runId: run.id,
      kind: 'message',
      payload: { role: 'user', content: '记住一个规则。' },
    })
    const runtime = createMemoryRuntime(path.join(root, 'runtime'), {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: path.join(root, 'private'),
      teamMemoryDir: path.join(root, 'team'),
    }, root)

    await expect(extractMemoriesFromThread(runtime, store, thread.id, run.id, async () => ({
      operations: [{ tool: 'export_map', arguments: {} }],
    }))).rejects.toThrow()
  })

  it('excludes current run entries when rebuilding session memory for the next prompt', async () => {
    const root = await makeTempRoot()
    const store = new PostgresPlatformStore(noOpDb(), root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '当前轮隔离')
    await store.appendTranscript({ threadId: thread.id, runId: 'run_previous', kind: 'message', payload: { role: 'user', content: '历史目标' } })
    const previousAssistant = await store.appendTranscript({ threadId: thread.id, runId: 'run_previous', kind: 'message', payload: { role: 'assistant', content: '历史结论' } })
    const currentRun = await store.createRun(session.id, '本轮秘密输入', { threadId: thread.id })
    await store.appendTranscript({ threadId: thread.id, runId: currentRun.id, kind: 'message', payload: { role: 'user', content: '本轮秘密输入' } })

    let prompt = ''
    const memory = await rebuildSessionMemory(
      store,
      thread.id,
      { ...defaultRuntimeConfig().context, sessionMemoryInitTokens: 1, sessionMemoryUpdateTokens: 1 },
      async (value) => {
        prompt = value
        return '# 会话标题\n历史目标\n\n# 当前状态\n历史结论'
      },
      true,
      currentRun.id,
    )

    expect(prompt).toContain('历史目标')
    expect(prompt).not.toContain('本轮秘密输入')
    expect(memory.basedOnEntryId).toBe(previousAssistant.entryId)
  })

  it('dreams memories with a lock, validated upserts, deletes, and minimum interval state', async () => {
    const root = await makeTempRoot()
    const runtimeRoot = path.join(root, 'runtime')
    const runtime = createMemoryRuntime(runtimeRoot, {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: path.join(root, 'private'),
      teamMemoryDir: path.join(root, 'team'),
      memoryAutoDreamMinFiles: 1,
      memoryAutoDreamMinIntervalMs: 60_000,
    }, root)
    const first = await writeMemory(runtime, {
      scope: 'private',
      type: 'feedback',
      name: 'Review style',
      description: 'User wants root-cause fixes in reviews',
      content: '优先从根因修复，不要给 fallback 式补丁。',
    })
    const duplicate = await writeMemory(runtime, {
      scope: 'private',
      type: 'feedback',
      name: 'Review feedback duplicate',
      description: 'Duplicate review style memory',
      content: '不要 hack，要根因修复。',
    })

    const result = await dreamMemories(runtime, async () => ({
      summary: '合并重复评审偏好',
      upserts: [{
        scope: 'private',
        type: 'feedback',
        name: 'Review style',
        description: 'User wants root-cause fixes instead of fallback patches',
        content: '规则：优先从根因修复，不要用 fallback 或 hack 掩盖问题。\n\n**Why:** 用户多次纠正过 hack 式改法。\n\n**How to apply:** 审查方案时先定位事实源和状态边界。',
        relativePath: first.relativePath,
      }],
      deletes: [{ scope: 'private', relativePath: duplicate.relativePath, reason: '已合并到主记忆' }],
    }), { force: true })

    expect(result.changed).toBe(true)
    expect(result.records.map(record => record.relativePath)).toContain(first.relativePath)
    expect(result.records.map(record => record.relativePath)).not.toContain(duplicate.relativePath)
    await expect(readMemory(runtime, 'private', duplicate.relativePath)).rejects.toThrow()
    const updated = await readMemory(runtime, 'private', first.relativePath)
    expect(updated.content).toContain('根因修复')

    const skipped = await dreamMemories(runtime, async () => ({ summary: '', upserts: [], deletes: [] }))
    expect(skipped.changed).toBe(false)
    expect(skipped.message).toContain('距离上次')
  })
})

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'geoforge-memory-'))
  tempRoots.push(root)
  return root
}

function frontmatter(name: string, description: string, type: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, `type: ${type}`, '---', '', '内容。'].join('\n')
}

function noOpDb(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}
