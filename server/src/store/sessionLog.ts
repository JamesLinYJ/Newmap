// +-------------------------------------------------------------------------
//
//   地理智能平台 - JSONL 会话日志（append-only）
//
//   文件:       sessionLog.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
    AgentThreadRecord,
    AnalysisRun,
    ConversationItem,
    RunEvent,
    SessionRecord,
} from '../schemas/types.js';

type SessionLogRecord =
    | { kind: 'session'; session: SessionRecord }
    | { kind: 'thread'; thread: AgentThreadRecord }
    | { kind: 'thread_deleted'; threadId: string; timestamp: string }
    | { kind: 'run'; run: AnalysisRun }
    | { kind: 'conversation_item'; item: ConversationItem }
    | { kind: 'run_event'; event: RunEvent };

export class SessionLogStore {
    logPath: string;
    sessionsArr: SessionRecord[] = [];
    threadsArr: AgentThreadRecord[] = [];
    runsArr: AnalysisRun[] = [];
    itemsArr: ConversationItem[] = [];
    eventsArr: RunEvent[] = [];
    deletedThreadIds = new Set<string>();
    writeQueue: Promise<void> = Promise.resolve();
    constructor(root: string) {
        this.logPath = path.join(root, 'sessions.jsonl');
    }
    async initialize(): Promise<void> {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        try {
            const text = await readFile(this.logPath, 'utf8');
            for (const line of text.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const record = JSON.parse(line) as Partial<SessionLogRecord>;
                    if (record.kind === 'session' && record.session)
                        this.sessionsArr.push(record.session);
                    if (record.kind === 'thread' && record.thread)
                        this.threadsArr.push(record.thread);
                    if (record.kind === 'thread_deleted' && record.threadId)
                        this.deletedThreadIds.add(record.threadId);
                    if (record.kind === 'run' && record.run)
                        this.runsArr.push(record.run);
                    if (record.kind === 'conversation_item' && record.item)
                        this.itemsArr.push(record.item);
                    if (record.kind === 'run_event' && record.event)
                        this.eventsArr.push(record.event);
                }
                catch { /* skip malformed lines */ }
            }
        }
        catch (err) {
            if (!isNodeError(err) || err.code !== 'ENOENT')
                throw err;
        }
    }
    allSessions(): SessionRecord[] { return this.sessionsArr; }
    allThreads(): AgentThreadRecord[] { return this.threadsArr; }
    allRuns(): AnalysisRun[] { return this.runsArr; }
    allItems(): ConversationItem[] { return this.itemsArr; }
    allEvents(): RunEvent[] { return this.eventsArr; }
    allDeletedThreadIds(): string[] { return [...this.deletedThreadIds]; }
    async flush(): Promise<void> {
        await this.writeQueue;
    }
    append(line: SessionLogRecord): void {
        const serialized = JSON.stringify(line) + '\n';
        this.writeQueue = this.writeQueue.then(() => appendFile(this.logPath, serialized, 'utf8'));
    }
    appendSession(s: SessionRecord): void {
        const snapshot = structuredClone(s);
        this.sessionsArr.push(snapshot);
        this.append({ kind: 'session', session: snapshot });
    }
    appendThread(t: AgentThreadRecord): void {
        const snapshot = structuredClone(t);
        this.threadsArr.push(snapshot);
        this.append({ kind: 'thread', thread: snapshot });
    }
    appendThreadDeleted(threadId: string): void {
        this.deletedThreadIds.add(threadId);
        this.append({ kind: 'thread_deleted', threadId, timestamp: new Date().toISOString() });
    }
    appendRun(r: AnalysisRun): void {
        const snapshot = structuredClone(r);
        this.runsArr.push(snapshot);
        this.append({ kind: 'run', run: snapshot });
    }
    appendItem(item: ConversationItem): void {
        const snapshot = structuredClone(item);
        this.itemsArr.push(snapshot);
        this.append({ kind: 'conversation_item', item: snapshot });
    }
    appendEvent(event: RunEvent): void {
        const snapshot = structuredClone(event);
        this.eventsArr.push(snapshot);
        this.append({ kind: 'run_event', event: snapshot });
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
