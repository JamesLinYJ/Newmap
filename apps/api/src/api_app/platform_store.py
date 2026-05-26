# +-------------------------------------------------------------------------
#
#   地理智能平台 - 平台持久化门面
#
#   文件:       platform_store.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
# 模块职责
#
# 统一负责结构化业务数据与 Agent 会话日志的读写边界。
from __future__ import annotations

import asyncio
import json
import secrets
import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from shared_types.exceptions import NotFoundError

from shared_types.schemas import (
    AgentRuntimeConfig,
    AgentStateModel,
    AgentThreadRecord,
    AnalysisRunRecord,
    ArtifactRef,
    ContextEntryRecord,
    ContextReference,
    RunEvent,
    RunLifecycle,
    SessionRecord,
    ThreadContextRecord,
    WeatherDatasetRecord,
    WeatherJobRecord,
)
from gis_common.ids import make_id, now_utc

from .artifact_store import ArtifactExportStore
from .postgres import connect_postgres
from .session_log_store import AgentSessionLogStore
from agent_core.supervisor_config import build_default_runtime_config, normalize_runtime_config


class PostgresPlatformStore:
    # PostgresPlatformStore
    #
    # 这是平台业务态的门面。
    # Agent 会话历史由 JSONL 会话日志负责；Postgres 只保存 session、
    # artifact、weather、runtime config 等结构化业务数据。
    def __init__(
        self,
        database_url: str,
        *,
        artifact_store: ArtifactExportStore,
        session_log_store: AgentSessionLogStore | None = None,
    ):
        self.database_url = database_url
        self.artifact_store = artifact_store
        self.session_log_store = session_log_store or AgentSessionLogStore(
            artifact_store.runtime_root / "sessions",
        )
        self._subscribers: dict[str, list[asyncio.Queue[RunEvent]]] = {}

    def ensure_schema(self) -> None:
        # schema 初始化。
        #
        # 当前项目还未发版，这里不维护“旧版本库结构兼容”分支，
        # 只保证当前主 schema 可以幂等创建。
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_sessions (
                    session_id TEXT PRIMARY KEY,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    payload_json JSONB NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    artifact_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    geojson_relative_path TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_runtime_config (
                    config_key TEXT PRIMARY KEY,
                    updated_at TIMESTAMPTZ NOT NULL,
                    payload_json JSONB NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_weather_datasets (
                    dataset_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
                    thread_id TEXT,
                    filename TEXT NOT NULL,
                    status TEXT NOT NULL,
                    storage_relative_path TEXT NOT NULL,
                    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_weather_jobs (
                    job_id TEXT PRIMARY KEY,
                    dataset_id TEXT NOT NULL REFERENCES platform_weather_datasets(dataset_id) ON DELETE CASCADE,
                    job_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    error TEXT,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_platform_artifacts_run_id ON platform_artifacts(run_id)")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_weather_datasets_session_updated ON platform_weather_datasets(session_id, updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_weather_jobs_status_updated ON platform_weather_jobs(status, updated_at)"
            )
            cur.execute(
                """
                INSERT INTO platform_runtime_config (config_key, updated_at, payload_json)
                VALUES (%s, %s, %s::jsonb)
                ON CONFLICT (config_key) DO NOTHING
                """,
                ("default", now_utc(), json.dumps(normalize_runtime_config(build_default_runtime_config()).model_dump(mode="json", by_alias=True), ensure_ascii=False)),
            )

    def create_session(self) -> SessionRecord:
        timestamp = now_utc()
        session = SessionRecord(id=make_id("session"), created_at=timestamp, share_token=secrets.token_urlsafe(10))
        self.save_session(session)
        return session

    def save_session(self, session: SessionRecord) -> None:
        payload = session.model_dump(mode="json", by_alias=True)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_sessions (session_id, created_at, updated_at, payload_json)
                VALUES (%s, %s, %s, %s::jsonb)
                ON CONFLICT (session_id) DO UPDATE SET
                    updated_at = EXCLUDED.updated_at,
                    payload_json = EXCLUDED.payload_json
                """,
                (session.id, session.created_at, now_utc(), json.dumps(payload, ensure_ascii=False)),
            )

    def get_session(self, session_id: str) -> SessionRecord:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload_json FROM platform_sessions WHERE session_id = %s", (session_id,))
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("会话不存在。")
        return SessionRecord.model_validate(row[0])

    def update_session(self, session_id: str, **fields: Any) -> SessionRecord:
        session = self.get_session(session_id)
        updated = session.model_copy(update=fields)
        self.save_session(updated)
        return updated

    def list_runs_for_session(self, session_id: str) -> list[AnalysisRunRecord]:
        self.get_session(session_id)
        return self.session_log_store.list_runs_for_session(session_id)

    def create_thread(self, session_id: str, *, title: str | None = None) -> AgentThreadRecord:
        self.get_session(session_id)
        timestamp = now_utc()
        thread = AgentThreadRecord(
            id=make_id("thread"),
            session_id=session_id,
            title=title or "GIS 智能分析线程",
            created_at=timestamp,
            updated_at=timestamp,
        )
        thread = self.session_log_store.create_thread(thread)
        self.update_session(session_id, latest_thread_id=thread.id)
        return thread

    def save_thread(self, thread: AgentThreadRecord) -> None:
        self.session_log_store.save_thread(thread)

    def get_thread(self, thread_id: str) -> AgentThreadRecord:
        return self.session_log_store.get_thread(thread_id)

    def get_or_create_thread_for_session(self, session_id: str, *, title: str | None = None) -> AgentThreadRecord:
        session = self.get_session(session_id)
        if session.latest_thread_id:
            try:
                return self.get_thread(session.latest_thread_id)
            except NotFoundError:
                return self.create_thread(session_id, title=title)
        return self.create_thread(session_id, title=title)

    def update_thread(self, thread_id: str, **fields: Any) -> AgentThreadRecord:
        return self.session_log_store.update_thread(thread_id, **fields)

    def list_threads_for_session(self, session_id: str) -> list[AgentThreadRecord]:
        # 线程列表是“历史对话”的主索引，而不只是 run 的附属信息。
        #
        # 这里返回每个 thread 的最新快照，供前端恢复最近会话、
        # 展示历史摘要或后续扩展多任务入口时复用。
        self.get_session(session_id)
        return self.session_log_store.list_threads_for_session(session_id)

    def delete_thread(self, thread_id: str) -> None:
        # 线程删除
        #
        # 删除 thread 时要一并清理：
        # 1. 关联 JSONL run / event / context 记录。
        # 2. runtime/artifacts 下的导出 GeoJSON。
        # 3. session.latest_thread_id / latest_run_id 指针。
        thread = self.get_thread(thread_id)
        runs = self.list_runs_for_thread(thread_id)
        artifact_ids = list(dict.fromkeys(artifact.artifact_id for run in runs for artifact in run.state.artifacts))
        weather_datasets = self._list_weather_datasets_for_thread_only(thread_id)

        for artifact_id in artifact_ids:
            try:
                self.artifact_store.delete(self._artifact_relative_path(artifact_id))
            except NotFoundError:
                continue
        for dataset in weather_datasets:
            self._delete_weather_dataset_files(dataset)

        with self.transaction() as conn, conn.cursor() as cur:
            if artifact_ids:
                cur.execute("DELETE FROM platform_artifacts WHERE artifact_id = ANY(%s)", (artifact_ids,))
            if weather_datasets:
                dataset_ids = [dataset.dataset_id for dataset in weather_datasets]
                cur.execute("DELETE FROM platform_weather_datasets WHERE dataset_id = ANY(%s)", (dataset_ids,))
        self.session_log_store.delete_thread(thread_id)

        self._refresh_session_latest_pointers(thread.session_id)

    def create_run(
        self,
        session_id: str,
        user_query: str,
        *,
        thread_id: str | None = None,
        model_provider: str = "openai_compatible",
        model_name: str | None = None,
    ) -> AnalysisRunRecord:
        # 创建运行记录时同步写入最小初始 state。
        #
        # 这样后续无论是 SDK live supervisor 还是离线诊断 helper，
        # 都是在同一份 AgentStateModel 上增量写回。
        timestamp = now_utc()
        state = AgentStateModel(
            session_id=session_id,
            thread_id=thread_id,
            user_query=user_query,
            model_provider=model_provider,
            model_name=model_name,
            run_lifecycle=RunLifecycle(status="created", reason="run_created", updated_at=timestamp),
        )
        run = AnalysisRunRecord(
            id=make_id("run"),
            thread_id=thread_id,
            session_id=session_id,
            user_query=user_query,
            model_provider=model_provider,
            model_name=model_name,
            created_at=timestamp,
            updated_at=timestamp,
            status="queued",
            state=state,
        )
        self.save_run(run)
        run = self.get_run(run.id)
        session_fields: dict[str, Any] = {"latest_run_id": run.id}
        if thread_id:
            session_fields["latest_thread_id"] = thread_id
            self.update_thread(thread_id, latest_run_id=run.id)
        self.update_session(session_id, **session_fields)
        return run

    def mark_run_running(self, run_id: str) -> AnalysisRunRecord:
        run = self.get_run(run_id)
        timestamp = now_utc()
        state = run.state.model_copy(update={"run_lifecycle": RunLifecycle(status="running", reason="runtime_started", updated_at=timestamp)})
        updated = run.model_copy(update={"status": "running", "state": state, "updated_at": timestamp})
        self.save_run(updated)
        return updated

    def get_run(self, run_id: str) -> AnalysisRunRecord:
        return self.session_log_store.get_run(run_id)

    def save_run(self, run: AnalysisRunRecord) -> None:
        # 保存 run 同时维护 thread 的 latest_run_id。
        #
        # thread 视角需要能快速恢复最近一次运行，因此这里把关联更新放在一起，
        # 避免调用方忘记补写 thread 索引。
        self.session_log_store.save_run(run)
        if run.thread_id:
            self.update_thread(run.thread_id, **self._build_thread_history_snapshot(run))

    def complete_run(self, run_id: str, state: AgentStateModel) -> AnalysisRunRecord:
        # 根据最终 state 反推用户可见 run 状态。
        #
        # 这里故意不让调用方手工传 completed/failed/waiting_approval，
        # 统一由 approvals / errors / clarification 这些事实字段决定最终语义。
        run = self.get_run(run_id)
        status = "completed"
        lifecycle_status = "completed"
        lifecycle_reason = "run_completed"
        if state.errors:
            status = "failed"
            lifecycle_status = "failed"
            lifecycle_reason = "run_failed"
        elif any(item.status == "pending" for item in state.approvals):
            status = "waiting_approval"
            lifecycle_status = "waiting_approval"
            lifecycle_reason = "approval_required"
        elif state.clarification and state.clarification.selected_option_id is None:
            status = "clarification_needed"
            lifecycle_status = "waiting_clarification"
            lifecycle_reason = "clarification_required"
        elif state.parsed_intent and state.parsed_intent.clarification_required:
            status = "clarification_needed"
            lifecycle_status = "waiting_clarification"
            lifecycle_reason = "clarification_required"
        timestamp = now_utc()
        state = state.model_copy(update={"run_lifecycle": RunLifecycle(status=lifecycle_status, reason=lifecycle_reason, updated_at=timestamp)})
        updated = run.model_copy(update={"state": state, "status": status, "updated_at": timestamp})
        self.save_run(updated)
        if updated.thread_id and status in {"completed", "waiting_approval", "clarification_needed"}:
            self.index_run_context(updated.id)
        return updated

    def update_run_state(self, run_id: str, *, status: str | None = None, **fields: Any) -> AnalysisRunRecord:
        # 增量写回运行态。
        #
        # runtime 会频繁更新 todos、loop、toolResults 等细粒度字段；
        # 这里统一走 Pydantic copy，避免调用方手工拼接整份 state。
        run = self.get_run(run_id)
        updated_state = run.state.model_copy(update=fields)
        update_fields: dict[str, Any] = {"state": updated_state, "updated_at": now_utc()}
        if status is not None:
            update_fields["status"] = status
            lifecycle_status = "waiting_clarification" if status == "clarification_needed" else status
            updated_state = updated_state.model_copy(update={"run_lifecycle": RunLifecycle(status=lifecycle_status, reason=f"status:{status}", updated_at=update_fields["updated_at"])})
            update_fields["state"] = updated_state
        updated_run = run.model_copy(update=update_fields)
        self.save_run(updated_run)
        return updated_run

    def append_event(self, run_id: str, event: RunEvent) -> None:
        # 事件既写入 JSONL 会话日志，也广播给当前 SSE 订阅者。
        #
        # JSONL 负责历史回放，内存 queue 负责实时体验；
        # 两边都写，前端刷新和实时流才能讲同一个故事。
        self.session_log_store.append_event(run_id, event)
        run = self._get_run_or_none(run_id)
        if run and run.thread_id:
            self.update_thread(
                run.thread_id,
                history_preview=self._build_thread_history_preview(run),
                updated_at=now_utc(),
            )
        for queue in self._subscribers.get(run_id, []):
            queue.put_nowait(event)

    def list_events(self, run_id: str, *, limit: int | None = None) -> list[RunEvent]:
        return self.session_log_store.list_events(run_id, limit=limit)

    def list_runs_for_thread(self, thread_id: str, *, limit: int | None = None) -> list[AnalysisRunRecord]:
        return self.session_log_store.list_runs_for_thread(thread_id, limit=limit)

    def upsert_context_entry(self, entry: ContextEntryRecord) -> ContextEntryRecord:
        # 上下文条目是 Agent prompt 可见事实的写入边界。
        #
        # 这里不从 run/event 做隐式补全；调用方必须提交已经归一化的可引用事实。
        return self.session_log_store.upsert_context_entry(entry)

    def list_context_entries(
        self,
        thread_id: str,
        *,
        limit: int | None = None,
        kinds: list[str] | None = None,
        exclude_source_run_id: str | None = None,
    ) -> list[ContextEntryRecord]:
        return self.session_log_store.list_context_entries(
            thread_id,
            limit=limit,
            kinds=kinds,
            exclude_source_run_id=exclude_source_run_id,
        )

    def search_context_entries(self, thread_id: str, *, query: str, limit: int) -> list[ContextEntryRecord]:
        # 上下文检索只查 JSONL context index。
        #
        # 没有索引条目就返回空；不回头扫描旧 run/event，避免 prompt 事实源漂移。
        return self.session_log_store.search_context_entries(thread_id, query=query, limit=limit)

    def get_thread_context(self, thread_id: str) -> ThreadContextRecord | None:
        return self.session_log_store.get_thread_context(thread_id)

    def save_thread_context(self, snapshot: ThreadContextRecord) -> ThreadContextRecord:
        return self.session_log_store.save_thread_context(snapshot)

    def delete_context_entries_for_run(self, run_id: str) -> None:
        self.session_log_store.delete_context_entries_for_run(run_id)

    def index_run_context(self, run_id: str) -> list[ContextEntryRecord]:
        run = self.get_run(run_id)
        if not run.thread_id:
            return []
        self.delete_context_entries_for_run(run_id)
        entries = self._build_context_entries_for_run(run)
        for entry in entries:
            self.upsert_context_entry(entry)
        self.refresh_thread_context(run.thread_id)
        return entries

    def index_layer_context(self, *, session_id: str, thread_id: str | None, layer: Any) -> ContextEntryRecord | None:
        if not thread_id:
            return None
        timestamp = now_utc()
        layer_key = str(getattr(layer, "layer_key", "") or "")
        if not layer_key:
            return None
        reference = ContextReference(
            reference_id=f"layer:{layer_key}",
            kind="layer",
            label=str(getattr(layer, "name", None) or layer_key),
            description=str(getattr(layer, "description", None) or "当前线程上传图层。"),
            layer_key=layer_key,
            confidence=1.0,
            usable_as=["layer_key", "collection"],
            metadata=layer.model_dump(mode="json", by_alias=True) if hasattr(layer, "model_dump") else {},
        )
        entry = ContextEntryRecord(
            context_entry_id=f"context_layer_{thread_id}_{layer_key}",
            session_id=session_id,
            thread_id=thread_id,
            kind="layer",
            label=reference.label,
            summary=f"上传图层：{reference.label}，layerKey={layer_key}",
            reference=reference,
            search_text=f"{reference.label} {layer_key}",
            created_at=timestamp,
            updated_at=timestamp,
        )
        saved = self.upsert_context_entry(entry)
        self.refresh_thread_context(thread_id)
        return saved

    def refresh_thread_context(self, thread_id: str) -> ThreadContextRecord | None:
        thread = self.get_thread(thread_id)
        entries = self.list_context_entries(thread_id, limit=40)
        entry_count = len(self.list_context_entries(thread_id))
        ordered = list(reversed(entries[:12]))
        summary_text = "\n".join(f"- [{entry.kind}] {entry.label}: {entry.summary}" for entry in ordered)
        snapshot = ThreadContextRecord(
            thread_id=thread_id,
            session_id=thread.session_id,
            summary_text=summary_text,
            entry_count=entry_count,
            payload={
                "latestEntryIds": [entry.context_entry_id for entry in entries[:12]],
                "kinds": sorted({entry.kind for entry in entries}),
            },
            updated_at=now_utc(),
        )
        return self.save_thread_context(snapshot)

    def subscribe(self, run_id: str) -> asyncio.Queue[RunEvent]:
        queue: asyncio.Queue[RunEvent] = asyncio.Queue()
        self._subscribers.setdefault(run_id, []).append(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[RunEvent]) -> None:
        subscribers = self._subscribers.get(run_id, [])
        if queue in subscribers:
            subscribers.remove(queue)
        if not subscribers:
            self._subscribers.pop(run_id, None)

    def get_runtime_config(self) -> AgentRuntimeConfig:
        # runtime config 以数据库为唯一事实源。
        #
        # 代码中的默认配置只用于首次 seed；
        # 一旦数据库里已有记录，运行时和调试页都必须读取同一份配置。
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload_json FROM platform_runtime_config WHERE config_key = %s", ("default",))
            row = cur.fetchone()
        if row is None:
            config = normalize_runtime_config(build_default_runtime_config())
            self.save_runtime_config(config)
            return config
        return normalize_runtime_config(row[0])

    def save_runtime_config(self, config: AgentRuntimeConfig) -> AgentRuntimeConfig:
        # 保存前做规范化，避免 debug 页写入的局部配置把结构打散。
        normalized = normalize_runtime_config(config)
        payload = normalized.model_dump(mode="json", by_alias=True)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_runtime_config (config_key, updated_at, payload_json)
                VALUES (%s, %s, %s::jsonb)
                ON CONFLICT (config_key) DO UPDATE SET
                    updated_at = EXCLUDED.updated_at,
                    payload_json = EXCLUDED.payload_json
                """,
                ("default", now_utc(), json.dumps(payload, ensure_ascii=False)),
            )
        return normalized

    def save_geojson_artifact(
        self,
        *,
        run_id: str,
        artifact_id: str,
        name: str,
        collection: dict[str, Any],
        metadata: dict[str, Any],
        is_intermediate: bool = False,
    ) -> ArtifactRef:
        # artifact 写入分两层：
        # 1. GeoJSON 实体落到 runtime 目录。
        # 2. 轻量引用与 metadata 落到平台表。
        #
        # 这样地图、下载、发布都围绕 artifact_id 这一主键工作。
        geojson_path = self.artifact_store.export_geojson(run_id=run_id, artifact_id=artifact_id, collection=collection)
        relative_path = str(geojson_path.relative_to(self.artifact_store.runtime_root))
        artifact = ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type="geojson",
            name=name,
            uri=f"/api/v1/results/{artifact_id}/geojson",
            metadata=metadata,
            is_intermediate=is_intermediate,
        )
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_artifacts (
                    artifact_id, run_id, artifact_type, name, uri, metadata_json, geojson_relative_path
                )
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT (artifact_id) DO UPDATE SET
                    run_id = EXCLUDED.run_id,
                    artifact_type = EXCLUDED.artifact_type,
                    name = EXCLUDED.name,
                    uri = EXCLUDED.uri,
                    metadata_json = EXCLUDED.metadata_json,
                    geojson_relative_path = EXCLUDED.geojson_relative_path
                """,
                (
                    artifact.artifact_id,
                    artifact.run_id,
                    artifact.artifact_type,
                    artifact.name,
                    artifact.uri,
                    json.dumps(metadata, ensure_ascii=False),
                    relative_path,
                ),
            )
        return artifact

    def save_file_artifact(
        self,
        *,
        run_id: str,
        artifact_id: str,
        artifact_type: str,
        name: str,
        source_path: str,
        suffix: str,
        metadata: dict[str, Any],
    ) -> ArtifactRef:
        # 通用文件 artifact 写入。
        #
        # GeoJSON 仍走 save_geojson_artifact；PNG 热力图等派生产物只登记文件路径
        # 和 metadata，由专用结果接口读取，不进入 GeoJSON 集合加载路径。
        output_path = self.artifact_store.export_file(
            run_id=run_id,
            artifact_id=artifact_id,
            source_path=Path(source_path),
            suffix=suffix,
        )
        relative_path = str(output_path.relative_to(self.artifact_store.runtime_root))
        artifact = ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type=artifact_type,
            name=name,
            uri=f"/api/v1/results/{artifact_id}/file",
            metadata=metadata,
        )
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_artifacts (
                    artifact_id, run_id, artifact_type, name, uri, metadata_json, geojson_relative_path
                )
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT (artifact_id) DO UPDATE SET
                    run_id = EXCLUDED.run_id,
                    artifact_type = EXCLUDED.artifact_type,
                    name = EXCLUDED.name,
                    uri = EXCLUDED.uri,
                    metadata_json = EXCLUDED.metadata_json,
                    geojson_relative_path = EXCLUDED.geojson_relative_path
                """,
                (
                    artifact.artifact_id,
                    artifact.run_id,
                    artifact.artifact_type,
                    artifact.name,
                    artifact.uri,
                    json.dumps(metadata, ensure_ascii=False),
                    relative_path,
                ),
            )
        return artifact

    def get_artifact(self, artifact_id: str) -> ArtifactRef:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT run_id, artifact_type, name, uri, metadata_json
                FROM platform_artifacts
                WHERE artifact_id = %s
                """,
                (artifact_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("结果对象不存在。")
        return ArtifactRef(
            artifact_id=artifact_id,
            run_id=row[0],
            artifact_type=row[1],
            name=row[2],
            uri=row[3],
            metadata=row[4] or {},
        )

    def get_artifact_collection(self, artifact_id: str) -> dict[str, Any]:
        artifact = self.get_artifact(artifact_id)
        if artifact.artifact_type != "geojson":
            raise NotFoundError("该结果对象不是 GeoJSON。")
        return self.artifact_store.load_geojson(self._artifact_relative_path(artifact_id))

    def get_artifact_geojson_path(self, artifact_id: str):
        artifact = self.get_artifact(artifact_id)
        if artifact.artifact_type != "geojson":
            raise NotFoundError("该结果对象不是 GeoJSON。")
        return self.artifact_store.resolve(self._artifact_relative_path(artifact_id))

    def get_artifact_file_path(self, artifact_id: str):
        return self.artifact_store.open_file(self._artifact_relative_path(artifact_id))

    def get_artifact_metadata(self, artifact_id: str) -> dict[str, Any]:
        return self.get_artifact(artifact_id).metadata

    def update_artifact_metadata(self, artifact_id: str, **fields: Any) -> ArtifactRef:
        # metadata 更新后要同步回 run.state.artifacts。
        #
        # 前端详情面板和历史恢复优先看 run state，
        # 所以不能只改 artifact 表而不回灌运行态快照。
        artifact = self.get_artifact(artifact_id)
        next_metadata = {**artifact.metadata, **fields}
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                UPDATE platform_artifacts
                SET metadata_json = %s::jsonb
                WHERE artifact_id = %s
                """,
                (json.dumps(next_metadata, ensure_ascii=False), artifact_id),
            )

        run = self.get_run(artifact.run_id)
        updated_artifacts = [
            item if item.artifact_id != artifact_id else item.model_copy(update={"metadata": next_metadata})
            for item in run.state.artifacts
        ]
        updated_state = run.state.model_copy(update={"artifacts": updated_artifacts})
        self.save_run(run.model_copy(update={"state": updated_state, "updated_at": now_utc()}))

        return artifact.model_copy(update={"metadata": next_metadata})

    def list_artifacts(self, run_id: str) -> list[ArtifactRef]:
        run = self.get_run(run_id)
        return [ArtifactRef.model_validate(item) for item in run.state.artifacts]

    def add_artifact_to_run(self, run_id: str, artifact: ArtifactRef) -> AnalysisRunRecord:
        # 运行态里的 artifacts 保持去重追加，防止同一结果被重复记录多次。
        run = self.get_run(run_id)
        artifacts = [ArtifactRef.model_validate(item) for item in run.state.artifacts]
        if not any(item.artifact_id == artifact.artifact_id for item in artifacts):
            artifacts.append(artifact)
        updated_state = run.state.model_copy(update={"artifacts": artifacts})
        updated_run = run.model_copy(update={"state": updated_state, "updated_at": now_utc()})
        self.save_run(updated_run)
        return updated_run

    def _artifact_relative_path(self, artifact_id: str) -> str:
        # artifact 表保存的是相对路径，真正解析绝对路径统一交给 artifact store。
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT geojson_relative_path FROM platform_artifacts WHERE artifact_id = %s",
                (artifact_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("结果对象不存在。")
        return str(row[0])

    def _list_weather_datasets_for_thread_only(self, thread_id: str) -> list[WeatherDatasetRecord]:
        # Thread 删除的清理范围只包含显式绑定到该 thread 的气象数据。
        #
        # session 级共享 dataset 的 thread_id 为 NULL，仍可被其它线程使用，
        # 不能被某一次 thread 删除顺手清掉。
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT dataset_id, session_id, thread_id, filename, status, storage_relative_path, metadata_json, created_at, updated_at
                FROM platform_weather_datasets
                WHERE thread_id = %s
                """,
                (thread_id,),
            )
            rows = cur.fetchall()
        return [
            WeatherDatasetRecord(
                dataset_id=row[0],
                session_id=row[1],
                thread_id=row[2],
                filename=row[3],
                status=row[4],
                storage_relative_path=row[5],
                metadata=row[6] or {},
                created_at=row[7],
                updated_at=row[8],
            )
            for row in rows
        ]

    def _delete_weather_dataset_files(self, dataset: WeatherDatasetRecord) -> None:
        # 气象原始文件和派生结果放在 runtime/weather 下。
        #
        # 删除是显式 thread 删除的一部分，不在 API 启动时做破坏性清理。
        raw_path = self.resolve_runtime_path(dataset.storage_relative_path)
        for path in (raw_path.parent, self.artifact_store.runtime_root / "weather" / "derived" / dataset.dataset_id):
            if path.exists():
                shutil.rmtree(path)

    def create_weather_dataset(
        self,
        *,
        dataset_id: str,
        session_id: str,
        thread_id: str | None = None,
        filename: str,
        storage_relative_path: str,
        metadata: dict[str, Any] | None = None,
    ) -> WeatherDatasetRecord:
        # 气象数据集登记。
        #
        # 原始文件已经由 API 流式写入 runtime；这里仅登记路径。
        # 解析采用懒触发：用户开始分析、Agent 检查或渲染时再推进 metadata。
        self.get_session(session_id)
        timestamp = now_utc()
        record = WeatherDatasetRecord(
            dataset_id=dataset_id,
            session_id=session_id,
            thread_id=thread_id,
            filename=filename,
            status="uploaded",
            storage_relative_path=storage_relative_path,
            metadata=metadata or {},
            created_at=timestamp,
            updated_at=timestamp,
        )
        self.save_weather_dataset(record)
        return record

    def save_weather_dataset(self, record: WeatherDatasetRecord) -> None:
        payload_metadata = json.dumps(record.metadata, ensure_ascii=False)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_weather_datasets (
                    dataset_id, session_id, thread_id, filename, status, storage_relative_path, metadata_json, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                ON CONFLICT (dataset_id) DO UPDATE SET
                    filename = EXCLUDED.filename,
                    status = EXCLUDED.status,
                    storage_relative_path = EXCLUDED.storage_relative_path,
                    metadata_json = EXCLUDED.metadata_json,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    record.dataset_id,
                    record.session_id,
                    record.thread_id,
                    record.filename,
                    record.status,
                    record.storage_relative_path,
                    payload_metadata,
                    record.created_at,
                    record.updated_at,
                ),
            )

    def get_weather_dataset(self, dataset_id: str) -> WeatherDatasetRecord:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT dataset_id, session_id, thread_id, filename, status, storage_relative_path, metadata_json, created_at, updated_at
                FROM platform_weather_datasets
                WHERE dataset_id = %s
                """,
                (dataset_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("气象数据集不存在。")
        return WeatherDatasetRecord(
            dataset_id=row[0],
            session_id=row[1],
            thread_id=row[2],
            filename=row[3],
            status=row[4],
            storage_relative_path=row[5],
            metadata=row[6] or {},
            created_at=row[7],
            updated_at=row[8],
        )

    def list_weather_datasets(self, *, session_id: str | None = None, thread_id: str | None = None) -> list[WeatherDatasetRecord]:
        conditions: list[str] = []
        params: list[Any] = []
        if session_id:
            self.get_session(session_id)
            conditions.append("session_id = %s")
            params.append(session_id)
        if thread_id:
            conditions.append("(thread_id = %s OR thread_id IS NULL)")
            params.append(thread_id)
        where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT dataset_id, session_id, thread_id, filename, status, storage_relative_path, metadata_json, created_at, updated_at
                FROM platform_weather_datasets
                {where_sql}
                ORDER BY updated_at DESC, created_at DESC
                """,
                tuple(params),
            )
            rows = cur.fetchall()
        return [
            WeatherDatasetRecord(
                dataset_id=row[0],
                session_id=row[1],
                thread_id=row[2],
                filename=row[3],
                status=row[4],
                storage_relative_path=row[5],
                metadata=row[6] or {},
                created_at=row[7],
                updated_at=row[8],
            )
            for row in rows
        ]

    def update_weather_dataset(self, dataset_id: str, *, status: str | None = None, metadata: dict[str, Any] | None = None) -> WeatherDatasetRecord:
        current = self.get_weather_dataset(dataset_id)
        updated = current.model_copy(
            update={
                "status": status or current.status,
                "metadata": metadata if metadata is not None else current.metadata,
                "updated_at": now_utc(),
            }
        )
        self.save_weather_dataset(updated)
        return updated

    def ensure_weather_dataset_parsed(self, dataset_id: str, weather_service: Any, *, job_id: str | None = None) -> WeatherDatasetRecord:
        # 气象数据集懒解析状态机。
        #
        # 这是 dataset 状态推进的单一入口：上传只产生 uploaded；API、worker 和
        # Agent 工具真正消费数据时统一经这里推进 running / completed / failed。
        dataset = self.get_weather_dataset(dataset_id)
        if dataset.status == "completed":
            return dataset
        path = self.resolve_runtime_path(dataset.storage_relative_path)
        metadata = {**dataset.metadata}
        if job_id:
            metadata["parseJobId"] = job_id
        running = self.update_weather_dataset(dataset.dataset_id, status="running", metadata=metadata)
        try:
            parsed_metadata = weather_service.inspect(path, filename=running.filename)
        except Exception as exc:
            message = str(exc).strip() or f"气象文件解析失败：{exc.__class__.__name__}"
            self.update_weather_dataset(running.dataset_id, status="failed", metadata={**running.metadata, "error": message})
            if job_id:
                self.update_weather_job(job_id, status="failed", result={}, error=message)
            raise ValueError(message) from exc

        merged_metadata = {**running.metadata, **parsed_metadata}
        parsed = self.update_weather_dataset(running.dataset_id, status="completed", metadata=merged_metadata)
        if job_id:
            self.update_weather_job(job_id, status="completed", result={"metadata": merged_metadata}, error=None)
        return parsed

    def create_weather_job(
        self,
        *,
        dataset_id: str,
        job_type: str = "parse",
        payload: dict[str, Any] | None = None,
    ) -> WeatherJobRecord:
        self.get_weather_dataset(dataset_id)
        timestamp = now_utc()
        record = WeatherJobRecord(
            job_id=make_id("weather_job"),
            dataset_id=dataset_id,
            job_type=job_type,
            status="queued",
            payload=payload or {},
            result={},
            error=None,
            created_at=timestamp,
            updated_at=timestamp,
        )
        self.save_weather_job(record)
        return record

    def save_weather_job(self, record: WeatherJobRecord) -> None:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_weather_jobs (
                    job_id, dataset_id, job_type, status, payload_json, result_json, error, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
                ON CONFLICT (job_id) DO UPDATE SET
                    status = EXCLUDED.status,
                    payload_json = EXCLUDED.payload_json,
                    result_json = EXCLUDED.result_json,
                    error = EXCLUDED.error,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    record.job_id,
                    record.dataset_id,
                    record.job_type,
                    record.status,
                    json.dumps(record.payload, ensure_ascii=False),
                    json.dumps(record.result, ensure_ascii=False),
                    record.error,
                    record.created_at,
                    record.updated_at,
                ),
            )

    def get_weather_job(self, job_id: str) -> WeatherJobRecord:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT job_id, dataset_id, job_type, status, payload_json, result_json, error, created_at, updated_at
                FROM platform_weather_jobs
                WHERE job_id = %s
                """,
                (job_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("气象解析任务不存在。")
        return WeatherJobRecord(
            job_id=row[0],
            dataset_id=row[1],
            job_type=row[2],
            status=row[3],
            payload=row[4] or {},
            result=row[5] or {},
            error=row[6],
            created_at=row[7],
            updated_at=row[8],
        )

    def update_weather_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> WeatherJobRecord:
        current = self.get_weather_job(job_id)
        updated = current.model_copy(
            update={
                "status": status or current.status,
                "result": result if result is not None else current.result,
                "error": error,
                "updated_at": now_utc(),
            }
        )
        self.save_weather_job(updated)
        return updated

    def claim_next_weather_job(self) -> WeatherJobRecord | None:
        # worker 任务领取。
        #
        # 使用 FOR UPDATE SKIP LOCKED 避免多个 worker 同时解析同一个上传文件。
        timestamp = now_utc()
        with self.transaction() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT job_id
                FROM platform_weather_jobs
                WHERE status = 'queued'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """
            )
            row = cur.fetchone()
            if row is None:
                return None
            cur.execute(
                """
                UPDATE platform_weather_jobs
                SET status = 'running', updated_at = %s
                WHERE job_id = %s
                """,
                (timestamp, row[0]),
            )
        return self.get_weather_job(str(row[0]))

    def resolve_runtime_path(self, relative_path: str) -> Path:
        return self.artifact_store.resolve(relative_path)

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        """多语句事务上下文：临时关闭 autocommit，统一提交或回滚。"""
        with self._connect() as conn:
            conn.autocommit = False
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    def _connect(self):
        # 统一通过同一连接工厂接入 Postgres，方便后续测试覆盖与配置收口。
        return connect_postgres(self.database_url)

    def _get_run_or_none(self, run_id: str) -> AnalysisRunRecord | None:
        try:
            return self.get_run(run_id)
        except NotFoundError:
            return None

    def _build_thread_history_snapshot(self, run: AnalysisRunRecord) -> dict[str, Any]:
        # 线程快照是历史恢复的数据库锚点。
        #
        # 前端刷新、切换任务和 Agent SDK 上下文恢复都优先依赖 thread 快照，
        # 而不是每次先遍历全量事件再猜“最近聊到了哪”。
        latest_artifact = run.state.artifacts[-1] if run.state.artifacts else None
        return {
            "latest_run_id": run.id,
            "latest_user_query": run.user_query,
            "latest_assistant_summary": run.state.final_response.summary if run.state.final_response else None,
            "latest_run_status": run.status,
            "latest_artifact_id": latest_artifact.artifact_id if latest_artifact else None,
            "latest_artifact_name": latest_artifact.name if latest_artifact else None,
            "history_preview": self._build_thread_history_preview(run),
            "run_count": self._count_thread_runs(run.thread_id),
        }

    def _build_thread_history_preview(self, run: AnalysisRunRecord) -> str:
        # 历史预览遵循“优先结果，其次问题”的规则，
        # 让用户在任务列表里首先看到上一轮真正交付了什么。
        if run.state.final_response and run.state.final_response.summary.strip():
            return run.state.final_response.summary.strip()
        return run.user_query.strip()

    @staticmethod
    def _build_context_entries_for_run(run: AnalysisRunRecord) -> list[ContextEntryRecord]:
        # run 完成后的上下文索引投影。
        #
        # 这里只提取已经落入 run state 的事实，不再回读事件流猜测“模型刚才想表达什么”。
        if not run.thread_id:
            return []
        timestamp = now_utc()
        entries: list[ContextEntryRecord] = []
        state = run.state

        def make_entry(
            suffix: str,
            *,
            kind: str,
            label: str,
            summary: str,
            reference: ContextReference | None = None,
            search_text: str = "",
        ) -> None:
            if not label.strip() and not summary.strip():
                return
            entries.append(
                ContextEntryRecord(
                    context_entry_id=f"context_{run.id}_{suffix}",
                    session_id=run.session_id,
                    thread_id=run.thread_id or "",
                    source_run_id=run.id,
                    kind=kind,
                    label=label.strip() or kind,
                    summary=summary.strip(),
                    reference=reference,
                    search_text=search_text.strip() or f"{label}\n{summary}",
                    created_at=timestamp,
                    updated_at=timestamp,
                )
            )

        if state.final_response and state.final_response.summary.strip():
            make_entry(
                "summary",
                kind="run_summary",
                label=run.user_query[:48],
                summary=state.final_response.summary.strip(),
                search_text=f"{run.user_query}\n{state.final_response.summary}",
            )

        if state.place_resolution and state.place_resolution.selected:
            selected = state.place_resolution.selected
            if selected.latitude is not None and selected.longitude is not None:
                label = selected.display_name or selected.label
                reference = ContextReference(
                    reference_id=f"place:{run.id}",
                    kind="place",
                    label=label,
                    description=f"来自历史问题：{run.user_query}",
                    source_run_id=run.id,
                    collection_ref=f"context_place_{run.id}",
                    confidence=0.9,
                    usable_as=["collection", "place_anchor", "buffer_input", "poi_anchor"],
                    metadata={
                        "query": state.place_resolution.query,
                        "provider": state.place_resolution.provider,
                        "latitude": selected.latitude,
                        "longitude": selected.longitude,
                    },
                )
                make_entry(
                    "place",
                    kind="place",
                    label=label,
                    summary=f"地点解析结果：{label}（lat={selected.latitude}, lon={selected.longitude}）。",
                    reference=reference,
                    search_text=f"{run.user_query}\n{label}\n{state.place_resolution.query or ''}",
                )

        for artifact in state.artifacts:
            collection_ref = f"context_artifact_{artifact.artifact_id}" if artifact.artifact_type == "geojson" else None
            reference = ContextReference(
                reference_id=f"artifact:{artifact.artifact_id}",
                kind="artifact",
                label=artifact.name,
                description=f"来自历史结果：{run.user_query}",
                source_run_id=run.id,
                artifact_id=artifact.artifact_id,
                collection_ref=collection_ref,
                confidence=0.95,
                usable_as=["collection", "artifact", "buffer_input", "overlay_input"] if collection_ref else ["artifact"],
                metadata=artifact.metadata,
            )
            make_entry(
                f"artifact_{artifact.artifact_id}",
                kind="artifact",
                label=artifact.name,
                summary=f"结果产物：{artifact.name}，artifactId={artifact.artifact_id}。",
                reference=reference,
                search_text=f"{run.user_query}\n{artifact.name}\n{artifact.artifact_id}",
            )

        if state.clarification:
            selected = state.clarification.selected_option_id or "pending"
            reference = ContextReference(
                reference_id=f"clarification:{run.id}:{selected}",
                kind="clarification",
                label=selected,
                description=state.clarification.question,
                source_run_id=run.id,
                confidence=0.8,
                usable_as=["decision_context"],
                metadata=state.clarification.model_dump(mode="json"),
            )
            make_entry(
                "clarification",
                kind="clarification",
                label=selected,
                summary=state.clarification.question,
                reference=reference,
                search_text=f"{run.user_query}\n{state.clarification.question}\n{selected}",
            )

        completed_tools = [item for item in state.tool_results if item.status == "completed"][-8:]
        for index, tool_call in enumerate(completed_tools, start=1):
            make_entry(
                f"tool_{index}_{tool_call.tool}",
                kind="tool",
                label=tool_call.tool,
                summary=tool_call.message,
                search_text=f"{run.user_query}\n{tool_call.tool}\n{tool_call.message}",
            )
        return entries

    def _count_thread_runs(self, thread_id: str | None) -> int:
        if not thread_id:
            return 0
        return len(self.list_runs_for_thread(thread_id))

    def _refresh_session_latest_pointers(self, session_id: str) -> None:
        # 会话最新指针重算
        #
        # 线程删除后，session 上缓存的 latest_thread_id / latest_run_id 不能继续指向已经消失的数据。
        latest_thread = next(iter(self.list_threads_for_session(session_id)), None)
        latest_run = next(iter(self.list_runs_for_session(session_id)), None)
        self.update_session(
            session_id,
            latest_thread_id=latest_thread.id if latest_thread else None,
            latest_run_id=latest_run.id if latest_run else None,
        )
