from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from gis_common.geojson import load_geojson, save_geojson
from gis_common.ids import make_id, now_utc
from shared_types.schemas import AgentStateModel, AnalysisRunRecord, ArtifactRef, RunEvent, SessionRecord


class FileStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.runs_dir = data_dir / "runs"
        self.sessions_dir = self.runs_dir / "sessions"
        self.analysis_dir = self.runs_dir / "analysis"
        self.events_dir = self.runs_dir / "events"
        self.artifacts_dir = data_dir / "artifacts"
        self.artifact_index_dir = self.artifacts_dir / "index"
        for path in (self.sessions_dir, self.analysis_dir, self.events_dir, self.artifact_index_dir):
            path.mkdir(parents=True, exist_ok=True)
        self._subscribers: dict[str, list[asyncio.Queue[RunEvent]]] = {}

    def create_session(self) -> SessionRecord:
        session = SessionRecord(id=make_id("session"), created_at=now_utc(), share_token=secrets.token_urlsafe(10))
        self.save_session(session)
        return session

    def save_session(self, session: SessionRecord) -> None:
        self._write_model(self.sessions_dir / f"{session.id}.json", session)

    def get_session(self, session_id: str) -> SessionRecord:
        path = self.sessions_dir / f"{session_id}.json"
        if not path.exists():
            raise HTTPException(status_code=404, detail="会话不存在。")
        return SessionRecord.model_validate_json(path.read_text(encoding="utf-8"))

    def update_session(self, session_id: str, **fields: Any) -> SessionRecord:
        session = self.get_session(session_id)
        updated = session.model_copy(update=fields)
        self.save_session(updated)
        return updated

    def list_runs_for_session(self, session_id: str) -> list[AnalysisRunRecord]:
        self.get_session(session_id)
        runs: list[AnalysisRunRecord] = []
        for path in self.analysis_dir.glob("*.json"):
            run = AnalysisRunRecord.model_validate_json(path.read_text(encoding="utf-8"))
            if run.session_id == session_id:
                runs.append(run)
        return sorted(runs, key=lambda item: item.updated_at, reverse=True)

    def create_run(
        self,
        session_id: str,
        user_query: str,
        *,
        model_provider: str = "demo",
        model_name: str | None = None,
    ) -> AnalysisRunRecord:
        state = AgentStateModel(
            session_id=session_id,
            user_query=user_query,
            model_provider=model_provider,
            model_name=model_name,
        )
        run = AnalysisRunRecord(
            id=make_id("run"),
            session_id=session_id,
            user_query=user_query,
            model_provider=model_provider,
            model_name=model_name,
            created_at=now_utc(),
            updated_at=now_utc(),
            status="queued",
            state=state,
        )
        self._write_model(self.analysis_dir / f"{run.id}.json", run)
        self.update_session(session_id, latest_run_id=run.id)
        return run

    def mark_run_running(self, run_id: str) -> AnalysisRunRecord:
        run = self.get_run(run_id)
        updated = run.model_copy(update={"status": "running", "updated_at": now_utc()})
        self._write_model(self.analysis_dir / f"{run.id}.json", updated)
        return updated

    def get_run(self, run_id: str) -> AnalysisRunRecord:
        path = self.analysis_dir / f"{run_id}.json"
        if not path.exists():
            raise HTTPException(status_code=404, detail="分析任务不存在。")
        return AnalysisRunRecord.model_validate_json(path.read_text(encoding="utf-8"))

    def save_run(self, run: AnalysisRunRecord) -> None:
        self._write_model(self.analysis_dir / f"{run.id}.json", run)

    def complete_run(self, run_id: str, state: AgentStateModel) -> AnalysisRunRecord:
        run = self.get_run(run_id)
        status = "completed"
        if state.errors:
            status = "failed"
        elif state.parsed_intent and state.parsed_intent.clarification_required:
            status = "clarification_needed"
        updated = run.model_copy(update={"state": state, "status": status, "updated_at": now_utc()})
        self.save_run(updated)
        return updated

    def update_run_state(self, run_id: str, *, status: str | None = None, **fields: Any) -> AnalysisRunRecord:
        run = self.get_run(run_id)
        updated_state = AgentStateModel.model_validate({**run.state.model_dump(mode="python"), **fields})
        update_fields: dict[str, Any] = {"state": updated_state, "updated_at": now_utc()}
        if status is not None:
            update_fields["status"] = status
        updated_run = run.model_copy(update=update_fields)
        self.save_run(updated_run)
        return updated_run

    def append_event(self, run_id: str, event: RunEvent) -> None:
        path = self.events_dir / f"{run_id}.json"
        events = []
        if path.exists():
            events = json.loads(path.read_text(encoding="utf-8"))
        events.append(event.model_dump(mode="json"))
        path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
        for queue in self._subscribers.get(run_id, []):
            queue.put_nowait(event)

    def list_events(self, run_id: str) -> list[RunEvent]:
        path = self.events_dir / f"{run_id}.json"
        if not path.exists():
            return []
        return [RunEvent.model_validate(item) for item in json.loads(path.read_text(encoding="utf-8"))]

    def subscribe(self, run_id: str) -> asyncio.Queue[RunEvent]:
        queue: asyncio.Queue[RunEvent] = asyncio.Queue()
        self._subscribers.setdefault(run_id, []).append(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[RunEvent]) -> None:
        subscribers = self._subscribers.get(run_id, [])
        if queue in subscribers:
            subscribers.remove(queue)

    def save_geojson_artifact(
        self,
        *,
        run_id: str,
        artifact_id: str,
        name: str,
        collection: dict[str, Any],
        metadata: dict[str, Any],
    ) -> ArtifactRef:
        artifact_dir = self.artifacts_dir / run_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        geojson_path = artifact_dir / f"{artifact_id}.geojson"
        save_geojson(geojson_path, collection)
        artifact = ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type="geojson",
            name=name,
            uri=f"/api/v1/results/{artifact_id}/geojson",
            metadata=metadata,
        )
        metadata_path = artifact_dir / f"{artifact_id}.metadata.json"
        index_payload = {
            "artifact": artifact.model_dump(mode="json"),
            "geojson_path": str(geojson_path),
            "metadata_path": str(metadata_path),
            "geojson_relative_path": str(geojson_path.relative_to(self.data_dir)),
            "metadata_relative_path": str(metadata_path.relative_to(self.data_dir)),
        }
        self._write_json(self.artifact_index_dir / f"{artifact_id}.json", index_payload)
        self._write_json(metadata_path, metadata)
        return artifact

    def get_artifact(self, artifact_id: str) -> ArtifactRef:
        path = self.artifact_index_dir / f"{artifact_id}.json"
        if not path.exists():
            raise HTTPException(status_code=404, detail="结果对象不存在。")
        payload = json.loads(path.read_text(encoding="utf-8"))
        return ArtifactRef.model_validate(payload["artifact"])

    def get_artifact_collection(self, artifact_id: str) -> dict[str, Any]:
        payload = self._artifact_index(artifact_id)
        return load_geojson(self._resolve_artifact_path(payload, path_type="geojson"))

    def get_artifact_geojson_path(self, artifact_id: str) -> Path:
        payload = self._artifact_index(artifact_id)
        return self._resolve_artifact_path(payload, path_type="geojson")

    def get_artifact_metadata(self, artifact_id: str) -> dict[str, Any]:
        payload = self._artifact_index(artifact_id)
        metadata_path = self._resolve_artifact_path(payload, path_type="metadata")
        if not metadata_path.exists():
            return {}
        return json.loads(metadata_path.read_text(encoding="utf-8"))

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

    def _artifact_index(self, artifact_id: str) -> dict[str, Any]:
        path = self.artifact_index_dir / f"{artifact_id}.json"
        if not path.exists():
            raise HTTPException(status_code=404, detail="结果对象不存在。")
        return json.loads(path.read_text(encoding="utf-8"))

    def _resolve_artifact_path(self, payload: dict[str, Any], *, path_type: str) -> Path:
        relative_key = f"{path_type}_relative_path"
        if relative_key in payload:
            candidate = self.data_dir / str(payload[relative_key])
            if candidate.exists():
                return candidate

        legacy_key = f"{path_type}_path"
        if legacy_key in payload:
            legacy_path = Path(str(payload[legacy_key]))
            if legacy_path.exists():
                return legacy_path

        artifact = ArtifactRef.model_validate(payload["artifact"])
        suffix = ".geojson" if path_type == "geojson" else ".metadata.json"
        fallback = self.artifacts_dir / artifact.run_id / f"{artifact.artifact_id}{suffix}"
        return fallback

    def _write_model(self, path: Path, model) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(model.model_dump_json(indent=2), encoding="utf-8")

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
