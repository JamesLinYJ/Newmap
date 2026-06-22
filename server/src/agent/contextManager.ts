// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连续对话上下文管理器
//
//   文件:       contextManager.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  AgentRuntimeConfig,
  CompactionRecord,
  ContentRef,
  ContextAssemblyReport,
  ThreadMemoryDocument,
  TranscriptEntry,
} from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { RuntimeFileStore } from '../store/fileStore.js'

const USER_NOTES_START = '<!-- user-notes:start -->'
const USER_NOTES_END = '<!-- user-notes:end -->'

export interface ConversationChatMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface AssembledThreadContext {
  messages: ConversationChatMessage[]
  report: ContextAssemblyReport
  memory: ThreadMemoryDocument
}

export type ContextSummarizer = (prompt: string) => Promise<string>

// assembleThreadContext
//
// 只使用 canonical transcript 活动父链；run event、reasoning 和 UI progress 永不进入模型。
export async function assembleThreadContext(
  store: PostgresPlatformStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  systemPrompt: string,
): Promise<AssembledThreadContext> {
  const [rawChain, manifest, memory] = await Promise.all([
    store.activeTranscript(threadId),
    store.getThreadManifest(threadId),
    store.getThreadMemory(threadId),
  ])
  const chain = await hydrateContentReferences(store, rawChain)
  const latestSummaryIndex = findLastIndex(chain, entry => entry.kind === 'compact_summary')
  const visibleChain = latestSummaryIndex >= 0 ? chain.slice(latestSummaryIndex) : chain
  const resourceMessage = await buildThreadResourceMessage(store, threadId, visibleChain)
  let transcriptMessages = composeTranscriptMessages(visibleChain, resourceMessage)
  let includedEntries = visibleChain.filter(isModelVisibleEntry)

  const baseTokens = estimateTokens(systemPrompt) + estimateTokens(memory.content)
  const hardBudget = Math.floor(config.contextWindowTokens * config.hardLimitRatio)
  if (baseTokens + estimateMessages(transcriptMessages) > hardBudget) {
    const trimmed = preserveRecentTurns(visibleChain, config.preserveRecentTurns)
    transcriptMessages = composeTranscriptMessages(trimmed, resourceMessage)
    includedEntries = trimmed.filter(isModelVisibleEntry)
  }

  const memoryMessages: ConversationChatMessage[] = memory.content.trim()
    ? [{ role: 'system', content: `<thread-memory>\n${memory.content}\n</thread-memory>` }]
    : []
  const messages: ConversationChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...memoryMessages,
    ...transcriptMessages,
  ]
  const systemTokens = estimateTokens(systemPrompt)
  const memoryTokens = estimateTokens(memory.content)
  const resourceTokens = resourceMessage
    ? estimateMessages([{ role: 'system', content: resourceMessage }])
    : 0
  const transcriptTokens = Math.max(0, estimateMessages(transcriptMessages) - resourceTokens)
  const estimatedTokens = systemTokens + memoryTokens + transcriptTokens + resourceTokens
  const usageRatio = estimatedTokens / config.contextWindowTokens
  const includedIds = new Set(includedEntries.map(entry => entry.entryId))
  const report: ContextAssemblyReport = {
    threadId,
    activeLeafEntryId: manifest.activeLeafEntryId,
    contextWindowTokens: config.contextWindowTokens,
    estimatedTokens,
    usageRatio,
    compactionRecommended: usageRatio >= config.compactRatio,
    hardLimitReached: usageRatio >= config.hardLimitRatio,
    includedEntryIds: [...includedIds],
    omittedEntryCount: chain.filter(isModelVisibleEntry).filter(entry => !includedIds.has(entry.entryId)).length,
    latestCompactionId: manifest.latestCompactionId,
    sections: [
      { name: 'system', estimatedTokens: systemTokens },
      { name: 'memory', estimatedTokens: memoryTokens },
      { name: 'transcript', estimatedTokens: transcriptTokens },
      { name: 'resources', estimatedTokens: resourceTokens },
    ],
  }
  return { messages, report, memory }
}

// compactThreadIfNeeded
//
// 压缩只追加 boundary/summary 和最近 turn 的重放副本；原始 transcript 永不改写或删除。
export async function compactThreadIfNeeded(
  store: PostgresPlatformStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  summarize: ContextSummarizer,
  force = false,
): Promise<CompactionRecord | null> {
  const [manifest, chain] = await Promise.all([
    store.getThreadManifest(threadId),
    store.activeTranscript(threadId),
  ])
  const ratio = manifest.estimatedContextTokens / config.contextWindowTokens
  if (!force && ratio < config.compactRatio) return null

  const visible = stripCompactionReplay(chain)
  const preserveIndex = findPreserveStart(visible, config.preserveRecentTurns)
  if (preserveIndex <= 0) return null
  const compacted = visible.slice(0, preserveIndex)
  const preserved = visible.slice(preserveIndex)
  if (!compacted.some(entry => entry.kind === 'message')) return null

  const summaryPrompt = buildCompactionPrompt(compacted)
  let summary: string
  let strategy: CompactionRecord['strategy'] = 'model'
  try {
    summary = await summarize(summaryPrompt)
    if (!summary.trim()) throw new Error('摘要模型返回空内容')
  } catch {
    try {
      summary = await summarize(summaryPrompt)
      if (!summary.trim()) throw new Error('摘要模型返回空内容')
    } catch {
      summary = buildExtractiveSummary(compacted)
      strategy = 'extractive_fallback'
    }
  }

  const compactionId = makeId('compact')
  const boundary = await store.appendTranscript({
    threadId,
    kind: 'compact_boundary',
    payload: {
      compactionId,
      firstCompactedEntryId: compacted[0].entryId,
      lastCompactedEntryId: compacted.at(-1)?.entryId,
      preservedFromEntryId: preserved[0]?.entryId ?? null,
    },
  })
  const summaryEntry = await store.appendTranscript({
    threadId,
    kind: 'compact_summary',
    parentEntryId: boundary.entryId,
    payload: { compactionId, content: summary, strategy },
  })

  let parentEntryId = summaryEntry.entryId
  for (const entry of preserved) {
    const replay = await store.appendTranscript({
      threadId,
      runId: entry.runId,
      turnId: entry.turnId,
      kind: entry.kind,
      parentEntryId,
      payload: {
        ...entry.payload,
        compactionReplay: true,
        originEntryId: entry.entryId,
      },
    })
    parentEntryId = replay.entryId
  }

  const preTokens = manifest.estimatedContextTokens
  const postTokens = estimateTokens(summary) + preserved.reduce((sum, entry) => sum + estimateTokens(JSON.stringify(entry.payload)), 0)
  const record: CompactionRecord = {
    schemaVersion: 1,
    compactionId,
    threadId,
    boundaryEntryId: boundary.entryId,
    summaryEntryId: summaryEntry.entryId,
    firstCompactedEntryId: compacted[0].entryId,
    lastCompactedEntryId: compacted.at(-1)?.entryId ?? compacted[0].entryId,
    preservedFromEntryId: preserved[0]?.entryId ?? null,
    summary,
    strategy,
    preTokens,
    postTokens,
    createdAt: nowUtc(),
  }
  await store.appendCompaction(record)
  return record
}

// rebuildThreadMemory
//
// 自动区只由摘要模型维护；用户固定区逐字保留，并通过 optimistic version 避免覆盖并发编辑。
export async function rebuildThreadMemory(
  store: PostgresPlatformStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  summarize: ContextSummarizer,
  force = false,
  excludeRunId?: string,
): Promise<ThreadMemoryDocument> {
  const [manifest, current, chain] = await Promise.all([
    store.getThreadManifest(threadId),
    store.getThreadMemory(threadId),
    store.activeTranscript(threadId),
  ])
  const threshold = current.version === 0 ? config.memoryInitTokens : config.memoryUpdateTokens
  const growth = manifest.estimatedContextTokens - manifest.memoryBasedOnTokens
  if (!force && (!config.memoryEnabled || growth < threshold)) return current
  const eligibleChain = excludeRunId ? chain.filter(entry => entry.runId !== excludeRunId) : chain
  const lastSemanticEntry = findLastEntry(eligibleChain, isModelVisibleEntry)
  if (!force && (!lastSemanticEntry || !isCompletedTurnBoundary(lastSemanticEntry))) return current

  const sourceText = formatEntriesForSummary(stripCompactionReplay(eligibleChain)).slice(-80_000)
  const prompt = `请更新线程记忆。只能总结给出的可见对话，不得推测。\n\n` +
    `输出 Markdown，并严格包含：当前目标、用户约束、已确认事实、数据与产物引用、未完成事项、关键术语。\n\n` +
    `现有自动记忆：\n${current.generatedContent || '（无）'}\n\n新增对话：\n${sourceText}`
  let generated: string
  try {
    generated = (await summarize(prompt)).trim()
    if (!generated) throw new Error('memory 摘要为空')
  } catch {
    generated = buildExtractiveSummary(stripCompactionReplay(eligibleChain).slice(-24))
  }
  const content = renderMemory(generated, current.pinnedContent)
  return store.updateThreadMemory(
    threadId,
    content,
    current.version,
    'system',
    lastSemanticEntry?.entryId ?? null,
  )
}

export function buildManualMemoryContent(generatedContent: string, pinnedContent: string): string {
  return renderMemory(generatedContent, pinnedContent)
}

async function hydrateContentReferences(
  store: PostgresPlatformStore,
  entries: TranscriptEntry[],
): Promise<TranscriptEntry[]> {
  return Promise.all(entries.map(async entry => {
    if (entry.kind !== 'tool_result' || stringField(entry.payload.content)) return entry
    const reference = parseContentRef(entry.payload.contentRef)
    if (!reference) return entry
    const bytes = await store.conversationStore.readObject(reference)
    return { ...entry, payload: { ...entry.payload, content: Buffer.from(bytes).toString('utf8') } }
  }))
}

// 资源索引只在用户明确要求继续或复用时进入模型上下文，避免把历史事实静默注入新任务。
async function buildThreadResourceMessage(
  store: PostgresPlatformStore,
  threadId: string,
  entries: TranscriptEntry[],
): Promise<string | null> {
  const currentUserEntry = findLastEntry(entries, entry => entry.kind === 'message' && entry.payload.role === 'user')
  const query = stringField(currentUserEntry?.payload.content) ?? ''
  if (!/(继续|沿用|复用|之前|刚才|上次|已有|已上传|文件|图层|结果|产物|引用|报告)/u.test(query)) return null

  const files = await new RuntimeFileStore(store.runtimeRoot).list(threadId)
  const runs = store.listRunsForThread(threadId)
  const artifacts = runs.flatMap(run => run.state.artifacts).slice(-24)
  const valueRefs = runs.flatMap(run => run.state.toolValueRefs).slice(-40)
  if (!files.length && !artifacts.length && !valueRefs.length) return null
  return [
    '<thread-resources>',
    '以下仅为可执行引用索引。使用前仍须通过对应工具解析，不得根据名称推测内容。',
    ...files.slice(-24).map(file => `file: id=${file.id}; name=${file.name}; sha256=${file.contentHash}`),
    ...artifacts.map(artifact => `artifact: artifactId=${artifact.artifactId}; name=${artifact.name}; type=${artifact.artifactType}`),
    ...valueRefs.map(reference => `valueRef: refId=${reference.refId}; kind=${reference.kind}; label=${reference.label}`),
    '</thread-resources>',
  ].join('\n')
}

function composeTranscriptMessages(entries: TranscriptEntry[], resourceMessage: string | null): ConversationChatMessage[] {
  if (!resourceMessage) return entries.flatMap(toChatMessages)
  const currentUserIndex = findLastIndex(entries, entry => entry.kind === 'message' && entry.payload.role === 'user')
  if (currentUserIndex < 0) return entries.flatMap(toChatMessages)
  return [
    ...entries.slice(0, currentUserIndex).flatMap(toChatMessages),
    { role: 'system', content: resourceMessage },
    ...entries.slice(currentUserIndex).flatMap(toChatMessages),
  ]
}

function parseContentRef(value: unknown): ContentRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.algorithm !== 'sha256' || typeof record.hash !== 'string') return null
  return {
    algorithm: 'sha256',
    hash: record.hash,
    mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
    relativePath: typeof record.relativePath === 'string' ? record.relativePath : '',
  }
}

function toChatMessages(entry: TranscriptEntry): ConversationChatMessage[] {
  if (entry.kind === 'message') {
    const role = stringField(entry.payload.role)
    const content = stringField(entry.payload.content)
    return role && content ? [{ role, content }] : []
  }
  if (entry.kind === 'tool_call') {
    const callId = stringField(entry.payload.callId)
    const name = stringField(entry.payload.name)
    if (!callId || !name) return []
    const args = typeof entry.payload.arguments === 'string'
      ? entry.payload.arguments
      : JSON.stringify(entry.payload.arguments ?? {})
    return [{
      role: 'assistant',
      content: stringField(entry.payload.assistantContent),
      tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
    }]
  }
  if (entry.kind === 'tool_result') {
    const callId = stringField(entry.payload.callId)
    if (!callId) return []
    const content = stringField(entry.payload.content)
      ?? stringField(entry.payload.summary)
      ?? JSON.stringify({ contentRef: entry.payload.contentRef ?? null })
    return [{ role: 'tool', content, tool_call_id: callId }]
  }
  if (entry.kind === 'compact_summary') {
    const content = stringField(entry.payload.content)
    return content ? [{ role: 'system', content: `<conversation-summary>\n${content}\n</conversation-summary>` }] : []
  }
  return []
}

function preserveRecentTurns(entries: TranscriptEntry[], turnCount: number): TranscriptEntry[] {
  const summary = findLastEntry(entries, entry => entry.kind === 'compact_summary')
  const visible = entries.filter(entry => entry.kind !== 'compact_boundary' && entry.kind !== 'checkpoint')
  const preserveIndex = findPreserveStart(visible, turnCount)
  const recent = visible.slice(Math.max(0, preserveIndex))
  return summary && !recent.some(entry => entry.entryId === summary.entryId) ? [summary, ...recent] : recent
}

function findPreserveStart(entries: TranscriptEntry[], turnCount: number): number {
  let userTurns = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.kind === 'message' && entry.payload.role === 'user') {
      userTurns += 1
      if (userTurns >= turnCount) return index
    }
  }
  return 0
}

function stripCompactionReplay(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter(entry => entry.payload.compactionReplay !== true)
}

function isModelVisibleEntry(entry: TranscriptEntry): boolean {
  return ['message', 'tool_call', 'tool_result', 'compact_summary'].includes(entry.kind)
}

function isCompletedTurnBoundary(entry: TranscriptEntry): boolean {
  return entry.kind === 'tool_result'
    || entry.kind === 'compact_summary'
    || (entry.kind === 'message' && entry.payload.role === 'assistant')
}

function buildCompactionPrompt(entries: TranscriptEntry[]): string {
  return `请压缩以下历史对话，只保留可验证信息，不得推测或补全。\n` +
    `严格按以下 Markdown 标题输出：当前目标、用户约束、已确认事实、数据与产物引用、未完成事项、关键术语。\n\n` +
    formatEntriesForSummary(entries)
}

function formatEntriesForSummary(entries: TranscriptEntry[]): string {
  return entries.flatMap(entry => {
    if (entry.kind === 'message') {
      return [`[${String(entry.payload.role ?? 'message')}] ${String(entry.payload.content ?? '')}`]
    }
    if (entry.kind === 'tool_call') {
      return [`[tool_call ${String(entry.payload.name ?? '')}] ${JSON.stringify(entry.payload.arguments ?? {})}`]
    }
    if (entry.kind === 'tool_result') {
      return [`[tool_result ${String(entry.payload.name ?? '')}] ${String(entry.payload.summary ?? entry.payload.content ?? '')}`]
    }
    if (entry.kind === 'compact_summary') return [`[已有摘要] ${String(entry.payload.content ?? '')}`]
    return []
  }).join('\n')
}

function buildExtractiveSummary(entries: TranscriptEntry[]): string {
  const messages = entries
    .filter(entry => entry.kind === 'message')
    .slice(-16)
    .map(entry => `- ${String(entry.payload.role ?? 'message')}: ${truncate(String(entry.payload.content ?? ''), 500)}`)
  const tools = entries
    .filter(entry => entry.kind === 'tool_result')
    .slice(-8)
    .map(entry => `- ${String(entry.payload.name ?? 'tool')}: ${truncate(String(entry.payload.summary ?? entry.payload.content ?? ''), 300)}`)
  return [
    '## 当前目标', messages.at(-1) ?? '- 未识别',
    '## 用户约束', '- 抽取式降级摘要未发现可结构化约束',
    '## 已确认事实', ...messages,
    '## 数据与产物引用', ...tools,
    '## 未完成事项', '- 请结合压缩后的最近对话继续确认',
    '## 关键术语', '- 无',
    '',
    '> 此内容由抽取式降级生成，未增加历史中不存在的事实。',
  ].join('\n')
}

function renderMemory(generated: string, pinned: string): string {
  return `${generated.trim()}\n\n## 用户固定记忆\n${USER_NOTES_START}\n${pinned.trim()}\n${USER_NOTES_END}\n`
}

function estimateMessages(messages: ConversationChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0)
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index
  }
  return -1
}

function findLastEntry<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  const index = findLastIndex(values, predicate)
  return index >= 0 ? values[index] : undefined
}
