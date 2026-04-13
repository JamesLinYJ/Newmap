from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from agent_core import GeoAgentRuntime
from gis_postgis import LayerCatalog, PostGISLayerCatalog, SpatialAnalysisService
from gis_common.geojson import load_geojson
from gis_common.ids import make_id, now_utc
from gis_qgis import QgisRuntimeClient
from map_publisher import MapPublisher
from model_adapters import ModelAdapterRegistry
from shared_types.schemas import ArtifactRef, EventType, PublishRequest, RunEvent, SystemComponentsStatus
from tool_registry import ExecutionContext
from tool_registry.registry import build_default_registry

from .basemap_catalog import BasemapCatalog
from .config import settings
from .store import FileStore

logger = logging.getLogger(__name__)


def _format_component_error(component: str, action: str, exc: Exception) -> str:
    return f"{component} {action} failed: {exc.__class__.__name__}: {exc}"

class AnalysisRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    query: str
    provider: str | None = None
    model: str | None = None


class QgisProcessRequest(BaseModel):
    algorithm_id: str = Field(..., alias="algorithmId")
    inputs: dict[str, object] = Field(default_factory=dict)
    artifact_id: str | None = Field(default=None, alias="artifactId")
    input_parameter_name: str | None = Field(default="INPUT", alias="inputParameterName")
    output_parameter_name: str | None = Field(default="OUTPUT", alias="outputParameterName")
    run_id: str | None = Field(default=None, alias="runId")
    save_as_artifact: bool = Field(default=False, alias="saveAsArtifact")
    result_name: str | None = Field(default=None, alias="resultName")


class QgisModelRequest(BaseModel):
    model_name: str = Field(..., alias="modelName")
    inputs: dict[str, object] = Field(default_factory=dict)
    artifact_id: str | None = Field(default=None, alias="artifactId")
    input_parameter_name: str | None = Field(default="INPUT", alias="inputParameterName")
    output_parameter_name: str | None = Field(default="output", alias="outputParameterName")
    run_id: str | None = Field(default=None, alias="runId")
    save_as_artifact: bool = Field(default=False, alias="saveAsArtifact")
    result_name: str | None = Field(default=None, alias="resultName")


def get_store() -> FileStore:
    return app.state.store


def get_catalog() -> LayerCatalog:
    return app.state.catalog


def get_runtime() -> GeoAgentRuntime:
    return app.state.runtime


@asynccontextmanager
async def lifespan(app: FastAPI):
    data_dir = settings.resolved_data_dir
    store = FileStore(data_dir)
    basemap_catalog = BasemapCatalog(data_dir, tianditu_api_key=settings.tianditu_api_key)
    basemap_catalog.ensure_schema()
    catalog: LayerCatalog = LayerCatalog(data_dir)
    if settings.database_url:
        try:
            postgis_catalog = PostGISLayerCatalog(data_dir, settings.database_url)
            postgis_catalog.ensure_schema()
            postgis_catalog.bootstrap_builtin_layers()
            catalog = postgis_catalog
            logger.info("PostGIS backend enabled.")
        except Exception as exc:
            logger.warning("PostGIS backend unavailable, fallback to file catalog: %s", _format_component_error("PostGIS", "startup", exc))
    spatial_service = SpatialAnalysisService(catalog, nominatim_base_url=settings.nominatim_base_url)
    qgis_runner = QgisRuntimeClient(settings.qgis_runtime_base_url)
    publisher = MapPublisher(
        settings.resolved_qgis_publish_dir,
        settings.qgis_server_base_url,
        app_base_url=settings.app_base_url,
        qgis_runtime=qgis_runner,
    )
    tool_registry = build_default_registry()
    runtime = GeoAgentRuntime(store=store, tool_registry=tool_registry, model_registry=ModelAdapterRegistry(settings))
    app.state.store = store
    app.state.basemap_catalog = basemap_catalog
    app.state.catalog = catalog
    app.state.spatial_service = spatial_service
    app.state.qgis_runner = qgis_runner
    app.state.publisher = publisher
    app.state.tool_registry = tool_registry
    app.state.runtime = runtime
    app.state.background_tasks = set()
    yield
    pending_tasks = list(app.state.background_tasks)
    for task in pending_tasks:
        if not task.done():
            task.cancel()
    if pending_tasks:
        await asyncio.gather(*pending_tasks, return_exceptions=True)


app = FastAPI(title="geo-agent-platform", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_base_url, "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/system/components")
async def system_components():
    qgis_runtime = await app.state.qgis_runner.health()
    qgis_server_available, ogc_api_available = await _qgis_server_capabilities()
    capabilities = ["geojson"]
    if qgis_server_available:
        capabilities.extend(["wms", "wfs"])
    if ogc_api_available:
        capabilities.append("ogc_api_features")
    return SystemComponentsStatus(
        catalog_backend=app.state.catalog.__class__.__name__,
        postgis_enabled=isinstance(app.state.catalog, PostGISLayerCatalog),
        qgis_runtime_available=bool(qgis_runtime.get("available")),
        qgis_server_available=qgis_server_available,
        ogc_api_available=ogc_api_available,
        publish_capabilities=capabilities,
        qgis_server_base_url=settings.qgis_server_base_url,
        providers=app.state.runtime.model_registry.descriptors(),
    )


@app.get("/api/v1/qgis/models")
async def list_qgis_models():
    health = await app.state.qgis_runner.health()
    if not health.get("available"):
        model_dir = settings.resolved_qgis_models_dir
        return {
            "available": False,
            "models": sorted(path.stem for path in model_dir.glob("*.model3")),
            "error": health.get("error"),
        }
    return await app.state.qgis_runner.list_models()


@app.post("/api/v1/qgis/process")
async def run_qgis_process(payload: QgisProcessRequest, store: FileStore = Depends(get_store)):
    health = await app.state.qgis_runner.health()
    if not health.get("available"):
        raise HTTPException(status_code=503, detail=health.get("error") or "QGIS runtime process run failed: runtime unavailable")
    output_dir = settings.resolved_data_dir / "artifacts" / "qgis-process"
    inputs = _resolve_qgis_inputs(dict(payload.inputs), store)
    if payload.artifact_id and payload.input_parameter_name:
        inputs[payload.input_parameter_name] = str(store.get_artifact_geojson_path(payload.artifact_id))
    if payload.output_parameter_name and payload.output_parameter_name not in inputs:
        suffix = ".geojson" if payload.save_as_artifact else ".gpkg"
        inputs[payload.output_parameter_name] = str(output_dir / f"{payload.algorithm_id.replace(':', '_')}_{make_id('output')}{suffix}")
    try:
        result = await app.state.qgis_runner.run_processing_algorithm(
            payload.algorithm_id,
            inputs,
            output_dir,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("QGIS runtime", f"run process '{payload.algorithm_id}'", exc)) from exc
    return await _maybe_attach_qgis_artifact(
        result=result,
        run_id=payload.run_id,
        save_as_artifact=payload.save_as_artifact,
        result_name=payload.result_name or payload.algorithm_id,
        store=store,
    )


@app.post("/api/v1/qgis/models/run")
async def run_qgis_model(payload: QgisModelRequest, store: FileStore = Depends(get_store)):
    health = await app.state.qgis_runner.health()
    if not health.get("available"):
        raise HTTPException(status_code=503, detail=health.get("error") or "QGIS runtime model run failed: runtime unavailable")
    output_dir = settings.resolved_data_dir / "artifacts" / "qgis-models"
    inputs = _resolve_qgis_inputs(dict(payload.inputs), store)
    if payload.artifact_id and payload.input_parameter_name:
        inputs[payload.input_parameter_name] = str(store.get_artifact_geojson_path(payload.artifact_id))
    if payload.output_parameter_name and payload.output_parameter_name not in inputs:
        suffix = ".geojson" if payload.save_as_artifact else ".gpkg"
        inputs[payload.output_parameter_name] = str(output_dir / f"{payload.model_name}_{make_id('output')}{suffix}")
    try:
        result = await app.state.qgis_runner.run_model(
            payload.model_name,
            inputs,
            output_dir,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("QGIS runtime", f"run model '{payload.model_name}'", exc)) from exc
    return await _maybe_attach_qgis_artifact(
        result=result,
        run_id=payload.run_id,
        save_as_artifact=payload.save_as_artifact,
        result_name=payload.result_name or payload.model_name,
        store=store,
    )


@app.post("/api/v1/sessions")
async def create_session(store: FileStore = Depends(get_store)):
    return store.create_session()


@app.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str, store: FileStore = Depends(get_store)):
    return store.get_session(session_id)


@app.get("/api/v1/sessions/{session_id}/runs")
async def list_session_runs(session_id: str, store: FileStore = Depends(get_store)):
    return store.list_runs_for_session(session_id)


@app.get("/api/v1/layers")
async def list_layers(catalog: LayerCatalog = Depends(get_catalog)):
    return catalog.list_layers()


@app.get("/api/v1/map/basemaps")
async def list_basemaps():
    return app.state.basemap_catalog.list_basemaps()


@app.get("/api/v1/providers")
async def list_providers(runtime: GeoAgentRuntime = Depends(get_runtime)):
    return runtime.model_registry.descriptors()


@app.get("/api/v1/geocode")
async def geocode(q: str = Query(..., alias="q")):
    try:
        return await asyncio.to_thread(app.state.spatial_service.geocode_place, q)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Spatial service", f"geocode '{q}'", exc)) from exc


@app.get("/api/v1/reverse-geocode")
async def reverse_geocode(lat: float, lng: float):
    try:
        return await asyncio.to_thread(app.state.spatial_service.reverse_geocode, lat, lng)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Spatial service", f"reverse geocode ({lat}, {lng})", exc)) from exc


@app.post("/api/v1/layers/register")
async def register_layer(
    session_id: Annotated[str, Form(...)],
    file: UploadFile = File(...),
    store: FileStore = Depends(get_store),
    catalog: LayerCatalog = Depends(get_catalog),
):
    payload = await file.read()
    try:
        descriptor = catalog.register_upload(session_id=session_id, filename=file.filename or "upload.geojson", payload=payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_format_component_error("Layer catalog", f"register upload '{file.filename or 'upload.geojson'}'", exc)) from exc
    store.update_session(session_id, latest_uploaded_layer_key=descriptor.layer_key)
    return descriptor


@app.post("/api/v1/chat")
async def chat(request: AnalysisRequest, store: FileStore = Depends(get_store), runtime: GeoAgentRuntime = Depends(get_runtime)):
    return await _start_run(request, store, runtime)


@app.post("/api/v1/analysis/run")
async def run_analysis(request: AnalysisRequest, store: FileStore = Depends(get_store), runtime: GeoAgentRuntime = Depends(get_runtime)):
    return await _start_run(request, store, runtime)


@app.get("/api/v1/analysis/{run_id}")
async def get_analysis_run(run_id: str, store: FileStore = Depends(get_store)):
    return store.get_run(run_id)


@app.get("/api/v1/analysis/{run_id}/artifacts")
async def get_analysis_artifacts(run_id: str, store: FileStore = Depends(get_store)):
    return store.list_artifacts(run_id)


@app.get("/api/v1/analysis/{run_id}/events")
async def stream_analysis_events(run_id: str, store: FileStore = Depends(get_store)):
    async def event_stream():
        seen_ids = set()
        for event in store.list_events(run_id):
            seen_ids.add(event.event_id)
            yield _format_sse(event)
        queue = store.subscribe(run_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event.event_id not in seen_ids:
                    seen_ids.add(event.event_id)
                    yield _format_sse(event)
                if event.type.value in {"run.completed", "run.failed"}:
                    break
        finally:
            store.unsubscribe(run_id, queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/v1/results/{artifact_id}/geojson")
async def get_result_geojson(artifact_id: str, store: FileStore = Depends(get_store)):
    return JSONResponse(store.get_artifact_collection(artifact_id))


@app.get("/api/v1/results/{artifact_id}/metadata")
async def get_result_metadata(artifact_id: str, store: FileStore = Depends(get_store)):
    artifact = store.get_artifact(artifact_id)
    metadata = store.get_artifact_metadata(artifact_id)
    return {"artifact": artifact, "metadata": metadata}


@app.post("/api/v1/results/{artifact_id}/publish")
async def publish_result(
    artifact_id: str,
    payload: PublishRequest,
    store: FileStore = Depends(get_store),
):
    artifact = store.get_artifact(artifact_id)
    collection = store.get_artifact_collection(artifact_id)
    try:
        result = await app.state.publisher.publish_artifact(
            artifact.artifact_id,
            artifact.name,
            payload.project_key or "demo-workspace",
            collection=collection,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Map publisher", f"publish artifact '{artifact_id}'", exc)) from exc
    return result


async def _start_run(request: AnalysisRequest, store: FileStore, runtime: GeoAgentRuntime):
    session = store.get_session(request.session_id)
    adapter = runtime.model_registry.resolve_provider(request.provider or settings.default_model_provider)
    model_name = request.model or adapter.default_model or settings.default_model_name
    provider_name = adapter.provider
    run = store.create_run(session.id, request.query, model_provider=provider_name, model_name=model_name)
    store.mark_run_running(run.id)

    def fixed_context_factory(*, run_id: str, session_id: str, latest_uploaded_layer_key: str | None):
        return ExecutionContext(
            run_id=run_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
            alias_map={},
            store=app.state.store,
            catalog=app.state.catalog,
            spatial_service=app.state.spatial_service,
            qgis_runner=app.state.qgis_runner,
            publisher=app.state.publisher,
        )

    runner = runtime.run(
        run_id=run.id,
        session_id=session.id,
        query=request.query,
        latest_uploaded_layer_key=session.latest_uploaded_layer_key,
        provider=provider_name,
        model_name=model_name,
        context_factory=fixed_context_factory,
    )
    if "PYTEST_CURRENT_TEST" in os.environ:
        await runner
        return store.get_run(run.id)

    task = asyncio.create_task(runner)
    app.state.background_tasks.add(task)
    task.add_done_callback(lambda finished: app.state.background_tasks.discard(finished))
    return store.get_run(run.id)


def _format_sse(event) -> str:
    data = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
    return f"id: {event.event_id}\ndata: {data}\n\n"


async def _maybe_attach_qgis_artifact(
    result: dict[str, object],
    *,
    run_id: str | None,
    save_as_artifact: bool,
    result_name: str,
    store: FileStore,
) -> dict[str, object]:
    if not save_as_artifact or not run_id or result.get("status") != "completed":
        return result

    output_path = None
    resolved_outputs = result.get("resolved_outputs", {})
    if isinstance(resolved_outputs, dict):
        for candidate in resolved_outputs.values():
            path = str(candidate)
            if path.endswith(".geojson") or path.endswith(".json"):
                output_path = path
                break
    if output_path is None:
        return result

    collection = load_geojson(Path(output_path))
    artifact = store.save_geojson_artifact(
        run_id=run_id,
        artifact_id=make_id("artifact"),
        name=result_name,
        collection=collection,
        metadata={"source": "qgis_process", "output_path": output_path, "feature_count": len(collection.get("features", []))},
    )
    store.add_artifact_to_run(run_id, artifact)
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            type=EventType.ARTIFACT_CREATED,
            message=f"QGIS 输出已保存为结果图层：{artifact.name}",
            timestamp=now_utc(),
            payload=artifact.model_dump(mode="json"),
        ),
    )
    return {**result, "artifact": artifact.model_dump(mode="json")}


async def _qgis_server_capabilities() -> tuple[bool, bool]:
    base_url = (settings.qgis_server_internal_base_url or settings.qgis_server_base_url).rstrip("/")
    project_key = app.state.publisher.default_project_key
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            wms_response = await client.get(
                f"{base_url}/ows/{project_key}/",
                params={"SERVICE": "WMS", "REQUEST": "GetCapabilities"},
            )
            ogc_response = await client.get(f"{base_url}/ogc/{project_key}/collections")
            if ogc_response.status_code == 404 or "ServiceExceptionReport" in ogc_response.text:
                ogc_response = await client.get(f"{base_url}/ogc/{project_key}/ogcapi/collections")
    except Exception as exc:
        logger.warning("QGIS server capability probe failed: %s", _format_component_error("QGIS server", "capability probe", exc))
        return False, False
    ogc_available = ogc_response.is_success and "ServiceExceptionReport" not in ogc_response.text
    return wms_response.is_success, ogc_available


def _resolve_qgis_inputs(inputs: dict[str, object], store: FileStore) -> dict[str, object]:
    resolved: dict[str, object] = {}
    for key, value in inputs.items():
        if isinstance(value, str) and value.startswith("artifact:"):
            artifact_id = value.split(":", 1)[1]
            resolved[key] = str(store.get_artifact_geojson_path(artifact_id))
        else:
            resolved[key] = value
    return resolved
