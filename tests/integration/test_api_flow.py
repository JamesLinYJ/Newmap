import asyncio
from io import BytesIO

from pydantic import ValidationError
import pytest
from fastapi import HTTPException

from api_app.config import settings
import api_app.main as main_module
import tool_registry.registry as tool_registry_module
from api_app.main import (
    AnalysisRequest,
    QgisModelRequest,
    _start_run,
    app,
    geocode,
    list_providers,
    list_qgis_models,
    register_layer,
    run_qgis_model,
)
from api_app.store import FileStore
from shared_types.schemas import PublishRequest


@pytest.mark.asyncio
async def test_api_run_flow_completes(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        session = app.state.store.create_session()
        run = await _start_run(
            AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院", provider="demo"),
            app.state.store,
            app.state.runtime,
        )

        for _ in range(30):
            current = app.state.store.get_run(run.id).model_dump(mode="json", by_alias=True)
            if current["status"] in {"completed", "clarification_needed", "failed"}:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError("analysis did not finish in time")

        assert current["status"] == "completed"
        artifacts = app.state.store.list_artifacts(run.id)
        assert artifacts
        session_runs = app.state.store.list_runs_for_session(session.id)
        assert any(item.id == run.id for item in session_runs)
        await _drain_background_tasks()
        await asyncio.get_running_loop().shutdown_default_executor()


@pytest.mark.asyncio
async def test_geocode_and_provider_endpoints(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(main_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(
            app.state.spatial_service,
            "geocode_place",
            lambda query: {
                "type": "FeatureCollection",
                "features": [],
                "matches": [{"label": "巴黎", "country": "France"}],
            },
        )
        providers = await list_providers(app.state.runtime)
        assert any(item.provider == "demo" for item in providers)
        result = await geocode("巴黎")
        assert result["matches"]


@pytest.mark.asyncio
async def test_qgis_model_listing_endpoint():
    async with app.router.lifespan_context(app):
        app.state.qgis_runner.health = lambda: _async_value({"available": True})
        app.state.qgis_runner.list_models = lambda: _async_value({"available": True, "models": ["buffer_and_intersect"]})
        payload = await list_qgis_models()
        assert "buffer_and_intersect" in payload["models"]


@pytest.mark.asyncio
async def test_qgis_model_listing_falls_back_when_model_endpoint_fails():
    async with app.router.lifespan_context(app):
        original_health = app.state.qgis_runner.health
        original_list_models = app.state.qgis_runner.list_models

        async def broken_model_listing():
            raise RuntimeError("simulated model registry failure")

        app.state.qgis_runner.health = lambda: _async_value({"available": True})
        app.state.qgis_runner.list_models = broken_model_listing

        payload = await list_qgis_models()
        assert payload["available"] is False
        assert "buffer_and_intersect" in payload["models"]
        assert "simulated model registry failure" in payload["error"]
        app.state.qgis_runner.health = original_health
        app.state.qgis_runner.list_models = original_list_models


@pytest.mark.asyncio
async def test_qgis_model_run_returns_specific_error_when_runtime_is_offline():
    original_health = app.state.qgis_runner.health if hasattr(app.state, "qgis_runner") else None
    async with app.router.lifespan_context(app):
        async def offline_health():
            return {"available": False, "error": "QGIS runtime health check failed: simulated offline runtime"}

        app.state.qgis_runner.health = offline_health
        with pytest.raises(HTTPException) as exc_info:
            await run_qgis_model(
                QgisModelRequest(modelName="buffer_and_intersect", artifactId="artifact_missing", runId="run_missing"),
                store=app.state.store,
            )
        assert exc_info.value.status_code == 503
        detail = str(exc_info.value.detail)
        assert "QGIS runtime" in detail
        assert "failed" in detail
        if original_health is not None:
            app.state.qgis_runner.health = original_health


@pytest.mark.asyncio
async def test_analysis_failure_exposes_specific_error(monkeypatch: pytest.MonkeyPatch):
    original_update_run_state = FileStore.update_run_state

    def fail_on_plan(self: FileStore, run_id: str, *, status: str | None = None, **fields):
        if "execution_plan" in fields:
            raise RuntimeError("forced execution plan persistence failure")
        return original_update_run_state(self, run_id, status=status, **fields)

    monkeypatch.setattr(FileStore, "update_run_state", fail_on_plan)

    async with app.router.lifespan_context(app):
        monkeypatch.setenv("PYTEST_CURRENT_TEST", "forced-sync-failure")
        session = app.state.store.create_session()
        run = (
            await _start_run(
                AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院", provider="demo"),
                app.state.store,
                app.state.runtime,
            )
        ).model_dump(mode="json", by_alias=True)

        assert run["status"] == "failed"
        assert "RuntimeError" in run["state"]["errors"][0]
        assert "forced execution plan persistence failure" in run["state"]["errors"][0]


@pytest.mark.asyncio
async def test_upload_rejects_payloads_larger_than_limit(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "upload_max_bytes", 8)

    async with app.router.lifespan_context(app):
        session = app.state.store.create_session()
        upload = _FakeUpload("too-large.geojson", b"123456789")
        with pytest.raises(HTTPException) as exc_info:
            await register_layer(session.id, upload, store=app.state.store, catalog=app.state.catalog)
        assert exc_info.value.status_code == 413
        assert "上传文件过大" in str(exc_info.value.detail)


def test_publish_rejects_path_like_project_keys():
    with pytest.raises(ValidationError) as exc_info:
        PublishRequest(projectKey="../../tmp/pwn")
    assert "projectKey" in str(exc_info.value)


async def _async_value(value):
    return value


async def _drain_background_tasks():
    pending = [task for task in app.state.background_tasks if not task.done()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


class _FakeUpload:
    def __init__(self, filename: str, payload: bytes):
        self.filename = filename
        self._buffer = BytesIO(payload)

    async def read(self, size: int = -1) -> bytes:
        return self._buffer.read(size)
