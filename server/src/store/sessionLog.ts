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
export class SessionLogStore {
    logPath;
    sessionsArr = [];
    threadsArr = [];
    runsArr = [];
    itemsArr = [];
    eventsArr = [];
    deletedThreadIds = new Set();
    writeQueue = Promise.resolve();
    constructor(root) {
        this.logPath = path.join(root, 'sessions.jsonl');
    }
    async initialize() {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        try {
            const text = await readFile(this.logPath, 'utf8');
            for (const line of text.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const record = JSON.parse(line);
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
            if (err.code !== 'ENOENT')
                throw err;
        }
    }
    allSessions() { return this.sessionsArr; }
    allThreads() { return this.threadsArr; }
    allRuns() { return this.runsArr; }
    allItems() { return this.itemsArr; }
    allEvents() { return this.eventsArr; }
    allDeletedThreadIds() { return [...this.deletedThreadIds]; }
    async flush() {
        await this.writeQueue;
    }
    append(line) {
        const serialized = JSON.stringify(line) + '\n';
        this.writeQueue = this.writeQueue.then(() => appendFile(this.logPath, serialized, 'utf8'));
    }
    appendSession(s) {
        const snapshot = structuredClone(s);
        this.sessionsArr.push(snapshot);
        this.append({ kind: 'session', session: snapshot });
    }
    appendThread(t) {
        const snapshot = structuredClone(t);
        this.threadsArr.push(snapshot);
        this.append({ kind: 'thread', thread: snapshot });
    }
    appendThreadDeleted(threadId) {
        this.deletedThreadIds.add(threadId);
        this.append({ kind: 'thread_deleted', threadId, timestamp: new Date().toISOString() });
    }
    appendRun(r) {
        const snapshot = structuredClone(r);
        this.runsArr.push(snapshot);
        this.append({ kind: 'run', run: snapshot });
    }
    appendItem(item) {
        const snapshot = structuredClone(item);
        this.itemsArr.push(snapshot);
        this.append({ kind: 'conversation_item', item: snapshot });
    }
    appendEvent(event) {
        const snapshot = structuredClone(event);
        this.eventsArr.push(snapshot);
        this.append({ kind: 'run_event', event: snapshot });
    }
}