# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 会话日志
#
#   文件:       session_log_store.py
#
#   日期:       2026年05月21日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 以 append-only JSONL 文件保存 Agent thread、run、event 和上下文索引。
# 这里是运行历史的事实源；Postgres 只保存结构化业务数据，不再保存 run/event。

from __future__ import annotations

import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any
from zoneinfo import ZoneInfo

from shared_types.exceptions import NotFoundError
from shared_types.schemas import (
    AgentThreadRecord,
    AnalysisRunRecord,
    ContextEntryRecord,
    RunEvent,
    ThreadContextRecord,
)
from gis_common.ids import now_utc


LOCAL_TZ = ZoneInfo("Asia/Shanghai")
SESSION_LOG_DIR_MODE = 0o755


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _utc_text(value: datetime | None = None) -> str:
    timestamp = value or now_utc()
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _make_rollout_id(timestamp: datetime | None = None) -> str:
    # UUIDv7 形状 ID。
    #
    # Python 3.11 没有标准库 uuid7；这里用毫秒时间戳 + 随机位生成同样的
    # 8-4-4-4-12 十六进制 UUID 形状，文件排序也能跟创建时间保持一致。
    current = timestamp or now_utc()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    timestamp_ms = int(current.timestamp() * 1000) & ((1 << 48) - 1)
    rand_a = secrets.randbits(12)
    rand_b = secrets.randbits(62)
    raw = timestamp_ms << 80
    raw |= 0x7 << 76
    raw |= rand_a << 64
    raw |= 0b10 << 62
    raw |= rand_b
    return str(uuid.UUID(int=raw))


class AgentSessionLogStore:
    # AgentSessionLogStore
    #
    # 每个 thread 对应一个 rollout JSONL 文件；每个 run 是同一文件中的一轮 turn。
    # 读取接口只依赖启动时和追加时维护的索引，不扫描 Postgres 旧表做 fallback。
    def __init__(self, root: Path, *, cwd: Path | None = None):
        self.root = root.resolve()
        self.cwd = (cwd or Path.cwd()).resolve()
        self._lock = RLock()
        self._thread_paths: dict[str, Path] = {}
        self._threads: dict[str, AgentThreadRecord] = {}
        self._runs: dict[str, AnalysisRunRecord] = {}
        self._thread_runs: dict[str, list[str]] = {}
        self._events: dict[str, list[RunEvent]] = {}
        self._context_entries: dict[str, dict[str, ContextEntryRecord]] = {}
        self._thread_context: dict[str, ThreadContextRecord] = {}
        self.root.mkdir(parents=True, exist_ok=True, mode=SESSION_LOG_DIR_MODE)
        self._load_existing_logs()

    @property
    def root_path(self) -> Path:
        return self.root

    def get_thread_log_path(self, thread_id: str) -> Path:
        path = self._thread_paths.get(thread_id)
        if path is None:
            raise NotFoundError("线程日志不存在。")
        return path

    def create_thread(self, thread: AgentThreadRecord) -> AgentThreadRecord:
        with self._lock:
            if thread.id in self._threads:
                return self._threads[thread.id]
            path = self._allocate_path(thread.created_at)
            thread = thread.model_copy(update={"session_log_path": str(path)})
            self._thread_paths[thread.id] = path
            self._threads[thread.id] = thread
            self._thread_runs.setdefault(thread.id, [])
            self._append_record(
                path,
                "session_meta",
                {
                    "id": self._log_id_from_path(path),
                    "threadId": thread.id,
                    "sessionId": thread.session_id,
                    "timestamp": _utc_text(thread.created_at),
                    "cwd": str(self.cwd),
                    "originator": "newmap_api",
                    "source": "api",
                    "thread": thread.model_dump(mode="json", by_alias=True),
                },
                timestamp=thread.created_at,
            )
            return thread

    def save_thread(self, thread: AgentThreadRecord) -> None:
        with self._lock:
            path = self._path_for_thread(thread.id)
            self._threads[thread.id] = thread
            self._append_event_msg(
                path,
                {
                    "type": "thread_snapshot",
                    "threadId": thread.id,
                    "sessionId": thread.session_id,
                    "thread": thread.model_dump(mode="json", by_alias=True),
                },
                timestamp=thread.updated_at,
            )

    def get_thread(self, thread_id: str) -> AgentThreadRecord:
        thread = self._threads.get(thread_id)
        if thread is None:
            raise NotFoundError("线程不存在。")
        path = self._thread_paths.get(thread_id)
        if path and not thread.session_log_path:
            thread = thread.model_copy(update={"session_log_path": str(path)})
            self._threads[thread_id] = thread
        return thread

    def update_thread(self, thread_id: str, **fields: Any) -> AgentThreadRecord:
        thread = self.get_thread(thread_id)
        update_fields = dict(fields)
        update_fields.setdefault("updated_at", now_utc())
        updated = thread.model_copy(update=update_fields)
        self.save_thread(updated)
        return updated

    def list_threads_for_session(self, session_id: str) -> list[AgentThreadRecord]:
        threads = [self.get_thread(thread.id) for thread in self._threads.values() if thread.session_id == session_id]
        return sorted(threads, key=lambda item: (item.updated_at, item.created_at), reverse=True)

    def delete_thread(self, thread_id: str) -> None:
        with self._lock:
            path = self._thread_paths.get(thread_id)
            if path is None:
                raise NotFoundError("线程不存在。")
            if not path.exists():
                raise FileNotFoundError(f"会话日志文件不存在，无法删除线程：{path}")
            path.unlink()
            run_ids = self._thread_runs.pop(thread_id, [])
            for run_id in run_ids:
                self._runs.pop(run_id, None)
                self._events.pop(run_id, None)
            self._thread_paths.pop(thread_id, None)
            self._threads.pop(thread_id, None)
            self._context_entries.pop(thread_id, None)
            self._thread_context.pop(thread_id, None)

    def save_run(self, run: AnalysisRunRecord) -> None:
        with self._lock:
            path = self._path_for_thread(run.thread_id)
            if not run.session_log_path:
                run = run.model_copy(update={"session_log_path": str(path)})
            is_new = run.id not in self._runs
            self._runs[run.id] = run
            if run.thread_id:
                ids = self._thread_runs.setdefault(run.thread_id, [])
                if run.id not in ids:
                    ids.append(run.id)
            if is_new:
                self._append_record(
                    path,
                    "turn_context",
                    {
                        "turn_id": run.id,
                        "runId": run.id,
                        "threadId": run.thread_id,
                        "sessionId": run.session_id,
                        "model": run.model_name,
                        "model_provider": run.model_provider,
                        "cwd": str(self.cwd),
                        "current_date": now_utc().date().isoformat(),
                        "timezone": str(LOCAL_TZ),
                        "summary": "",
                    },
                    timestamp=run.created_at,
                )
                self._append_response_item(
                    path,
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": run.user_query}],
                        "runId": run.id,
                        "threadId": run.thread_id,
                    },
                    timestamp=run.created_at,
                )
            self._append_event_msg(
                path,
                {
                    "type": "run_snapshot",
                    "runId": run.id,
                    "threadId": run.thread_id,
                    "status": run.status,
                    "run": run.model_dump(mode="json", by_alias=True),
                },
                timestamp=run.updated_at,
            )

    def get_run(self, run_id: str) -> AnalysisRunRecord:
        run = self._runs.get(run_id)
        if run is None:
            raise NotFoundError("分析任务不存在。")
        if run.thread_id:
            path = self._thread_paths.get(run.thread_id)
            if path and not run.session_log_path:
                run = run.model_copy(update={"session_log_path": str(path)})
                self._runs[run_id] = run
        return run

    def list_runs_for_session(self, session_id: str) -> list[AnalysisRunRecord]:
        runs = [self.get_run(run.id) for run in self._runs.values() if run.session_id == session_id]
        return sorted(runs, key=lambda item: item.updated_at, reverse=True)

    def list_runs_for_thread(self, thread_id: str, *, limit: int | None = None) -> list[AnalysisRunRecord]:
        run_ids = self._thread_runs.get(thread_id, [])
        runs = [self.get_run(run_id) for run_id in run_ids if run_id in self._runs]
        runs = sorted(runs, key=lambda item: item.updated_at, reverse=True)
        return runs[:limit] if limit is not None else runs

    def append_event(self, run_id: str, event: RunEvent) -> None:
        with self._lock:
            run = self.get_run(run_id)
            path = self._path_for_thread(run.thread_id)
            self._events.setdefault(run_id, []).append(event)
            self._append_event_msg(
                path,
                {
                    "type": event.type.value,
                    "runId": run_id,
                    "threadId": event.thread_id,
                    "event": event.model_dump(mode="json", by_alias=True),
                },
                timestamp=event.timestamp,
            )
            if event.type.value == "run.completed":
                self._append_response_item(
                    path,
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": event.message}],
                        "runId": run_id,
                        "threadId": event.thread_id,
                    },
                    timestamp=event.timestamp,
                )

    def list_events(self, run_id: str, *, limit: int | None = None) -> list[RunEvent]:
        events = list(self._events.get(run_id, []))
        return events[-limit:] if limit is not None else events

    def upsert_context_entry(self, entry: ContextEntryRecord) -> ContextEntryRecord:
        with self._lock:
            path = self._path_for_thread(entry.thread_id)
            by_id = self._context_entries.setdefault(entry.thread_id, {})
            by_id[entry.context_entry_id] = entry
            self._append_event_msg(
                path,
                {
                    "type": "context_entry",
                    "threadId": entry.thread_id,
                    "runId": entry.source_run_id,
                    "entry": entry.model_dump(mode="json", by_alias=True),
                },
                timestamp=entry.updated_at,
            )
            return entry

    def delete_context_entries_for_run(self, run_id: str) -> None:
        run = self.get_run(run_id)
        if not run.thread_id:
            return
        with self._lock:
            entries = self._context_entries.get(run.thread_id, {})
            for entry_id, entry in list(entries.items()):
                if entry.source_run_id == run_id:
                    entries.pop(entry_id, None)
            path = self._path_for_thread(run.thread_id)
            self._append_event_msg(
                path,
                {"type": "context_entries_deleted", "threadId": run.thread_id, "runId": run_id},
            )

    def list_context_entries(
        self,
        thread_id: str,
        *,
        limit: int | None = None,
        kinds: list[str] | None = None,
        exclude_source_run_id: str | None = None,
    ) -> list[ContextEntryRecord]:
        entries = list(self._context_entries.get(thread_id, {}).values())
        if kinds:
            allowed = set(kinds)
            entries = [entry for entry in entries if entry.kind in allowed]
        if exclude_source_run_id:
            entries = [entry for entry in entries if entry.source_run_id != exclude_source_run_id]
        entries.sort(key=lambda item: (item.updated_at, item.context_entry_id), reverse=True)
        return entries[:limit] if limit is not None else entries

    def search_context_entries(self, thread_id: str, *, query: str, limit: int) -> list[ContextEntryRecord]:
        normalized = " ".join(query.casefold().split())
        candidates = self.list_context_entries(thread_id, limit=max(limit * 4, limit, 12))
        if not normalized:
            return candidates[:limit]
        tokens = [token for token in normalized.split() if token]

        def score(entry: ContextEntryRecord) -> float:
            haystack = f"{entry.label}\n{entry.summary}\n{entry.search_text}".casefold()
            if normalized in haystack:
                return 1.0
            matches = sum(1 for token in tokens if token in haystack)
            return matches / max(len(tokens), 1) if matches else 0.0

        ranked = [(score(entry), entry) for entry in candidates]
        ranked = [item for item in ranked if item[0] > 0]
        ranked.sort(key=lambda item: (item[0], item[1].updated_at), reverse=True)
        return [entry for _, entry in ranked[:limit]]

    def get_thread_context(self, thread_id: str) -> ThreadContextRecord | None:
        return self._thread_context.get(thread_id)

    def save_thread_context(self, snapshot: ThreadContextRecord) -> ThreadContextRecord:
        with self._lock:
            path = self._path_for_thread(snapshot.thread_id)
            self._thread_context[snapshot.thread_id] = snapshot
            self._append_record(
                path,
                "compacted",
                {
                    "message": snapshot.summary_text,
                    "replacement_history": snapshot.payload,
                    "threadContext": snapshot.model_dump(mode="json", by_alias=True),
                },
                timestamp=snapshot.updated_at,
            )
            return snapshot

    def _load_existing_logs(self) -> None:
        for path in sorted(self.root.glob("*/*/*/rollout-*.jsonl")):
            self._load_file(path)

    def _load_file(self, path: Path) -> None:
        thread_id: str | None = None
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise ValueError(f"会话 JSONL 不是合法 UTF-8：{path}") from exc
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"会话 JSONL 解析失败：{path}:{line_number}: {exc.msg}") from exc
            payload = record.get("payload") if isinstance(record, dict) else None
            if not isinstance(payload, dict):
                raise ValueError(f"会话 JSONL 记录缺少 payload 对象：{path}:{line_number}")
            kind = record.get("type")
            if kind == "session_meta":
                thread_payload = payload.get("thread")
                if isinstance(thread_payload, dict):
                    thread = AgentThreadRecord.model_validate(thread_payload)
                    thread_id = thread.id
                    self._threads[thread.id] = thread
                    self._thread_paths[thread.id] = path
                    self._thread_runs.setdefault(thread.id, [])
                continue
            if kind == "event_msg":
                self._apply_event_msg_payload(payload)
            elif kind == "compacted":
                snapshot = payload.get("threadContext")
                if isinstance(snapshot, dict):
                    context = ThreadContextRecord.model_validate(snapshot)
                    self._thread_context[context.thread_id] = context
            elif kind not in {"turn_context", "response_item"}:
                raise ValueError(f"会话 JSONL 记录类型未知：{path}:{line_number}: {kind}")
            if thread_id:
                self._thread_paths.setdefault(thread_id, path)

    def _apply_event_msg_payload(self, payload: dict[str, Any]) -> None:
        message_type = payload.get("type")
        if message_type == "thread_snapshot" and isinstance(payload.get("thread"), dict):
            thread = AgentThreadRecord.model_validate(payload["thread"])
            self._threads[thread.id] = thread
            self._thread_runs.setdefault(thread.id, [])
            return
        if message_type == "run_snapshot" and isinstance(payload.get("run"), dict):
            run = AnalysisRunRecord.model_validate(payload["run"])
            self._runs[run.id] = run
            if run.thread_id:
                ids = self._thread_runs.setdefault(run.thread_id, [])
                if run.id not in ids:
                    ids.append(run.id)
            return
        if message_type == "context_entry" and isinstance(payload.get("entry"), dict):
            entry = ContextEntryRecord.model_validate(payload["entry"])
            self._context_entries.setdefault(entry.thread_id, {})[entry.context_entry_id] = entry
            return
        if message_type == "context_entries_deleted":
            thread_id = payload.get("threadId")
            run_id = payload.get("runId")
            if isinstance(thread_id, str) and isinstance(run_id, str):
                entries = self._context_entries.get(thread_id, {})
                for entry_id, entry in list(entries.items()):
                    if entry.source_run_id == run_id:
                        entries.pop(entry_id, None)
            return
        if isinstance(payload.get("event"), dict):
            event = RunEvent.model_validate(payload["event"])
            self._events.setdefault(event.run_id, []).append(event)

    def _allocate_path(self, timestamp: datetime) -> Path:
        local = timestamp.astimezone(LOCAL_TZ)
        directory = self.root / f"{local:%Y}" / f"{local:%m}" / f"{local:%d}"
        directory.mkdir(parents=True, exist_ok=True, mode=SESSION_LOG_DIR_MODE)
        stem_time = local.strftime("%Y-%m-%dT%H-%M-%S")
        for _ in range(16):
            path = directory / f"rollout-{stem_time}-{_make_rollout_id(timestamp)}.jsonl"
            if not path.exists():
                return path
        raise RuntimeError("无法分配唯一会话日志文件名。")

    @staticmethod
    def _log_id_from_path(path: Path) -> str:
        stem = path.stem.removeprefix("rollout-")
        return stem[20:] if len(stem) > 20 else stem

    def _path_for_thread(self, thread_id: str | None) -> Path:
        if not thread_id:
            raise NotFoundError("运行未绑定线程。")
        path = self._thread_paths.get(thread_id)
        if path is None:
            raise NotFoundError("线程日志不存在。")
        return path

    def _append_response_item(self, path: Path, payload: dict[str, Any], *, timestamp: datetime | None = None) -> None:
        self._append_record(path, "response_item", payload, timestamp=timestamp)

    def _append_event_msg(self, path: Path, payload: dict[str, Any], *, timestamp: datetime | None = None) -> None:
        self._append_record(path, "event_msg", payload, timestamp=timestamp)

    def _append_record(self, path: Path, kind: str, payload: dict[str, Any], *, timestamp: datetime | None = None) -> None:
        record = {
            "timestamp": _utc_text(timestamp),
            "type": kind,
            "payload": payload,
        }
        path.parent.mkdir(parents=True, exist_ok=True, mode=SESSION_LOG_DIR_MODE)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, default=_json_default, separators=(",", ":")))
            handle.write("\n")
        try:
            os.chmod(path, 0o644)
        except OSError as exc:
            raise RuntimeError(f"会话日志权限设置失败：{path}: {exc}") from exc
