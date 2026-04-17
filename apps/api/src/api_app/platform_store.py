from __future__ import annotations

import asyncio
import json
import secrets
from typing import Any

from fastapi import HTTPException

from shared_types.schemas import AgentRuntimeConfig, AgentStateModel, AgentThreadRecord, AnalysisRunRecord, ArtifactRef, RunEvent, SessionRecord
from gis_common.ids import make_id, now_utc

from .artifact_store import ArtifactExportStore
from .postgres import connect_postgres
from agent_core.supervisor_config import build_default_runtime_config, normalize_runtime_config


class PostgresPlatformStore:
    def __init__(self, database_url: str, *, artifact_store: ArtifactExportStore):
        self.database_url = database_url
        self.artifact_store = artifact_store
        self._subscribers: dict[str, list[asyncio.Queue[RunEvent]]] = {}

    def ensure_schema(self) -> None:
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
            cur.execute("ALTER TABLE platform_runs ADD COLUMN IF NOT EXISTS thread_id TEXT")
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
            raise HTTPException(status_code=404, detail="会话不存在。")
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
            raise HTTPException(status_code=404, detail="线程不存在。")
        return AgentThreadRecord.model_validate(row[0])

    def get_or_create_thread_for_session(self, session_id: str, *, title: str | None = None) -> AgentThreadRecord:
        session = self.get_session(session_id)
        if session.latest_thread_id:
            try:
                return self.get_thread(session.latest_thread_id)
            except HTTPException:
                pass
        return self.create_thread(session_id, title=title)

    def update_thread(self, thread_id: str, **fields: Any) -> AgentThreadRecord:
        thread = self.get_thread(thread_id)
        updated = thread.model_copy(update={**fields, "updated_at": now_utc()})
        self.save_thread(updated)
        return updated

    def create_run(
        self,
        session_id: str,
        user_query: str,
        *,
        thread_id: str | None = None,
        model_provider: str = "gemini",
        model_name: str | None = None,
    ) -> AnalysisRunRecord:
        state = AgentStateModel(
            session_id=session_id,
            thread_id=thread_id,
            user_query=user_query,
            model_provider=model_provider,
            model_name=model_name,
        )
        timestamp = now_utc()
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
        updated = run.model_copy(update={"status": "running", "updated_at": now_utc()})
        self.save_run(updated)
        return updated

    def get_run(self, run_id: str) -> AnalysisRunRecord:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload_json FROM platform_runs WHERE run_id = %s", (run_id,))
            row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="分析任务不存在。")
        return AnalysisRunRecord.model_validate(row[0])

    def save_run(self, run: AnalysisRunRecord) -> None:
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
            self.update_thread(run.thread_id, latest_run_id=run.id)

    def complete_run(self, run_id: str, state: AgentStateModel) -> AnalysisRunRecord:
        run = self.get_run(run_id)
        status = "completed"
        if state.errors:
            status = "failed"
        elif any(item.status == "pending" for item in state.approvals):
            status = "waiting_approval"
        elif state.parsed_intent and state.parsed_intent.clarification_required:
            status = "clarification_needed"
        updated = run.model_copy(update={"state": state, "status": status, "updated_at": now_utc()})
        self.save_run(updated)
        return updated

    def update_run_state(self, run_id: str, *, status: str | None = None, **fields: Any) -> AnalysisRunRecord:
        run = self.get_run(run_id)
        updated_state = run.state.model_copy(update=fields)
        update_fields: dict[str, Any] = {"state": updated_state, "updated_at": now_utc()}
        if status is not None:
            update_fields["status"] = status
        updated_run = run.model_copy(update=update_fields)
        self.save_run(updated_run)
        return updated_run

    def append_event(self, run_id: str, event: RunEvent) -> None:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO platform_events (event_id, run_id, occurred_at, payload_json)
                VALUES (%s, %s, %s, %s::jsonb)
                ON CONFLICT (event_id) DO NOTHING
                """,
                (event.event_id, run_id, event.timestamp, json.dumps(event.model_dump(mode="json", by_alias=True), ensure_ascii=False)),
            )
        for queue in self._subscribers.get(run_id, []):
            queue.put_nowait(event)

    def list_events(self, run_id: str) -> list[RunEvent]:
        with self._connect() as conn, conn.cursor() as cur:
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
        return [RunEvent.model_validate(row[0]) for row in rows]

    def list_runs_for_thread(self, thread_id: str) -> list[AnalysisRunRecord]:
        self.get_thread(thread_id)
        with self._connect() as conn, conn.cursor() as cur:
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

    def get_runtime_config(self) -> AgentRuntimeConfig:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload_json FROM platform_runtime_config WHERE config_key = %s", ("default",))
            row = cur.fetchone()
        if row is None:
            config = normalize_runtime_config(build_default_runtime_config())
            self.save_runtime_config(config)
            return config
        return normalize_runtime_config(row[0])

    def save_runtime_config(self, config: AgentRuntimeConfig) -> AgentRuntimeConfig:
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
            raise HTTPException(status_code=404, detail="结果对象不存在。")
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
        run = self.get_run(run_id)
        artifacts = [ArtifactRef.model_validate(item) for item in run.state.artifacts]
        if not any(item.artifact_id == artifact.artifact_id for item in artifacts):
            artifacts.append(artifact)
        updated_state = run.state.model_copy(update={"artifacts": artifacts})
        updated_run = run.model_copy(update={"state": updated_state, "updated_at": now_utc()})
        self.save_run(updated_run)
        return updated_run

    def _artifact_relative_path(self, artifact_id: str) -> str:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT geojson_relative_path FROM platform_artifacts WHERE artifact_id = %s",
                (artifact_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="结果对象不存在。")
        return str(row[0])

    def _connect(self):
        return connect_postgres(self.database_url)
