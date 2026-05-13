# +-------------------------------------------------------------------------
#
#   地理智能平台 - 平台 Postgres 存储
#
#   文件:       platform_store.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
# 模块职责
#
# 统一负责 session、thread、run、event、artifact 和 runtime config 的持久化读写。
from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import contextmanager
from typing import Any, Iterator

from shared_types.exceptions import NotFoundError

from shared_types.schemas import AgentRuntimeConfig, AgentStateModel, AgentThreadRecord, AnalysisRunRecord, ArtifactRef, RunEvent, RunLifecycle, SessionRecord
from gis_common.ids import make_id, now_utc

from .artifact_store import ArtifactExportStore
from .postgres import connect_postgres
from agent_core.supervisor_config import build_default_runtime_config, normalize_runtime_config


class PostgresPlatformStore:
    # PostgresPlatformStore
    #
    # 这是平台业务态的主事实源。
    # 所有 run / thread / event / artifact / runtime config 的持久化都经过这里，
    # 上层运行时只负责计算，不直接决定数据库结构细节。
    def __init__(self, database_url: str, *, artifact_store: ArtifactExportStore):
        self.database_url = database_url
        self.artifact_store = artifact_store
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
                CREATE TABLE IF NOT EXISTS platform_runs (
                    run_id TEXT PRIMARY KEY,
                    thread_id TEXT,
                    session_id TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    payload_json JSONB NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_threads (
                    thread_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    payload_json JSONB NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_events (
                    event_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
                    occurred_at TIMESTAMPTZ NOT NULL,
                    payload_json JSONB NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
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
                "CREATE INDEX IF NOT EXISTS idx_platform_runs_session_updated ON platform_runs(session_id, updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_platform_runs_thread_updated ON platform_runs(thread_id, updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_platform_threads_session_updated ON platform_threads(session_id, updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_platform_events_run_occurred ON platform_events(run_id, occurred_at, event_id)"
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
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT payload_json
                FROM platform_runs
                WHERE session_id = %s
                ORDER BY updated_at DESC
                """,
                (session_id,),
            )
            rows = cur.fetchall()
        return [AnalysisRunRecord.model_validate(row[0]) for row in rows]

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
        self.save_thread(thread)
        self.update_session(session_id, latest_thread_id=thread.id)
        return thread

    def save_thread(self, thread: AgentThreadRecord) -> None:
        payload = thread.model_dump(mode="json", by_alias=True)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_threads (thread_id, session_id, status, created_at, updated_at, payload_json)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (thread_id) DO UPDATE SET
                    session_id = EXCLUDED.session_id,
                    status = EXCLUDED.status,
                    updated_at = EXCLUDED.updated_at,
                    payload_json = EXCLUDED.payload_json
                """,
                (thread.id, thread.session_id, thread.status, thread.created_at, thread.updated_at, json.dumps(payload, ensure_ascii=False)),
            )

    def get_thread(self, thread_id: str) -> AgentThreadRecord:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload_json FROM platform_threads WHERE thread_id = %s", (thread_id,))
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("线程不存在。")
        return AgentThreadRecord.model_validate(row[0])

    def get_or_create_thread_for_session(self, session_id: str, *, title: str | None = None) -> AgentThreadRecord:
        session = self.get_session(session_id)
        if session.latest_thread_id:
            try:
                return self.get_thread(session.latest_thread_id)
            except NotFoundError:
                return self.create_thread(session_id, title=title)
        return self.create_thread(session_id, title=title)

    def update_thread(self, thread_id: str, **fields: Any) -> AgentThreadRecord:
        thread = self.get_thread(thread_id)
        updated = thread.model_copy(update={**fields, "updated_at": now_utc()})
        self.save_thread(updated)
        return updated

    def list_threads_for_session(self, session_id: str) -> list[AgentThreadRecord]:
        # 线程列表是“历史对话”的主索引，而不只是 run 的附属信息。
        #
        # 这里返回每个 thread 的最新快照，供前端恢复最近会话、
        # 展示历史摘要或后续扩展多任务入口时复用。
        self.get_session(session_id)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT payload_json
                FROM platform_threads
                WHERE session_id = %s
                ORDER BY updated_at DESC, created_at DESC
                """,
                (session_id,),
            )
            rows = cur.fetchall()
        return [AgentThreadRecord.model_validate(row[0]) for row in rows]

    def delete_thread(self, thread_id: str) -> None:
        # 线程删除
        #
        # 删除 thread 时要一并清理：
        # 1. 关联 run / event / artifact 记录。
        # 2. runtime/artifacts 下的导出 GeoJSON。
        # 3. session.latest_thread_id / latest_run_id 指针。
        thread = self.get_thread(thread_id)
        runs = self.list_runs_for_thread(thread_id)
        run_ids = [item.id for item in runs]
        artifact_ids = list(dict.fromkeys(artifact.artifact_id for run in runs for artifact in run.state.artifacts))

        for artifact_id in artifact_ids:
            try:
                self.artifact_store.delete(self._artifact_relative_path(artifact_id))
            except NotFoundError:
                continue

        with self.transaction() as conn, conn.cursor() as cur:
            if artifact_ids:
                cur.execute("DELETE FROM platform_artifacts WHERE artifact_id = ANY(%s)", (artifact_ids,))
            if run_ids:
                cur.execute("DELETE FROM platform_events WHERE run_id = ANY(%s)", (run_ids,))
                cur.execute("DELETE FROM platform_runs WHERE run_id = ANY(%s)", (run_ids,))
            cur.execute("DELETE FROM platform_threads WHERE thread_id = %s", (thread_id,))

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
        # 这样后续无论是 deterministic loop 还是 live supervisor，
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
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload_json FROM platform_runs WHERE run_id = %s", (run_id,))
            row = cur.fetchone()
        if row is None:
            raise NotFoundError("分析任务不存在。")
        return AnalysisRunRecord.model_validate(row[0])

    def save_run(self, run: AnalysisRunRecord) -> None:
        # 保存 run 同时维护 thread 的 latest_run_id。
        #
        # thread 视角需要能快速恢复最近一次运行，因此这里把关联更新放在一起，
        # 避免调用方忘记补写 thread 索引。
        payload = run.model_dump(mode="json", by_alias=True)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_runs (run_id, thread_id, session_id, status, created_at, updated_at, payload_json)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (run_id) DO UPDATE SET
                    thread_id = EXCLUDED.thread_id,
                    session_id = EXCLUDED.session_id,
                    status = EXCLUDED.status,
                    updated_at = EXCLUDED.updated_at,
                    payload_json = EXCLUDED.payload_json
                """,
                (run.id, run.thread_id, run.session_id, run.status, run.created_at, run.updated_at, json.dumps(payload, ensure_ascii=False)),
            )
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
        # 事件既落库也广播给当前 SSE 订阅者。
        #
        # 事件表负责历史回放，内存 queue 负责实时体验；
        # 两边都写，前端刷新和实时流才能讲同一个故事。
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_events (event_id, run_id, occurred_at, payload_json)
                VALUES (%s, %s, %s, %s::jsonb)
                ON CONFLICT (event_id) DO NOTHING
                """,
                (event.event_id, run_id, event.timestamp, json.dumps(event.model_dump(mode="json", by_alias=True), ensure_ascii=False)),
            )
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
        with self._connect() as conn, conn.cursor() as cur:
            if limit is not None:
                cur.execute(
                    """
                    SELECT payload_json
                    FROM platform_events
                    WHERE run_id = %s
                    ORDER BY occurred_at DESC, event_id DESC
                    LIMIT %s
                    """,
                    (run_id, limit),
                )
            else:
                cur.execute(
                    """
                    SELECT payload_json
                    FROM platform_events
                    WHERE run_id = %s
                    ORDER BY occurred_at, event_id
                    """,
                    (run_id,),
                )
            rows = cur.fetchall()
        events = [RunEvent.model_validate(row[0]) for row in rows]
        if limit is not None:
            events.reverse()
        return events

    def list_runs_for_thread(self, thread_id: str, *, limit: int | None = None) -> list[AnalysisRunRecord]:
        with self._connect() as conn, conn.cursor() as cur:
            if limit is not None:
                cur.execute(
                    """
                    SELECT payload_json
                    FROM platform_runs
                    WHERE thread_id = %s
                    ORDER BY updated_at DESC
                    LIMIT %s
                    """,
                    (thread_id, limit),
                )
            else:
                cur.execute(
                    """
                    SELECT payload_json
                    FROM platform_runs
                    WHERE thread_id = %s
                    ORDER BY updated_at DESC
                    """,
                    (thread_id,),
                )
            rows = cur.fetchall()
        return [AnalysisRunRecord.model_validate(row[0]) for row in rows]

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
        return self.artifact_store.load_geojson(self._artifact_relative_path(artifact_id))

    def get_artifact_geojson_path(self, artifact_id: str):
        return self.artifact_store.resolve(self._artifact_relative_path(artifact_id))

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

    def _count_thread_runs(self, thread_id: str | None) -> int:
        if not thread_id:
            return 0
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM platform_runs WHERE thread_id = %s", (thread_id,))
            row = cur.fetchone()
        return int(row[0]) if row else 0

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
