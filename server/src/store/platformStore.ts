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
import type { SessionRecord, AgentThreadRecord, AnalysisRun, AgentState, RunEvent, ConversationItem, AgentRuntimeConfig } from '../schemas/types.js'
import { makeId, nowUtc, makeShareToken } from '../utils/ids.js'
import { InMemoryEventBus } from './eventBus.js'
import { SessionLogStore } from './sessionLog.js'
import { summarizeAssistantText } from '../conversation/items.js'
import { sql } from 'drizzle-orm'

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
  readonly sessionLog: SessionLogStore

  // In-memory indexes (populated from JSONL on startup)
  private sessions = new Map<string, SessionRecord>()
  private threads = new Map<string, AgentThreadRecord>()
  private runs = new Map<string, AnalysisRun>()

  constructor(private db: Database, storageRoot: string) {
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
    await Promise.all([...this.sessions.values()].map(session => this.persistSession(session)))
  }

  async createSession(): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: makeId('session'), createdAt: nowUtc(), status: 'active', shareToken: makeShareToken(),
      latestThreadId: null, latestRunId: null, latestUploadedLayerKey: null, latestWeatherDatasetId: null,
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
        latestThreadId: null, latestRunId: null, latestUploadedLayerKey: null, latestWeatherDatasetId: null,
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

  // --- Threads ---

  listThreadsForSession(sessionId: string): AgentThreadRecord[] {
    return [...this.threads.values()].filter(t => t.sessionId === sessionId)
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
    Object.assign(t, fields, { updatedAt: nowUtc() })
    await this.sessionLog.appendThread(t)
    return t
  }

  async deleteThread(threadId: string): Promise<void> {
    const t = this.getThread(threadId)
    t.status = 'deleted'
    await this.sessionLog.appendThreadDeleted(threadId)
  }

  // --- Runs ---

  listRunsForSession(sessionId: string): AnalysisRun[] {
    return [...this.runs.values()].filter(r => r.sessionId === sessionId)
  }

  listRunsForThread(threadId: string): AnalysisRun[] {
    return [...this.runs.values()].filter(r => r.threadId === threadId)
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
    this.sessionLog.appendRun(run)
    return run
  }

  updateRunState(runId: string, updates: Partial<AgentState>): AnalysisRun {
    const r = this.getRun(runId)
    Object.assign(r.state, updates)
    r.updatedAt = nowUtc()
    this.sessionLog.appendRun(r)
    return r
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
