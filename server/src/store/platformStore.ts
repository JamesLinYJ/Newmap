// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台持久化门面
//
//   文件:       platformStore.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Database } from '../db/connection.js'
import type { SessionRecord, AgentThreadRecord, AnalysisRun, RunSummary, AgentState, RunEvent, ConversationItem, AgentRuntimeConfig, ArtifactRef } from '../schemas/types.js'
import { makeId, nowUtc, makeShareToken } from '../utils/ids.js'
import { InMemoryEventBus } from './eventBus.js'
import { SessionLogStore } from './sessionLog.js'
import { summarizeAssistantText } from '../conversation/items.js'
import { sql } from 'drizzle-orm'
import path from 'node:path'

export class StoreNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreNotFoundError' }
}

export interface ToolCatalogEntry {
  toolKind: string
  toolName: string
  payload: Record<string, unknown>
  sortOrder: number
}

export class PostgresPlatformStore {
  static readonly DEFAULT_SESSION_ID = '__default__'

  readonly eventBus = new InMemoryEventBus<RunEvent>()
  readonly itemBus = new InMemoryEventBus<ConversationItem>()
  readonly runBus = new InMemoryEventBus<AnalysisRun>()
  readonly sessionLog: SessionLogStore
  readonly sessionLogRoot: string
  readonly runtimeRoot: string

  // In-memory indexes (populated from JSONL on startup)
  private sessions = new Map<string, SessionRecord>()
  private threads = new Map<string, AgentThreadRecord>()
  private runs = new Map<string, AnalysisRun>()
  private threadIdsBySessionId = new Map<string, Set<string>>()
  private runIdsBySessionId = new Map<string, Set<string>>()
  private runIdsByThreadId = new Map<string, Set<string>>()

  constructor(private db: Database, storageRoot: string) {
    this.sessionLogRoot = storageRoot
    this.runtimeRoot = path.basename(storageRoot) === 'sessions' ? path.dirname(storageRoot) : storageRoot
    this.sessionLog = new SessionLogStore(storageRoot)
  }

  // --- Sessions ---

  async initialize(): Promise<void> {
    // Load sessions and threads from JSONL into memory
    await this.sessionLog.initialize()
    for (const s of this.sessionLog.allSessions()) {
      this.sessions.set(s.id, s)
    }
    for (const t of this.sessionLog.allThreads()) {
      this.threads.set(t.id, t)
    }
    for (const r of this.sessionLog.allRuns()) {
      this.runs.set(r.id, r)
    }
    for (const event of this.sessionLog.allEvents()) {
      this.eventBus.publish(event.runId, event)
    }
    for (const item of this.sessionLog.allItems()) {
      this.itemBus.publish(item.runId, item)
    }
    for (const threadId of this.sessionLog.allDeletedThreadIds()) {
      this.threads.delete(threadId)
    }
    this.rebuildDerivedIndexes()
    for (const session of this.sessions.values()) {
      if (session.latestThreadId && !this.threads.has(session.latestThreadId)) {
        session.latestThreadId = this.listThreadsForSession(session.id)[0]?.id ?? null
        this.sessionLog.appendSession(session)
      }
    }
    await Promise.all([...this.sessions.values()].map(session => this.persistSession(session)))
  }

  async createSession(): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: makeId('session'), createdAt: nowUtc(), status: 'active', shareToken: makeShareToken(),
      latestThreadId: null, latestRunId: null, latestUploadedLayerKey: null,
    }
    this.sessions.set(session.id, session)
    await this.sessionLog.appendSession(session)
    await this.persistSession(session)
    return session
  }

  async getOrCreateDefaultSession(): Promise<SessionRecord> {
    try { return this.getSession(PostgresPlatformStore.DEFAULT_SESSION_ID) }
    catch {
      const session: SessionRecord = {
        id: PostgresPlatformStore.DEFAULT_SESSION_ID, createdAt: nowUtc(), status: 'active', shareToken: makeShareToken(),
        latestThreadId: null, latestRunId: null, latestUploadedLayerKey: null,
      }
      this.sessions.set(session.id, session)
      await this.sessionLog.appendSession(session)
      await this.persistSession(session)
      return session
    }
  }

  getSession(sessionId: string): SessionRecord {
    const s = this.sessions.get(sessionId)
    if (!s) throw new StoreNotFoundError(`会话 '${sessionId}' 不存在`)
    return s
  }

  async updateSession(sessionId: string, fields: Partial<SessionRecord>): Promise<SessionRecord> {
    const s = this.getSession(sessionId)
    Object.assign(s, fields)
    this.sessionLog.appendSession(s)
    await this.persistSession(s)
    return s
  }

  async getRuntimeConfig(configKey: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.execute(sql`
      SELECT payload_json
      FROM platform_runtime_config
      WHERE config_key = ${configKey}
    `)
    const row = result.rows[0] as Record<string, unknown> | undefined
    return isRecord(row?.payload_json) ? row.payload_json : null
  }

  async upsertRuntimeConfig(configKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const updatedAt = new Date()
    await this.db.execute(sql`
      INSERT INTO platform_runtime_config (config_key, updated_at, payload_json)
      VALUES (${configKey}, ${updatedAt}, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (config_key)
      DO UPDATE SET updated_at = EXCLUDED.updated_at, payload_json = EXCLUDED.payload_json
    `)
    return payload
  }

  async listToolCatalogEntries(): Promise<ToolCatalogEntry[]> {
    const result = await this.db.execute(sql`
      SELECT tool_kind, tool_name, payload_json, sort_order
      FROM tool_catalog_entries
      ORDER BY sort_order ASC, tool_kind ASC, tool_name ASC
    `)
    return result.rows.map(row => mapToolCatalogRow(row as Record<string, unknown>))
  }

  async upsertToolCatalogEntry(entry: ToolCatalogEntry): Promise<ToolCatalogEntry> {
    await this.db.execute(sql`
      INSERT INTO tool_catalog_entries (tool_kind, tool_name, payload_json, sort_order)
      VALUES (${entry.toolKind}, ${entry.toolName}, ${JSON.stringify(entry.payload)}::jsonb, ${entry.sortOrder})
      ON CONFLICT (tool_name, tool_kind)
      DO UPDATE SET payload_json = EXCLUDED.payload_json, sort_order = EXCLUDED.sort_order
    `)
    return entry
  }

  async deleteToolCatalogEntry(toolKind: string, toolName: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM tool_catalog_entries
      WHERE tool_kind = ${toolKind} AND tool_name = ${toolName}
    `)
  }

  async persistArtifact(artifact: ArtifactRef): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    await this.db.execute(sql`
      INSERT INTO platform_artifacts (
        artifact_id, run_id, artifact_type, name, uri, metadata_json, geojson_relative_path, created_at
      )
      VALUES (
        ${artifact.artifactId}, ${artifact.runId}, ${artifact.artifactType}, ${artifact.name},
        ${artifact.uri}, ${JSON.stringify(artifact.metadata)}::jsonb, ${relativePath}, ${new Date()}
      )
      ON CONFLICT (artifact_id)
      DO UPDATE SET name = EXCLUDED.name, uri = EXCLUDED.uri, metadata_json = EXCLUDED.metadata_json,
                    geojson_relative_path = EXCLUDED.geojson_relative_path
    `)
  }

  // --- Threads ---

  listThreadsForSession(sessionId: string): AgentThreadRecord[] {
    return this.readIndex(this.threadIdsBySessionId, sessionId, this.threads)
      .filter(thread => thread.status !== 'deleted')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async createThread(sessionId: string, title?: string | null): Promise<AgentThreadRecord> {
    this.getSession(sessionId)
    const now = nowUtc()
    const thread: AgentThreadRecord = {
      id: makeId('thread'), sessionId, title: title || '新对话',
      status: 'active', createdAt: now, updatedAt: now, runCount: 0,
      latestRunId: null, latestUserQuery: null, latestAssistantSummary: null,
      latestRunStatus: null, latestArtifactId: null, latestArtifactName: null,
      historyPreview: null, sessionLogPath: null,
    }
    this.threads.set(thread.id, thread)
    this.addToIndex(this.threadIdsBySessionId, sessionId, thread.id)
    await this.sessionLog.appendThread(thread)
    await this.updateSession(sessionId, { latestThreadId: thread.id })
    return thread
  }

  getThread(threadId: string): AgentThreadRecord {
    const t = this.threads.get(threadId)
    if (!t) throw new StoreNotFoundError(`线程 '${threadId}' 不存在`)
    return t
  }

  async updateThread(threadId: string, fields: Partial<AgentThreadRecord>): Promise<AgentThreadRecord> {
    const t = this.getThread(threadId)
    const previousSessionId = t.sessionId
    Object.assign(t, fields, { updatedAt: nowUtc() })
    if (previousSessionId !== t.sessionId || t.status === 'deleted') {
      this.removeFromIndex(this.threadIdsBySessionId, previousSessionId, threadId)
      if (t.status !== 'deleted') this.addToIndex(this.threadIdsBySessionId, t.sessionId, threadId)
    }
    await this.sessionLog.appendThread(t)
    return t
  }

  async deleteThread(threadId: string): Promise<void> {
    const t = this.getThread(threadId)
    t.status = 'deleted'
    await this.sessionLog.appendThreadDeleted(threadId)
    this.threads.delete(threadId)
    this.removeFromIndex(this.threadIdsBySessionId, t.sessionId, threadId)
    const threadRunIds = this.runIdsByThreadId.get(threadId)
    if (threadRunIds) {
      for (const runId of threadRunIds) this.removeFromIndex(this.runIdsBySessionId, t.sessionId, runId)
      this.runIdsByThreadId.delete(threadId)
    }
    const session = this.getSession(t.sessionId)
    if (session.latestThreadId === threadId) {
      const replacement = this.listThreadsForSession(t.sessionId)[0] ?? null
      await this.updateSession(t.sessionId, { latestThreadId: replacement?.id ?? null })
    }
  }

  // --- Runs ---

  listRunsForSession(sessionId: string): AnalysisRun[] {
    return this.readIndex(this.runIdsBySessionId, sessionId, this.runs).sort(compareRuns)
  }

  listRunsForThread(threadId: string): AnalysisRun[] {
    return this.readIndex(this.runIdsByThreadId, threadId, this.runs).sort(compareRuns)
  }

  listRunSummaries(options: {
    sessionId: string
    threadId?: string | null
    cursor?: string | null
    limit?: number
  }): { items: RunSummary[]; nextCursor: string | null } {
    this.getSession(options.sessionId)
    if (options.threadId) {
      const thread = this.getThread(options.threadId)
      if (thread.sessionId !== options.sessionId) throw new Error('threadId 不属于当前 session')
    }

    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)))
    const cursor = options.cursor ? decodeRunCursor(options.cursor) : null
    const source = options.threadId
      ? this.listRunsForThread(options.threadId)
      : this.listRunsForSession(options.sessionId)
    const eligible = cursor
      ? source.filter(run => isRunAfterCursor(run, cursor))
      : source
    const page = eligible.slice(0, limit + 1)
    const hasMore = page.length > limit
    const selected = hasMore ? page.slice(0, limit) : page

    return {
      items: selected.map(toRunSummary),
      nextCursor: hasMore && selected.length ? encodeRunCursor(selected[selected.length - 1]) : null,
    }
  }

  getRun(runId: string): AnalysisRun {
    const r = this.runs.get(runId)
    if (!r) throw new StoreNotFoundError(`运行 '${runId}' 不存在`)
    return r
  }

  createRun(sessionId: string, query: string, opts?: {
    threadId?: string | null; modelProvider?: string | null; modelName?: string | null
    runtimeConfigSnapshot?: AgentRuntimeConfig | null
  }): AnalysisRun {
    const session = this.getSession(sessionId)
    const thread = opts?.threadId ? this.getThread(opts.threadId) : null
    if (thread && thread.sessionId !== sessionId) throw new Error('run 的 thread 不属于当前 session')
    const now = nowUtc()
    const run: AnalysisRun = {
      id: makeId('run'),
      threadId: opts?.threadId ?? null,
      sessionId,
      userQuery: query,
      modelProvider: opts?.modelProvider ?? null,
      modelName: opts?.modelName ?? null,
      status: 'queued',
      createdAt: now, updatedAt: now, sessionLogPath: null,
      runtimeConfigSnapshot: opts?.runtimeConfigSnapshot ?? null,
      state: {
        sessionId, threadId: opts?.threadId ?? null, userQuery: query,
        modelProvider: opts?.modelProvider ?? null, modelName: opts?.modelName ?? null,
        loopTrace: [], todos: [], tasks: [], subAgents: [], approvals: [],
        toolResults: [], toolValueRefs: [], artifacts: [], selectedDataSources: [],
        warnings: [], errors: [], denialCounts: {}, runtimeStats: {},
        currentStep: 0, loopIteration: 0, loopPhase: 'idle',
        planRepairAttempts: 0, textOnlyDelivery: false, planMode: false,
        contextReferences: [], contextResolution: null,
        parsedIntent: null, clarification: null, placeResolution: null,
        executionPlan: null, runLifecycle: { status: 'created', reason: null, updatedAt: null },
        failedStepId: null, failedTool: null,
      },
    }
    this.runs.set(run.id, run)
    this.indexRun(run)
    this.sessionLog.appendRun(run)
    this.runBus.publish(run.id, structuredClone(run))
    session.latestRunId = run.id
    if (thread) {
      session.latestThreadId = thread.id
      thread.latestRunId = run.id
      thread.latestUserQuery = query
      thread.latestRunStatus = run.status
      thread.runCount += 1
      thread.updatedAt = now
      this.sessionLog.appendThread(thread)
    }
    this.sessionLog.appendSession(session)
    void this.persistSession(session)
    return run
  }

  updateRunState(runId: string, updates: Partial<AgentState>): AnalysisRun {
    const r = this.getRun(runId)
    Object.assign(r.state, updates)
    r.updatedAt = nowUtc()
    this.sessionLog.appendRun(r)
    this.runBus.publish(runId, structuredClone(r))
    return r
  }

  updateRunStatus(runId: string, status: AnalysisRun['status']): AnalysisRun {
    const run = this.getRun(runId)
    run.status = status
    run.updatedAt = nowUtc()
    if (run.threadId) {
      const thread = this.threads.get(run.threadId)
      if (thread) {
        thread.latestRunStatus = status
        thread.updatedAt = run.updatedAt
        this.sessionLog.appendThread(thread)
      }
    }
    this.sessionLog.appendRun(run)
    this.runBus.publish(runId, structuredClone(run))
    return run
  }

  // 派生索引只加速 JSONL 投影读取；清空后可由当前内存快照完整重建。
  private rebuildDerivedIndexes(): void {
    this.threadIdsBySessionId.clear()
    this.runIdsBySessionId.clear()
    this.runIdsByThreadId.clear()
    for (const thread of this.threads.values()) {
      if (thread.status !== 'deleted') this.addToIndex(this.threadIdsBySessionId, thread.sessionId, thread.id)
    }
    for (const run of this.runs.values()) this.indexRun(run)
  }

  private indexRun(run: AnalysisRun): void {
    if (run.threadId && !this.threads.has(run.threadId)) return
    this.addToIndex(this.runIdsBySessionId, run.sessionId, run.id)
    if (run.threadId) this.addToIndex(this.runIdsByThreadId, run.threadId, run.id)
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key) ?? new Set<string>()
    ids.add(id)
    index.set(key, ids)
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key)
    if (!ids) return
    ids.delete(id)
    if (!ids.size) index.delete(key)
  }

  private readIndex<T>(index: Map<string, Set<string>>, key: string, records: Map<string, T>): T[] {
    const ids = index.get(key)
    if (!ids) return []
    const values: T[] = []
    for (const id of ids) {
      const value = records.get(id)
      if (value) values.push(value)
    }
    return values
  }

  completeRun(runId: string, status: string): AnalysisRun {
    const r = this.getRun(runId)
    r.status = status as AnalysisRun['status']
    r.updatedAt = nowUtc()
    if (r.threadId) {
      const thread = this.threads.get(r.threadId)
      if (thread) {
        thread.latestRunStatus = r.status
        thread.updatedAt = r.updatedAt
        this.sessionLog.appendThread(thread)
      }
    }
    this.sessionLog.appendRun(r)
    this.runBus.publish(runId, structuredClone(r))
    return r
  }

  // --- Events & Items ---

  appendEvent(runId: string, event: RunEvent): void {
    this.eventBus.publish(runId, event)
    this.sessionLog.appendEvent(event)
  }

  listEvents(runId: string): RunEvent[] {
    return this.eventBus.list(runId)
  }

  appendItem(item: ConversationItem): void {
    this.itemBus.publish(item.runId, item)
    if (item.status !== 'running') {
      this.sessionLog.appendItem(item)
      this.updateThreadProjectionFromItem(item)
    }
  }

  listItems(runId: string): ConversationItem[] {
    const byItemId = new Map<string, ConversationItem>()
    for (const item of this.itemBus.list(runId)) {
      byItemId.set(item.itemId, item)
    }
    return [...byItemId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  private updateThreadProjectionFromItem(item: ConversationItem): void {
    if (!item.threadId) return
    const thread = this.threads.get(item.threadId)
    if (!thread) return

    let changed = false
    if (item.itemType === 'message' && item.role === 'assistant') {
      const summary = summarizeAssistantText(item.body ?? '')
      if (summary && thread.latestAssistantSummary !== summary) {
        thread.latestAssistantSummary = summary
        changed = true
      }
    }
    if (item.itemType === 'result') {
      const run = this.runs.get(item.runId)
      if (run && thread.latestRunStatus !== run.status) {
        thread.latestRunStatus = run.status
        changed = true
      }
    }

    if (!changed) return
    thread.updatedAt = nowUtc()
    this.sessionLog.appendThread(thread)
  }

  private async persistSession(session: SessionRecord): Promise<void> {
    const createdAt = new Date(session.createdAt)
    const updatedAt = new Date()
    await this.db.execute(sql`
      INSERT INTO platform_sessions (session_id, created_at, updated_at, payload_json)
      VALUES (${session.id}, ${Number.isNaN(createdAt.getTime()) ? updatedAt : createdAt}, ${updatedAt}, ${JSON.stringify(session)}::jsonb)
      ON CONFLICT (session_id)
      DO UPDATE SET updated_at = EXCLUDED.updated_at, payload_json = EXCLUDED.payload_json
    `)
  }
}

function mapToolCatalogRow(row: Record<string, unknown>): ToolCatalogEntry {
  return {
    toolKind: String(row.tool_kind ?? ''),
    toolName: String(row.tool_name ?? ''),
    payload: isRecord(row.payload_json) ? row.payload_json : {},
    sortOrder: Number(row.sort_order ?? 0),
  }
}

interface RunCursor {
  updatedAt: string
  id: string
}

function compareRuns(left: AnalysisRun, right: AnalysisRun): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
}

function isRunAfterCursor(run: AnalysisRun, cursor: RunCursor): boolean {
  return run.updatedAt < cursor.updatedAt || (run.updatedAt === cursor.updatedAt && run.id < cursor.id)
}

function encodeRunCursor(run: Pick<AnalysisRun, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: run.updatedAt, id: run.id }), 'utf8').toString('base64url')
}

function decodeRunCursor(cursor: string): RunCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('游标结构无效')
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id }
  } catch {
    throw new Error('cursor 无效')
  }
}

function toRunSummary(run: AnalysisRun): RunSummary {
  const latestArtifact = run.state.artifacts.at(-1) ?? null
  return {
    id: run.id,
    threadId: run.threadId,
    sessionId: run.sessionId,
    userQuery: run.userQuery,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactCount: run.state.artifacts.length,
    latestArtifactId: latestArtifact?.artifactId ?? null,
    latestArtifactName: latestArtifact?.name ?? null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
