import asyncio

import httpx
import pytest

from api_app.main import app
from api_app.store import FileStore


@pytest.mark.asyncio
async def test_api_run_flow_completes():
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            session = (await client.post("/api/v1/sessions")).json()
            run = (
                await client.post(
                    "/api/v1/chat",
                    json={"sessionId": session["id"], "query": "查询巴黎地铁站 1 公里范围内的医院", "provider": "demo"},
                )
            ).json()

            for _ in range(30):
                current = (await client.get(f"/api/v1/analysis/{run['id']}")).json()
                if current["status"] in {"completed", "clarification_needed", "failed"}:
                    break
                await asyncio.sleep(0.1)
            else:
                raise AssertionError("analysis did not finish in time")

            assert current["status"] == "completed"
            artifacts = (await client.get(f"/api/v1/analysis/{run['id']}/artifacts")).json()
            assert artifacts
            session_runs = (await client.get(f"/api/v1/sessions/{session['id']}/runs")).json()
            assert any(item["id"] == run["id"] for item in session_runs)


@pytest.mark.asyncio
async def test_geocode_and_provider_endpoints():
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            providers = (await client.get("/api/v1/providers")).json()
            assert any(item["provider"] == "demo" for item in providers)

            geocode = (await client.get("/api/v1/geocode", params={"q": "巴黎"})).json()
            assert geocode["matches"]


@pytest.mark.asyncio
async def test_qgis_model_listing_endpoint():
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            payload = (await client.get("/api/v1/qgis/models")).json()
            assert "buffer_and_intersect" in payload["models"]


@pytest.mark.asyncio
async def test_qgis_model_run_returns_specific_error_when_runtime_is_offline():
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/api/v1/qgis/models/run",
                json={"modelName": "buffer_and_intersect", "artifactId": "artifact_missing", "runId": "run_missing"},
            )
            assert response.status_code == 503
            detail = response.json()["detail"]
            assert "QGIS runtime" in detail
            assert "failed" in detail


@pytest.mark.asyncio
async def test_analysis_failure_exposes_specific_error(monkeypatch: pytest.MonkeyPatch):
    original_update_run_state = FileStore.update_run_state

    def fail_on_plan(self: FileStore, run_id: str, *, status: str | None = None, **fields):
        if "execution_plan" in fields:
            raise RuntimeError("forced execution plan persistence failure")
        return original_update_run_state(self, run_id, status=status, **fields)

    monkeypatch.setattr(FileStore, "update_run_state", fail_on_plan)

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            session = (await client.post("/api/v1/sessions")).json()
            run = (
                await client.post(
                    "/api/v1/chat",
                    json={"sessionId": session["id"], "query": "查询巴黎地铁站 1 公里范围内的医院", "provider": "demo"},
                )
            ).json()

            assert run["status"] == "failed"
            assert "RuntimeError" in run["state"]["errors"][0]
            assert "forced execution plan persistence failure" in run["state"]["errors"][0]
