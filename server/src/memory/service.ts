// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆系统服务
//
//   文件:       service.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AgentRuntimeConfig, ThreadMemoryDocument, TranscriptEntry } from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { makeId } from '../utils/ids.js'
import { buildManualMemoryContent } from '../agent/contextManager.js'
import { createMemoryPathConfig, memoryDirectoryForScope, resolveMemoryFilePath, type MemoryPathConfig } from './paths.js'
import { MEMORY_ENTRYPOINT_NAME } from './constants.js'
import { formatMemoryManifest, readMemoryRecord, scanMemoryFiles } from './scan.js'
import { truncateEntrypointContent } from './markdown.js'
import {
  memoryScopeSchema,
  memorySelectorOutputSchema,
  memoryTypeSchema,
  type MemoryFileRecord,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryType,
} from './schemas.js'

export type StructuredSelector = (prompt: string) => Promise<Record<string, unknown>>

export interface DreamOptions {
  force?: boolean
}

export interface WriteMemoryInput {
  scope: MemoryScope
  type: MemoryType
  name: string
  description: string
  content: string
  relativePath?: string | null
}

export interface MemoryRuntime {
  paths: MemoryPathConfig
  config: AgentRuntimeConfig['context']
}

export const SESSION_MEMORY_TEMPLATE = `# 会话标题
_用 5-10 个词概括本线程。_

# 当前状态
_正在做什么、还没完成什么、下一步是什么。_

# 任务规格
_用户要求、关键设计决定和约束。_

# 文件与函数
_重要文件、函数、工具或数据引用，以及为什么相关。_

# 工作流
_常用命令、运行顺序和输出解释。_

# 错误与修正
_遇到的错误、用户纠正、失败路径和不要重复的方法。_

# 系统文档
_平台组件、运行边界和上下文规则。_

# 学习记录
_有效做法、无效做法和应避免的行为。_

# 关键结果
_用户请求的具体结果、表格、结论或产物引用。_

# 工作日志
_按时间记录已尝试和已完成事项，保持简洁。_
`

export function createMemoryRuntime(
  runtimeRoot: string,
  config: AgentRuntimeConfig['context'],
  projectRoot = process.cwd(),
): MemoryRuntime {
  return { paths: createMemoryPathConfig(runtimeRoot, config, projectRoot), config }
}

export async function ensureMemoryDirectories(runtime: MemoryRuntime): Promise<void> {
  await Promise.all([
    mkdir(runtime.paths.privateDir, { recursive: true }),
    mkdir(runtime.paths.teamDir, { recursive: true }),
  ])
}

export async function listMemories(runtime: MemoryRuntime, scope?: MemoryScope): Promise<MemoryFileRecord[]> {
  await ensureMemoryDirectories(runtime)
  const scopes = scope ? [memoryScopeSchema.parse(scope)] : activeFileScopes(runtime.config)
  const records = await Promise.all(scopes.map(async currentScope => {
    const root = memoryDirectoryForScope(runtime.paths, currentScope)
    return scanMemoryFiles(root, currentScope)
  }))
  return records.flat()
}

export async function readMemory(runtime: MemoryRuntime, scope: MemoryScope, relativePath: string): Promise<MemoryFileRecord> {
  await ensureMemoryDirectories(runtime)
  const parsedScope = fileMemoryScope(scope)
  const root = memoryDirectoryForScope(runtime.paths, parsedScope)
  const fullPath = await resolveMemoryFilePath(runtime.paths, parsedScope, relativePath)
  return readMemoryRecord(root, fullPath, parsedScope)
}

export async function writeMemory(runtime: MemoryRuntime, input: WriteMemoryInput): Promise<MemoryFileRecord> {
  await ensureMemoryDirectories(runtime)
  const scope = fileMemoryScope(input.scope)
  const type = memoryTypeSchema.parse(input.type)
  const safeName = input.name.trim()
  const safeDescription = input.description.trim()
  if (!safeName || !safeDescription) throw new Error('记忆 name 和 description 不能为空')
  const relativePath = input.relativePath?.trim() || `${type}/${slugify(safeName)}.md`
  const fullPath = await resolveMemoryFilePath(runtime.paths, scope, relativePath)
  await mkdir(path.dirname(fullPath), { recursive: true })
  const body = [
    '---',
    `name: ${safeName}`,
    `description: ${safeDescription}`,
    `type: ${type}`,
    '---',
    '',
    input.content.trim(),
    '',
  ].join('\n')
  await writeFile(fullPath, body, 'utf8')
  await updateMemoryIndex(runtime, scope)
  return readMemory(runtime, scope, relativePath)
}

export async function deleteMemory(runtime: MemoryRuntime, scope: MemoryScope, relativePath: string): Promise<{ deleted: boolean; relativePath: string }> {
  await ensureMemoryDirectories(runtime)
  const parsedScope = fileMemoryScope(scope)
  const fullPath = await resolveMemoryFilePath(runtime.paths, parsedScope, relativePath)
  await rm(fullPath, { force: true })
  await updateMemoryIndex(runtime, parsedScope)
  return { deleted: true, relativePath }
}

export async function searchMemories(
  runtime: MemoryRuntime,
  query: string,
  selector?: StructuredSelector,
): Promise<MemorySearchResult[]> {
  const records = await listMemories(runtime)
  const normalizedQuery = query.trim().toLowerCase()
  if (!records.length || !normalizedQuery) return []
  if (!selector) {
    return records
      .map(record => ({ record, reason: '本地关键词匹配', score: localScore(record, normalizedQuery) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, runtime.config.memoryRelevantLimit)
  }
  const manifest = formatMemoryManifest(records)
  const output = await selector([
    '你正在为 GeoForge 选择与用户问题相关的记忆文件。',
    `最多返回 ${runtime.config.memoryRelevantLimit} 个 relativePath；不确定时不要返回。`,
    '只返回 JSON：{"selected_memories":["path.md"]}。',
    '',
    `用户问题：${query}`,
    '',
    `可用记忆：\n${manifest}`,
  ].join('\n'))
  const parsed = memorySelectorOutputSchema.parse(output)
  const byPath = new Map(records.map(record => [record.relativePath, record]))
  return parsed.selected_memories
    .map(relativePath => byPath.get(relativePath))
    .filter((record): record is MemoryFileRecord => Boolean(record))
    .slice(0, runtime.config.memoryRelevantLimit)
    .map(record => ({ record, reason: '模型选择为相关记忆', score: 1 }))
}

export async function buildMemoryPrompt(runtime: MemoryRuntime, toolsAvailable = true): Promise<string> {
  if (!runtime.config.memoryEnabled) return ''
  await ensureMemoryDirectories(runtime)
  const parts: string[] = [memoryPolicyPrompt(runtime, toolsAvailable)]
  for (const scope of activeFileScopes(runtime.config)) {
    const root = memoryDirectoryForScope(runtime.paths, scope)
    const entrypoint = path.join(root, MEMORY_ENTRYPOINT_NAME)
    const content = await readFile(entrypoint, 'utf8').catch(() => '')
    const label = scope === 'private' ? '私有记忆索引' : '团队记忆索引'
    parts.push(`## ${label}\n${content.trim() ? truncateEntrypointContent(content, runtime.config.memoryMaxIndexLines, runtime.config.memoryMaxIndexBytes).content : '当前索引为空。'}`)
  }
  if (runtime.config.instructionMemoryEnabled) {
    parts.push('## 项目指令入口\n项目指令功能已显式开启；只允许读取配置中的 AGENTS.md。')
  }
  return parts.join('\n\n')
}

export async function rebuildSessionMemory(
  store: PostgresPlatformStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  summarize: (prompt: string) => Promise<string>,
  force = false,
  excludeRunId?: string,
): Promise<ThreadMemoryDocument> {
  const [manifest, current, chain] = await Promise.all([
    store.getThreadManifest(threadId),
    store.getThreadMemory(threadId),
    store.activeTranscript(threadId),
  ])
  const threshold = current.version === 0 ? config.sessionMemoryInitTokens : config.sessionMemoryUpdateTokens
  const growth = manifest.estimatedContextTokens - manifest.memoryBasedOnTokens
  if (!force && (!config.sessionMemoryEnabled || growth < threshold)) return current
  const eligibleChain = excludeRunId ? chain.filter(entry => entry.runId !== excludeRunId) : chain
  const source = formatTranscriptForSessionMemory(eligibleChain).slice(-80_000)
  if (!force && !source.trim()) return current
  const prompt = [
    '请更新 GeoForge 线程会话记忆。只能使用给出的可见对话，不得推测。',
    '必须保留固定章节标题；每节内容应短而信息密集。',
    '',
    `当前模板或旧记忆：\n${current.generatedContent || SESSION_MEMORY_TEMPLATE}`,
    '',
    `新增对话：\n${source}`,
  ].join('\n')
  const generated = (await summarize(prompt)).trim()
  if (!generated) throw new Error('会话记忆摘要为空')
  return store.updateThreadMemory(threadId, buildManualMemoryContent(generated, current.pinnedContent), current.version, 'system', eligibleChain.at(-1)?.entryId ?? null)
}

export async function extractMemoriesFromThread(
  runtime: MemoryRuntime,
  store: PostgresPlatformStore,
  threadId: string,
  runId: string,
  selector: StructuredSelector,
): Promise<MemoryFileRecord[]> {
  if (!runtime.config.memoryAutoExtractEnabled) return []
  const run = store.getRun(runId)
  const wroteMemory = run.state.toolResults.some(result => ['write_memory', 'forget_memory'].includes(result.tool))
  if (wroteMemory) return []
  const chain = await store.activeTranscript(threadId)
  const existing = await listMemories(runtime)
  return runRestrictedMemoryExtractor(runtime, selector, chain.slice(-24), existing)
}

export async function dreamMemories(
  runtime: MemoryRuntime,
  selector?: StructuredSelector,
  options: DreamOptions = {},
): Promise<{ changed: boolean; message: string; records: MemoryFileRecord[]; summary?: string; warnings?: string[] }> {
  await ensureMemoryDirectories(runtime)
  if (!runtime.config.memoryAutoDreamEnabled && !selector) {
    return { changed: false, message: '记忆整理功能未启用', records: [] }
  }
  return withDreamLock(runtime, async () => {
    const records = await listMemories(runtime)
    if (!records.length) {
      for (const scope of activeFileScopes(runtime.config)) await updateMemoryIndex(runtime, scope)
      return { changed: false, message: '没有可整理的记忆。', records: [] }
    }
    if (!selector) {
      for (const scope of activeFileScopes(runtime.config)) await updateMemoryIndex(runtime, scope)
      return { changed: false, message: '已刷新记忆索引；未配置模型整理器。', records }
    }
    if (!options.force && records.length < runtime.config.memoryAutoDreamMinFiles) {
      for (const scope of activeFileScopes(runtime.config)) await updateMemoryIndex(runtime, scope)
      return { changed: false, message: `记忆文件少于 ${runtime.config.memoryAutoDreamMinFiles} 个，暂不整理。`, records }
    }
    const state = await readDreamState(runtime)
    if (!options.force && state.lastCompletedAt && Date.now() - Date.parse(state.lastCompletedAt) < runtime.config.memoryAutoDreamMinIntervalMs) {
      return { changed: false, message: '距离上次自动整理时间过短，暂不重复整理。', records }
    }

    const detailedRecords = await Promise.all(records.map(record => readMemory(runtime, record.scope, record.relativePath)))
    const output = memoryDreamOutputSchema().parse(await selector(buildDreamPrompt(runtime, detailedRecords)))
    const existingKeys = new Set(records.map(record => memoryKey(record.scope, record.relativePath)))
    const upsertKeys = new Set(output.upserts.flatMap(item => item.relativePath ? [memoryKey(item.scope, item.relativePath)] : []))
    const warnings: string[] = []
    let changed = false

    for (const deletion of output.deletes) {
      const key = memoryKey(deletion.scope, deletion.relativePath)
      if (!existingKeys.has(key)) {
        warnings.push(`忽略不存在的删除目标：${key}`)
        continue
      }
      if (upsertKeys.has(key)) continue
      await deleteMemory(runtime, deletion.scope, deletion.relativePath)
      changed = true
    }

    for (const upsert of output.upserts) {
      await writeMemory(runtime, upsert)
      changed = true
    }

    for (const scope of activeFileScopes(runtime.config)) await updateMemoryIndex(runtime, scope)
    const nextRecords = await listMemories(runtime)
    await writeDreamState(runtime, { lastCompletedAt: new Date().toISOString(), lastSummary: output.summary, recordCount: nextRecords.length })
    return {
      changed,
      message: changed ? '记忆整理已完成。' : '记忆整理完成，没有需要改写的文件。',
      records: nextRecords,
      summary: output.summary,
      warnings,
    }
  })
}

async function updateMemoryIndex(runtime: MemoryRuntime, scope: MemoryScope): Promise<void> {
  const root = memoryDirectoryForScope(runtime.paths, scope)
  const records = await scanMemoryFiles(root, scope)
  const lines = records.map(record => `- [${record.name || record.relativePath}](${record.relativePath}) — ${record.description || record.type || '记忆'}`)
  await writeFile(path.join(root, MEMORY_ENTRYPOINT_NAME), `${lines.join('\n')}\n`, 'utf8')
}

function memoryPolicyPrompt(runtime: MemoryRuntime, toolsAvailable: boolean): string {
  const accessRules = toolsAvailable
    ? [
        '如果用户明确要求记住或忘记，必须调用记忆工具写入或删除。',
        '如果用户要求回忆、之前、记忆、过去经验，必须先 search_memory 或 read_memory。',
      ]
    : [
        '当前运行没有启用记忆工具 Provider；不要声称已经保存、删除、搜索或读取长期记忆。',
        '如果用户要求记住、忘记或回忆，说明记忆工具当前不可用，需要启用 geo-platform-memory Provider 后再执行。',
      ]
  return [
    '# GeoForge 记忆系统',
    '',
    `你有持久化文件记忆系统。私有记忆目录：\`${runtime.paths.privateDir}\`；团队记忆目录：\`${runtime.paths.teamDir}\`。`,
    '`MEMORY.md` 只是索引，不能保存正文。正文必须写入独立 Markdown 文件，且 frontmatter 必须包含 name、description、type。',
    '记忆类型只允许 user、feedback、project、reference。',
    '',
    '## 记忆类型',
    '- user：用户角色、目标、责任、知识背景和沟通偏好。始终优先写 private，避免负面判断和无关个人信息。',
    '- feedback：用户给出的工作方式规则，包括明确纠正和已确认有效的非显然做法。个人偏好写 private；团队级测试政策、构建约束或协作规则可写 team。',
    '- project：项目中不可从代码或 Git 推导的目标、动机、约束、发布时间、干系人信息。保存时把相对日期转换为绝对日期。',
    '- reference：外部系统的位置和用途，例如问题追踪、仪表盘、文档、数据门户。通常写 team，且只保存入口和使用场景。',
    '',
    '## 不应保存',
    '不要保存代码结构、文件路径、Git 历史、当前临时任务或可从仓库推导的事实。',
    '不要保存工具结果流水账、临时 artifact 名称、当前 run 的中间状态，或历史运行日志扫描出来的事实。',
    '即使用户明确要求，也不要把 PR 列表、活动摘要或代码架构快照当作长期记忆；应询问其中哪些非显然背景值得保留。',
    '',
    '## 使用规则',
    ...accessRules,
    '记忆可能过期；涉及文件、函数、配置、图层、工具能力时，必须先验证当前状态。',
    runtime.config.instructionMemoryEnabled
      ? '项目指令入口已开启，但只允许 AGENTS.md。'
      : '项目指令入口当前关闭；不要读取 AGENTS.md 作为产品 Agent 上下文。',
  ].join('\n')
}

function activeFileScopes(config: AgentRuntimeConfig['context']): Array<'private' | 'team'> {
  return config.teamMemoryEnabled ? ['private', 'team'] : ['private']
}

function fileMemoryScope(scope: MemoryScope): 'private' | 'team' {
  if (scope === 'private' || scope === 'team') return scope
  throw new Error(`作用域 "${scope}" 不能作为文件记忆写入目标`)
}

function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || makeId('memory')
}

function localScore(record: MemoryFileRecord, query: string): number {
  const haystack = `${record.name} ${record.description} ${record.type ?? ''}`.toLowerCase()
  const terms = query.split(/\s+/u).filter(Boolean)
  if (!terms.length) return 0
  const hits = terms.filter(term => haystack.includes(term)).length
  return hits / terms.length
}

function formatTranscriptForSessionMemory(entries: TranscriptEntry[]): string {
  return entries.flatMap(entry => {
    if (entry.kind === 'message') return [`[${String(entry.payload.role ?? 'message')}] ${String(entry.payload.content ?? '')}`]
    if (entry.kind === 'tool_call') return [`[tool_call ${String(entry.payload.name ?? '')}] ${JSON.stringify(entry.payload.arguments ?? {})}`]
    if (entry.kind === 'tool_result') return [`[tool_result ${String(entry.payload.name ?? '')}] ${String(entry.payload.summary ?? entry.payload.content ?? '')}`]
    return []
  }).join('\n')
}

async function runRestrictedMemoryExtractor(
  runtime: MemoryRuntime,
  selector: StructuredSelector,
  entries: TranscriptEntry[],
  existing: MemoryFileRecord[],
): Promise<MemoryFileRecord[]> {
  const firstOutput = memoryExtractorOutputSchema().parse(
    await selector(buildExtractionPrompt(runtime, entries, existing)),
  )
  const first = await executeMemoryExtractorOperations(runtime, firstOutput.operations)
  if (!first.observations.some(observation => observation.kind === 'read' || observation.kind === 'search')) {
    return uniqueWrittenRecords(first.written)
  }

  const secondOutput = memoryExtractorMutationOutputSchema().parse(
    await selector(buildExtractionFollowupPrompt(runtime, entries, existing, first.observations)),
  )
  const second = await executeMemoryExtractorOperations(runtime, secondOutput.operations)
  return uniqueWrittenRecords([...first.written, ...second.written])
}

async function executeMemoryExtractorOperations(
  runtime: MemoryRuntime,
  operations: MemoryExtractorOperation[],
): Promise<{ written: MemoryFileRecord[]; observations: MemoryExtractorObservation[] }> {
  const written: MemoryFileRecord[] = []
  const observations: MemoryExtractorObservation[] = []
  for (const operation of operations.slice(0, 10)) {
    if (operation.tool === 'read_memory') {
      try {
        const record = await readMemory(runtime, operation.arguments.scope, operation.arguments.relativePath)
        observations.push({
          kind: 'read',
          tool: operation.tool,
          ok: true,
          relativePath: record.relativePath,
          payload: pickMemoryRecordForObservation(record),
        })
      } catch (error) {
        observations.push({
          kind: 'read',
          tool: operation.tool,
          ok: false,
          relativePath: operation.arguments.relativePath,
          error: errorMessage(error),
        })
      }
      continue
    }
    if (operation.tool === 'search_memory') {
      const matches = await searchMemories(runtime, operation.arguments.query)
      observations.push({
        kind: 'search',
        tool: operation.tool,
        ok: true,
        query: operation.arguments.query,
        payload: matches.map(match => ({
          scope: match.record.scope,
          relativePath: match.record.relativePath,
          name: match.record.name,
          description: match.record.description,
          type: match.record.type,
          score: match.score,
        })),
      })
      continue
    }
    if (operation.tool === 'write_memory') {
      const record = await writeMemory(runtime, operation.arguments)
      written.push(record)
      observations.push({
        kind: 'write',
        tool: operation.tool,
        ok: true,
        relativePath: record.relativePath,
        payload: pickMemoryRecordForObservation(record),
      })
      continue
    }
    const deleted = await deleteMemory(runtime, operation.arguments.scope, operation.arguments.relativePath)
    observations.push({
      kind: 'forget',
      tool: operation.tool,
      ok: true,
      relativePath: deleted.relativePath,
      payload: deleted,
    })
  }
  return { written, observations }
}

function buildExtractionPrompt(runtime: MemoryRuntime, entries: TranscriptEntry[], existing: MemoryFileRecord[]): string {
  const manifest = formatMemoryManifest(existing)
  return [
    '你是 GeoForge 记忆提取子任务。只根据下面最近对话提取长期有用记忆。',
    '这是受限 fork 语义：你只能请求 read_memory、search_memory、write_memory、forget_memory 四类记忆工具操作。',
    '不能请求任何 GIS、气象、文件导出、shell、项目源码读取、外部网络或业务副作用工具。',
    '如果本轮没有长期价值，返回 {"operations":[]}。',
    '如果需要确认已有 topic file 正文，第一阶段只输出 read_memory 或 search_memory；服务端会把观察结果回传给第二阶段。',
    '如果 manifest 已足够判断，可直接输出 write_memory 或 forget_memory。',
    '不要保存可从仓库、工具结果、Git 历史直接推导的事实。',
    '不要读取或推断业务源码；不要把历史运行日志、临时 artifact、当前 run 中间状态保存为记忆。',
    'MEMORY.md 是索引，不是正文。候选 content 必须是独立 topic file 正文。',
    '输出 JSON：{"operations":[{"tool":"write_memory","arguments":{"scope":"private|team","type":"user|feedback|project|reference","name":"...","description":"...","content":"...","relativePath":"可选.md"}}]}',
    '允许的 tool 值只有：read_memory、search_memory、write_memory、forget_memory。其它 tool 会被 schema 拒绝。',
    `记忆目录：private=${runtime.paths.privateDir}; team=${runtime.paths.teamDir}`,
    '',
    existing.length ? `已有记忆文件：\n${manifest}` : '已有记忆文件：无。',
    '',
    formatTranscriptForSessionMemory(entries),
  ].join('\n')
}

function buildExtractionFollowupPrompt(
  runtime: MemoryRuntime,
  entries: TranscriptEntry[],
  existing: MemoryFileRecord[],
  observations: MemoryExtractorObservation[],
): string {
  return [
    '你是 GeoForge 记忆提取子任务的第二阶段。下面是第一阶段记忆工具观察结果。',
    '现在只能输出 write_memory 或 forget_memory；如果无需写入或删除，返回 {"operations":[]}。',
    '仍然只允许保存长期有用、不可从仓库或 Git 推导的事实；MEMORY.md 仍然只是索引。',
    '输出 JSON：{"operations":[{"tool":"write_memory","arguments":{"scope":"private|team","type":"user|feedback|project|reference","name":"...","description":"...","content":"...","relativePath":"可选.md"}}]}',
    `记忆目录：private=${runtime.paths.privateDir}; team=${runtime.paths.teamDir}`,
    '',
    existing.length ? `原始 manifest：\n${formatMemoryManifest(existing)}` : '原始 manifest：无。',
    '',
    `记忆工具观察：\n${JSON.stringify(observations, null, 2)}`,
    '',
    `最近对话：\n${formatTranscriptForSessionMemory(entries)}`,
  ].join('\n')
}

const fileScopeSchema = z.enum(['private', 'team'])

const writeMemoryArgumentsSchema = z.object({
  scope: fileScopeSchema,
  type: memoryTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  relativePath: z.string().min(1).optional(),
})

const readMemoryOperationSchema = z.object({
  tool: z.literal('read_memory'),
  arguments: z.object({
    scope: fileScopeSchema,
    relativePath: z.string().min(1),
  }),
})

const searchMemoryOperationSchema = z.object({
  tool: z.literal('search_memory'),
  arguments: z.object({
    query: z.string().min(1),
  }),
})

const writeMemoryOperationSchema = z.object({
  tool: z.literal('write_memory'),
  arguments: writeMemoryArgumentsSchema,
})

const forgetMemoryOperationSchema = z.object({
  tool: z.literal('forget_memory'),
  arguments: z.object({
    scope: fileScopeSchema,
    relativePath: z.string().min(1),
  }),
})

const memoryExtractorOperationSchema = z.discriminatedUnion('tool', [
  readMemoryOperationSchema,
  searchMemoryOperationSchema,
  writeMemoryOperationSchema,
  forgetMemoryOperationSchema,
])

const memoryExtractorMutationOperationSchema = z.discriminatedUnion('tool', [
  writeMemoryOperationSchema,
  forgetMemoryOperationSchema,
])

function memoryExtractorOutputSchema() {
  return z.object({
    operations: z.array(memoryExtractorOperationSchema).default([]),
  })
}

function memoryExtractorMutationOutputSchema() {
  return z.object({
    operations: z.array(memoryExtractorMutationOperationSchema).default([]),
  })
}

type MemoryExtractorOperation = z.infer<typeof memoryExtractorOperationSchema>

interface MemoryExtractorObservation {
  kind: 'read' | 'search' | 'write' | 'forget'
  tool: MemoryExtractorOperation['tool']
  ok: boolean
  relativePath?: string
  query?: string
  payload?: unknown
  error?: string
}

function memoryDreamOutputSchema() {
  return z.object({
    summary: z.string().default(''),
    upserts: z.array(z.object({
      scope: fileScopeSchema,
      type: memoryTypeSchema,
      name: z.string().min(1),
      description: z.string().min(1),
      content: z.string().min(1),
      relativePath: z.string().optional(),
    })).default([]),
    deletes: z.array(z.object({
      scope: fileScopeSchema,
      relativePath: z.string().min(1),
      reason: z.string().default(''),
    })).default([]),
  })
}

function buildDreamPrompt(runtime: MemoryRuntime, records: MemoryFileRecord[]): string {
  const bodies = records.map(record => [
    `## ${record.scope}:${record.relativePath}`,
    `name: ${record.name}`,
    `description: ${record.description}`,
    `type: ${record.type}`,
    '',
    record.content ?? '',
  ].join('\n')).join('\n\n---\n\n')
  return [
    '你是 GeoForge 长期记忆整理子任务。你的目标是合并重复、删除过期或低价值记忆，并保持 topic file 精炼。',
    '只能输出 JSON，不要输出 Markdown 说明。',
    '允许操作：',
    '- upserts：写入或更新 topic file。更新已有文件时必须带 relativePath。',
    '- deletes：删除确定重复、被 upsert 合并、或明显低价值的已有 topic file。',
    '禁止操作：',
    '- 不要保存代码结构、文件路径、Git 历史、运行日志或当前临时任务。',
    '- 不要制造 team memory 远端同步成功信息；team 记忆只代表本地共享目录事实。',
    '- 不确定时保持原样。',
    '输出格式：{"summary":"整理摘要","upserts":[{"scope":"private|team","type":"user|feedback|project|reference","name":"...","description":"...","content":"...","relativePath":"可选已有路径.md"}],"deletes":[{"scope":"private|team","relativePath":"已有路径.md","reason":"..."}]}',
    `索引限制：${runtime.config.memoryMaxIndexLines} 行 / ${runtime.config.memoryMaxIndexBytes} bytes；相关读取上限：${runtime.config.memoryRelevantLimit}。`,
    '',
    bodies,
  ].join('\n')
}

async function withDreamLock<T extends { changed: boolean; message: string; records: MemoryFileRecord[] }>(
  runtime: MemoryRuntime,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = dreamLockPath(runtime)
  await mkdir(path.dirname(lockPath), { recursive: true })
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return { changed: false, message: '已有记忆整理任务正在运行。', records: await listMemories(runtime) } as T
    }
    throw error
  }
  try {
    return await callback()
  } finally {
    await rm(lockPath, { force: true })
  }
}

async function readDreamState(runtime: MemoryRuntime): Promise<{ lastCompletedAt?: string; lastSummary?: string; recordCount?: number }> {
  const filePath = dreamStatePath(runtime)
  const raw = await readFile(filePath, 'utf8').catch(() => '')
  if (!raw.trim()) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return {}
  return {
    lastCompletedAt: typeof parsed.lastCompletedAt === 'string' ? parsed.lastCompletedAt : undefined,
    lastSummary: typeof parsed.lastSummary === 'string' ? parsed.lastSummary : undefined,
    recordCount: typeof parsed.recordCount === 'number' ? parsed.recordCount : undefined,
  }
}

async function writeDreamState(
  runtime: MemoryRuntime,
  state: { lastCompletedAt: string; lastSummary: string; recordCount: number },
): Promise<void> {
  const filePath = dreamStatePath(runtime)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8')
}

function dreamLockPath(runtime: MemoryRuntime): string {
  return path.join(runtime.paths.runtimeRoot, 'memory', 'auto-dream.lock')
}

function dreamStatePath(runtime: MemoryRuntime): string {
  return path.join(runtime.paths.runtimeRoot, 'memory', 'auto-dream-state.json')
}

function memoryKey(scope: string, relativePath: string): string {
  return `${scope}:${relativePath}`
}

function uniqueWrittenRecords(records: MemoryFileRecord[]): MemoryFileRecord[] {
  const byKey = new Map<string, MemoryFileRecord>()
  for (const record of records) byKey.set(memoryKey(record.scope, record.relativePath), record)
  return [...byKey.values()]
}

function pickMemoryRecordForObservation(record: MemoryFileRecord): Record<string, unknown> {
  return {
    scope: record.scope,
    relativePath: record.relativePath,
    type: record.type,
    name: record.name,
    description: record.description,
    content: record.content,
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
