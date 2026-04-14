from __future__ import annotations

import json
from typing import Any
from pathlib import Path

import httpx
import pytest

from api_app.main import _from_qgis_runtime_path, app
import tool_registry.registry as tool_registry_module


def _polygon_collection() -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Berlin"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[13.35, 52.45], [13.55, 52.45], [13.55, 52.6], [13.35, 52.6], [13.35, 52.45]]],
                },
            }
        ],
    }


@pytest.mark.asyncio
async def test_tools_endpoint_returns_structured_qgis_and_registry_tools(api_client: httpx.AsyncClient):
    async def healthy():
        return {"available": True}

    async def models():
        return {"available": True, "models": ["buffer_and_intersect", "site_selection_basic"]}

    async def algorithms():
        return {
            "available": True,
            "algorithms": [
                {
                    "id": "native:buffer",
                    "display_name": "Buffer",
                    "group": "Vector geometry",
                    "description": "Computes a buffer area.",
                    "tags": ["buffer"],
                    "provider_id": "native",
                    "provider_name": "QGIS (native c++)",
                    "output_parameter_name": "OUTPUT",
                    "outputs": [{"name": "OUTPUT", "description": "Buffered", "type": "outputVector"}],
                    "parameters": [
                        {"name": "INPUT", "description": "Input layer", "type": "source", "default_value": None, "optional": False, "is_destination": False},
                        {"name": "DISTANCE", "description": "Distance", "type": "distance", "default_value": 10, "optional": False, "is_destination": False},
                        {"name": "SEGMENTS", "description": "Segments", "type": "number", "default_value": 5, "optional": False, "is_destination": False},
                        {"name": "OUTPUT", "description": "Buffered", "type": "sink", "default_value": None, "optional": False, "is_destination": True},
                    ],
                },
                {
                    "id": "native:intersection",
                    "display_name": "Intersection",
                    "group": "Vector overlay",
                    "description": "Overlay features.",
                    "tags": ["intersection"],
                    "provider_id": "native",
                    "provider_name": "QGIS (native c++)",
                    "output_parameter_name": "OUTPUT",
                    "outputs": [{"name": "OUTPUT", "description": "Intersection", "type": "outputVector"}],
                    "parameters": [
                        {"name": "INPUT", "description": "Input layer", "type": "source", "default_value": None, "optional": False, "is_destination": False},
                        {"name": "OVERLAY", "description": "Overlay layer", "type": "source", "default_value": None, "optional": False, "is_destination": False},
                        {"name": "OUTPUT", "description": "Intersection", "type": "sink", "default_value": None, "optional": False, "is_destination": True},
                    ],
                },
            ],
        }

    app.state.qgis_runner.health = healthy
    app.state.qgis_runner.list_models = models
    app.state.qgis_runner.list_algorithms = algorithms

    response = await api_client.get("/api/v1/tools")

    assert response.status_code == 200
    payload = response.json()
    by_name = {item["name"]: item for item in payload}
    assert "buffer" in by_name
    assert by_name["buffer"]["parameters"][0]["key"] == "input"
    assert by_name["buffer_and_intersect"]["toolKind"] == "qgis_model"
    assert by_name["native:buffer"]["toolKind"] == "qgis_algorithm"
    assert by_name["native:buffer"]["parameters"][0]["key"] == "INPUT"
    assert any(item["group"] == "qgis" for item in payload)

    algorithms_response = await api_client.get("/api/v1/qgis/algorithms")
    assert algorithms_response.status_code == 200
    assert len(algorithms_response.json()["algorithms"]) == 2


@pytest.mark.asyncio
async def test_tool_run_reuses_alias_context_across_requests(monkeypatch: pytest.MonkeyPatch, api_client: httpx.AsyncClient):
    async def inline_to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
    monkeypatch.setattr(app.state.spatial_service, "load_boundary", lambda name: _polygon_collection())

    session = (await api_client.post("/api/v1/sessions")).json()

    first = await api_client.post(
        "/api/v1/tools/run",
        json={
            "sessionId": session["id"],
            "toolName": "load_boundary",
            "toolKind": "registry",
            "args": {"name": "Berlin", "alias": "berlin_boundary"},
        },
    )

    assert first.status_code == 200
    first_payload = first.json()
    assert first_payload["artifact"]["name"] == "Berlin 边界"
    run_id = first_payload["run"]["id"]

    second = await api_client.post(
        "/api/v1/tools/run",
        json={
            "sessionId": session["id"],
            "runId": run_id,
            "toolName": "buffer",
            "toolKind": "registry",
            "args": {"input": "berlin_boundary", "distance_m": 250, "alias": "berlin_buffer"},
        },
    )

    assert second.status_code == 200
    second_payload = second.json()
    assert second_payload["artifact"]["name"] == "250m 缓冲区"
    assert second_payload["run"]["status"] == "completed"


@pytest.mark.asyncio
async def test_tool_run_harness_surfaces_specific_validation_errors(api_client: httpx.AsyncClient):
    session = (await api_client.post("/api/v1/sessions")).json()

    response = await api_client.post(
        "/api/v1/tools/run",
        json={
            "sessionId": session["id"],
            "toolName": "buffer",
            "toolKind": "registry",
            "args": {"distance_m": 1000},
        },
    )

    assert response.status_code == 400
    assert "input" in response.json()["detail"]


@pytest.mark.asyncio
async def test_tool_catalog_crud_updates_tool_descriptors(api_client: httpx.AsyncClient):
    async def algorithms():
        return {
            "available": True,
            "algorithms": [
                {
                    "id": "native:buffer",
                    "display_name": "Buffer",
                    "group": "Vector geometry",
                    "description": "Computes a buffer area.",
                    "tags": ["buffer"],
                    "provider_id": "native",
                    "provider_name": "QGIS (native c++)",
                    "output_parameter_name": "OUTPUT",
                    "outputs": [{"name": "OUTPUT", "description": "Buffered", "type": "outputVector"}],
                    "parameters": [
                        {"name": "INPUT", "description": "Input layer", "type": "source", "default_value": None, "optional": False, "is_destination": False},
                        {"name": "DISTANCE", "description": "Distance", "type": "distance", "default_value": 10, "optional": False, "is_destination": False},
                        {"name": "OUTPUT", "description": "Buffered", "type": "sink", "default_value": None, "optional": False, "is_destination": True},
                    ],
                }
            ],
        }

    app.state.qgis_runner.list_algorithms = algorithms
    app.state.qgis_runner.health = lambda: _async_value({"available": True})

    update_response = await api_client.put(
        "/api/v1/tools/catalog/qgis_algorithm/native:buffer",
        json={
            "payload": {
                "label": "Buffer Lab",
                "group": "analysis-lab",
                "parameters": {
                    "DISTANCE": {
                        "label": "分析距离",
                        "defaultValue": 3200,
                    }
                },
            },
            "sortOrder": 222,
        },
    )

    assert update_response.status_code == 200
    entry = update_response.json()
    assert entry["payload"]["label"] == "Buffer Lab"
    assert entry["sortOrder"] == 222

    tools_response = await api_client.get("/api/v1/tools")
    tools_by_name = {item["name"]: item for item in tools_response.json()}
    assert tools_by_name["native:buffer"]["label"] == "Buffer Lab"
    assert tools_by_name["native:buffer"]["group"] == "analysis-lab"
    distance_parameter = next(item for item in tools_by_name["native:buffer"]["parameters"] if item["key"] == "DISTANCE")
    assert distance_parameter["label"] == "分析距离"
    assert distance_parameter["defaultValue"] == 3200

    delete_response = await api_client.delete("/api/v1/tools/catalog/qgis_algorithm/native:buffer")
    assert delete_response.status_code == 200
    assert delete_response.json()["deleted"] is True

    restored_tools = await api_client.get("/api/v1/tools")
    restored_by_name = {item["name"]: item for item in restored_tools.json()}
    assert restored_by_name["native:buffer"]["label"] == "Buffer"


@pytest.mark.asyncio
async def test_dynamic_qgis_algorithm_tool_can_run_through_generic_executor(api_client: httpx.AsyncClient):
    async def algorithms():
        return {
            "available": True,
            "algorithms": [
                {
                    "id": "native:buffer",
                    "display_name": "Buffer",
                    "group": "Vector geometry",
                    "description": "Computes a buffer area.",
                    "tags": ["buffer"],
                    "provider_id": "native",
                    "provider_name": "QGIS (native c++)",
                    "output_parameter_name": "OUTPUT",
                    "outputs": [{"name": "OUTPUT", "description": "Buffered", "type": "outputVector"}],
                    "parameters": [
                        {"name": "INPUT", "description": "Input layer", "type": "source", "default_value": None, "optional": False, "is_destination": False},
                        {"name": "DISTANCE", "description": "Distance", "type": "distance", "default_value": 10, "optional": False, "is_destination": False},
                        {"name": "OUTPUT", "description": "Buffered", "type": "sink", "default_value": None, "optional": False, "is_destination": True},
                    ],
                }
            ],
        }

    async def run_processing_algorithm(algorithm_id: str, inputs: dict[str, Any], output_dir: Path | str):
        output_path = _from_qgis_runtime_path(Path(output_dir)) / "buffer_output.geojson"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "properties": {"distance": inputs.get("DISTANCE")},
                            "geometry": {"type": "Point", "coordinates": [13.4, 52.5]},
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return {
            "status": "completed",
            "resolved_outputs": {"OUTPUT": str(Path(output_dir) / "buffer_output.geojson")},
            "algorithm_ref": algorithm_id,
            "inputs": inputs,
        }

    app.state.qgis_runner.list_algorithms = algorithms
    app.state.qgis_runner.run_processing_algorithm = run_processing_algorithm
    app.state.qgis_runner.health = lambda: _async_value({"available": True})

    session = (await api_client.post("/api/v1/sessions")).json()
    run = app.state.store.create_run(session["id"], "工具测试")
    artifact = app.state.store.save_geojson_artifact(
        run_id=run.id,
        artifact_id="artifact_seed_buffer",
        name="种子输入",
        collection=_polygon_collection(),
        metadata={},
    )
    app.state.store.add_artifact_to_run(run.id, artifact)

    response = await api_client.post(
        "/api/v1/tools/run",
        json={
            "sessionId": session["id"],
            "runId": run.id,
            "toolName": "native:buffer",
            "toolKind": "qgis_algorithm",
            "args": {
                "INPUT": artifact.artifact_id,
                "DISTANCE": 125,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["artifact"] is not None
    assert payload["payload"]["inputs"]["DISTANCE"] == 125


async def _async_value(value: Any):
    return value
