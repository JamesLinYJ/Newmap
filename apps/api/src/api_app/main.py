# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 服务入口
#
#   文件:       main.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from json import JSONDecodeError
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from agent_core import GeoAgentRuntime
from gis_postgis import PostGISLayerRepository, SpatialAnalysisService
from gis_common.geojson import load_geojson, save_geojson
from gis_common.ids import make_id, now_utc
from gis_qgis import QgisRuntimeClient
from map_publisher import MapPublisher
from model_adapters import ModelAdapterRegistry
from shared_types.schemas import ArtifactRef, EventType, PublishRequest, RunEvent, SystemComponentsStatus, ToolCall, ToolDescriptor
from tool_registry import ToolExecutionResult, ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore
from tool_registry.registry import build_default_registry

from .artifact_store import ArtifactExportStore
from .basemap_catalog import BasemapCatalog
from .config import settings
from .platform_store import PostgresPlatformStore
from .tool_catalog import ToolCatalogStore, build_qgis_algorithm_descriptors, build_qgis_model_descriptors, build_registry_tool_descriptors

logger = logging.getLogger(__name__)


# 组件错误格式化
#
# 将底层异常统一整理为稳定的字符串，便于日志、接口 detail 和调试页同时复用。
def _format_component_error(component: str, action: str, exc: Exception) -> str:
    return f"{component} {action} failed: {exc.__class__.__name__}: {exc}"


def _build_allowed_origins(*origins: str) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for origin in origins:
        candidate = origin.strip().rstrip("/")
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        normalized.append(candidate)
    return normalized


# AnalysisRequest
#
# 一次自然语言空间分析请求的基础输入。
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


class ToolRunRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    tool_name: str = Field(..., alias="toolName")
    tool_kind: str = Field(default="registry", alias="toolKind")
    run_id: str | None = Field(default=None, alias="runId")
    args: dict[str, object] = Field(default_factory=dict)


class ToolCatalogEntryUpsertRequest(BaseModel):
    payload: dict[str, object] = Field(default_factory=dict)
    sort_order: int | None = Field(default=None, alias="sortOrder")


# 依赖注入访问器
#
# 这些函数从 FastAPI 应用状态中提取共享服务实例。
def get_store() -> PostgresPlatformStore:
    return app.state.store


def get_layer_repository() -> PostGISLayerRepository:
    return app.state.layer_repository


def get_runtime() -> GeoAgentRuntime:
    return app.state.runtime


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 应用装配入口
    #
    # 这里是整个 API 进程的组装根：
    # 1. 强制以 Postgres/PostGIS 作为唯一持久化主线。
    # 2. 初始化 basemap、tool catalog、publisher、qgis runtime client。
    # 3. 装配 Agent runtime 与后台任务容器。
    # 这样其余路由只依赖 app.state，不必重复知道底层组件如何连接。
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is required. Postgres/PostGIS is now the only supported persistence backend.")

    runtime_root = settings.resolved_runtime_root
    runtime_root.mkdir(parents=True, exist_ok=True)
    basemap_catalog = BasemapCatalog(tianditu_api_key=settings.tianditu_api_key)
    basemap_catalog.ensure_schema()
    layer_repository = PostGISLayerRepository(database_url=settings.database_url, seed_dir=settings.resolved_seed_layers_dir)
    layer_repository.ensure_schema()
    layer_repository.bootstrap_seed_layers()
    artifact_export_store = ArtifactExportStore(runtime_root)
    store = PostgresPlatformStore(settings.database_url, artifact_store=artifact_export_store)
    store.ensure_schema()
    spatial_service = SpatialAnalysisService(layer_repository, nominatim_base_url=settings.nominatim_base_url)
    qgis_runner = QgisRuntimeClient(settings.qgis_runtime_base_url)
    publisher = MapPublisher(
        settings.resolved_qgis_publish_dir,
        settings.qgis_server_base_url,
        app_base_url=settings.app_base_url,
        qgis_runtime=qgis_runner,
    )
    tool_registry = build_default_registry()
    tool_catalog_store = ToolCatalogStore(settings.database_url)
    tool_catalog_store.ensure_schema(registry=tool_registry)
    runtime = GeoAgentRuntime(store=store, tool_registry=tool_registry, model_registry=ModelAdapterRegistry(settings))
    app.state.store = store
    app.state.platform_store = store
    app.state.basemap_catalog = basemap_catalog
    app.state.layer_repository = layer_repository
    app.state.catalog = layer_repository
    app.state.artifact_export_store = artifact_export_store
    app.state.spatial_service = spatial_service
    app.state.qgis_runner = qgis_runner
    app.state.publisher = publisher
    app.state.tool_registry = tool_registry
    app.state.tool_catalog_store = tool_catalog_store
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
    allow_origins=_build_allowed_origins(settings.web_base_url, "http://localhost:5173", "http://127.0.0.1:5173"),
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
        catalog_backend=app.state.layer_repository.__class__.__name__,
        postgis_enabled=True,
        qgis_runtime_available=bool(qgis_runtime.get("available")),
        qgis_server_available=qgis_server_available,
        ogc_api_available=ogc_api_available,
        publish_capabilities=capabilities,
        qgis_server_base_url=settings.qgis_server_base_url,
        providers=app.state.runtime.model_registry.descriptors(),
    )


@app.get("/api/v1/qgis/models")
async def list_qgis_models():
    # QGIS 模型发现
    #
    # runtime 不可用时回退到本地模型目录，以保证调试入口仍可见模型清单。
    health = await app.state.qgis_runner.health()
    model_dir = settings.resolved_qgis_models_dir
    if not health.get("available"):
        return {
            "available": False,
            "models": sorted(path.stem for path in model_dir.glob("*.model3")),
            "error": health.get("error"),
        }
    try:
        return await app.state.qgis_runner.list_models()
    except Exception as exc:
        return {
            "available": False,
            "models": sorted(path.stem for path in model_dir.glob("*.model3")),
            "error": str(exc).strip() or _format_component_error("QGIS runtime", "list models", exc),
        }


@app.get("/api/v1/qgis/algorithms")
async def list_qgis_algorithms():
    # QGIS 算法发现
    #
    # 返回值已经被转换成前端直接消费的 ToolDescriptor，并叠加 Postgres override。
    # 这里故意不把 QGIS 原生 registry 结构直接透给前端，避免 UI 层绑死在
    # qgis_process 细节上，也方便继续在目录层做中文化和参数修饰。
    catalog = app.state.tool_catalog_store.load_catalog()
    health = await app.state.qgis_runner.health()
    if not health.get("available"):
        return {
            "available": False,
            "algorithms": build_qgis_algorithm_descriptors([], available=False, error=health.get("error"), catalog=catalog),
            "error": health.get("error"),
        }
    try:
        payload = await app.state.qgis_runner.list_algorithms()
        algorithms = build_qgis_algorithm_descriptors(
            payload.get("algorithms", []),
            available=bool(payload.get("available", True)),
            error=str(payload.get("error")) if payload.get("error") else None,
            catalog=catalog,
        )
        return {"available": bool(payload.get("available", True)), "algorithms": algorithms}
    except Exception as exc:
        return {
            "available": False,
            "algorithms": build_qgis_algorithm_descriptors([], available=False, error=str(exc).strip(), catalog=catalog),
            "error": str(exc).strip() or _format_component_error("QGIS runtime", "list algorithms", exc),
        }


@app.get("/api/v1/tools")
async def list_tools() -> list[ToolDescriptor]:
    # 工具聚合视图
    #
    # 最终工具全集由三部分组成：
    # registry tools + discovered qgis algorithms + discovered qgis models。
    # Postgres catalog 在这里是展示 override 层，而不是唯一真相源。
    # 这样既保留动态发现能力，也允许在不改代码的情况下微调分组和参数体验。
    catalog = app.state.tool_catalog_store.load_catalog()
    qgis_algorithms = await list_qgis_algorithms()
    qgis_models = await list_qgis_models()
    registry_tools = build_registry_tool_descriptors(app.state.tool_registry, catalog)
    qgis_tooling = list(qgis_algorithms.get("algorithms", [])) + build_qgis_model_descriptors(
        qgis_models.get("models", []),
        available=bool(qgis_models.get("available")),
        error=str(qgis_models.get("error")) if qgis_models.get("error") else None,
        catalog=catalog,
    )
    return sorted([*registry_tools, *qgis_tooling], key=lambda item: (item.group, item.tool_kind, item.label))


@app.get("/api/v1/tools/catalog")
async def list_tool_catalog_entries():
    return app.state.tool_catalog_store.list_entries()


@app.put("/api/v1/tools/catalog/{tool_kind}/{tool_name:path}")
async def upsert_tool_catalog_entry(tool_kind: str, tool_name: str, payload: ToolCatalogEntryUpsertRequest):
    entry = app.state.tool_catalog_store.upsert_entry(
        tool_name=tool_name,
        tool_kind=tool_kind,
        payload=dict(payload.payload),
        sort_order=payload.sort_order,
    )
    return entry


@app.delete("/api/v1/tools/catalog/{tool_kind}/{tool_name:path}")
async def delete_tool_catalog_entry(tool_kind: str, tool_name: str):
    deleted = app.state.tool_catalog_store.delete_entry(tool_name=tool_name, tool_kind=tool_kind)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Tool catalog entry not found: {tool_kind}/{tool_name}")
    return {"deleted": True, "toolName": tool_name, "toolKind": tool_kind}


@app.post("/api/v1/tools/run")
async def run_tool(payload: ToolRunRequest, store: PostgresPlatformStore = Depends(get_store)):
    # 通用工具执行入口
    #
    # 为调试页和内部自动化统一提供单一的工具调用接口。
    # 如果调用方没有 run_id，这里会自动创建一个“工具调用 run”，
    # 让工具执行也能完整写入 run / event / artifact 三条索引链。
    session = store.get_session(payload.session_id)
    run = store.get_run(payload.run_id) if payload.run_id else store.create_run(session.id, f"工具调用：{payload.tool_name}")
    if not payload.run_id:
        store.mark_run_running(run.id)

    try:
        result = await _execute_tool_request(payload, run_id=run.id, session_id=session.id, latest_uploaded_layer_key=session.latest_uploaded_layer_key)
        updated_run = _apply_tool_result_to_run(
            store,
            run_id=run.id,
            tool_name=payload.tool_name,
            args=dict(payload.args),
            result=result,
            tool_kind=payload.tool_kind,
        )
        return {
            "run": updated_run.model_dump(mode="json"),
            "tool": payload.tool_name,
            "toolKind": payload.tool_kind,
            "message": result.message,
            "artifact": result.artifact.model_dump(mode="json") if result.artifact else None,
            "payload": result.payload,
            "warnings": result.warnings,
        }
    except HTTPException as exc:
        _record_tool_failure(store, run_id=run.id, tool_name=payload.tool_name, args=dict(payload.args), tool_kind=payload.tool_kind, exc=Exception(str(exc.detail)))
        raise
    except Exception as exc:
        _record_tool_failure(store, run_id=run.id, tool_name=payload.tool_name, args=dict(payload.args), tool_kind=payload.tool_kind, exc=exc)
        raise HTTPException(
            status_code=400 if isinstance(exc, (ValueError, KeyError, JSONDecodeError, ValidationError)) else 503,
            detail=str(exc).strip() or _format_component_error("Tool runner", payload.tool_name, exc),
        ) from exc


@app.post("/api/v1/qgis/process")
async def run_qgis_process(
    payload: QgisProcessRequest,
    store: PostgresPlatformStore = Depends(get_store),
):
    return await _execute_qgis_process(payload, store=store)


async def _execute_qgis_process(
    payload: QgisProcessRequest,
    *,
    store: PostgresPlatformStore,
    source_parameter_names: set[str] | None = None,
):
    # 直接执行 QGIS Processing algorithm。
    #
    # 这条接口绕过 Agent 计划层，适合调试页直接验证单个算法。
    # 输入里的 artifact 引用、catalog 图层或相对路径，都会先在 API 层统一
    # 解析成 qgis-runtime 真正可读取的输入形式。
    health = await app.state.qgis_runner.health()
    if not health.get("available"):
        raise HTTPException(status_code=503, detail=health.get("error") or "QGIS runtime process run failed: runtime unavailable")
    output_dir = settings.resolved_runtime_root / "artifacts" / "qgis-process"
    inputs = _resolve_qgis_inputs(dict(payload.inputs), store, source_parameter_names=source_parameter_names)
    if payload.artifact_id and payload.input_parameter_name:
        inputs[payload.input_parameter_name] = _to_qgis_runtime_path(store.get_artifact_geojson_path(payload.artifact_id))
    if payload.output_parameter_name and payload.output_parameter_name not in inputs:
        suffix = ".geojson" if payload.save_as_artifact else ".gpkg"
        inputs[payload.output_parameter_name] = _to_qgis_runtime_path(output_dir / f"{payload.algorithm_id.replace(':', '_')}_{make_id('output')}{suffix}")
    try:
        result = await app.state.qgis_runner.run_processing_algorithm(
            payload.algorithm_id,
            inputs,
            _to_qgis_runtime_path(output_dir),
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
async def run_qgis_model(payload: QgisModelRequest, store: PostgresPlatformStore = Depends(get_store)):
    # 直接执行 QGIS model3。
    #
    # 与 Processing algorithm 分开保留接口，是因为 model3 往往承载团队自己的
    # 业务工作流，调试时需要单独观察它的输入约定与输出行为。
    health = await app.state.qgis_runner.health()
    if not health.get("available"):
        raise HTTPException(status_code=503, detail=health.get("error") or "QGIS runtime model run failed: runtime unavailable")
    output_dir = settings.resolved_runtime_root / "artifacts" / "qgis-models"
    inputs = _resolve_qgis_inputs(dict(payload.inputs), store, source_parameter_names=None)
    if payload.artifact_id and payload.input_parameter_name:
        inputs[payload.input_parameter_name] = _to_qgis_runtime_path(store.get_artifact_geojson_path(payload.artifact_id))
    if payload.output_parameter_name and payload.output_parameter_name not in inputs:
        suffix = ".geojson" if payload.save_as_artifact else ".gpkg"
        inputs[payload.output_parameter_name] = _to_qgis_runtime_path(output_dir / f"{payload.model_name}_{make_id('output')}{suffix}")
    try:
        result = await app.state.qgis_runner.run_model(
            payload.model_name,
            inputs,
            _to_qgis_runtime_path(output_dir),
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
async def create_session(store: PostgresPlatformStore = Depends(get_store)):
    return store.create_session()


@app.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_session(session_id)


@app.get("/api/v1/sessions/{session_id}/runs")
async def list_session_runs(session_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.list_runs_for_session(session_id)


@app.get("/api/v1/layers")
async def list_layers(layer_repository: PostGISLayerRepository = Depends(get_layer_repository)):
    return layer_repository.list_layers()


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
    store: PostgresPlatformStore = Depends(get_store),
    catalog: PostGISLayerRepository = Depends(get_layer_repository),
):
    payload = await _read_upload_payload(file, max_bytes=settings.upload_max_bytes)
    try:
        descriptor = catalog.register_upload(session_id=session_id, filename=file.filename or "upload.geojson", payload=payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_format_component_error("Layer catalog", f"register upload '{file.filename or 'upload.geojson'}'", exc)) from exc
    store.update_session(session_id, latest_uploaded_layer_key=descriptor.layer_key)
    return descriptor


@app.post("/api/v1/chat")
async def chat(request: AnalysisRequest, store: PostgresPlatformStore = Depends(get_store), runtime: GeoAgentRuntime = Depends(get_runtime)):
    return await _start_run(request, store, runtime)


@app.post("/api/v1/analysis/run")
async def run_analysis(request: AnalysisRequest, store: PostgresPlatformStore = Depends(get_store), runtime: GeoAgentRuntime = Depends(get_runtime)):
    return await _start_run(request, store, runtime)


@app.get("/api/v1/analysis/{run_id}")
async def get_analysis_run(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_run(run_id)


@app.get("/api/v1/analysis/{run_id}/artifacts")
async def get_analysis_artifacts(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.list_artifacts(run_id)


@app.get("/api/v1/analysis/{run_id}/events")
async def stream_analysis_events(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
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
async def get_result_geojson(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return JSONResponse(store.get_artifact_collection(artifact_id))


@app.get("/api/v1/results/{artifact_id}/metadata")
async def get_result_metadata(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    artifact = store.get_artifact(artifact_id)
    metadata = store.get_artifact_metadata(artifact_id)
    return {"artifact": artifact, "metadata": metadata}


@app.post("/api/v1/results/{artifact_id}/publish")
async def publish_result(
    artifact_id: str,
    payload: PublishRequest,
    store: PostgresPlatformStore = Depends(get_store),
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
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Map publisher", f"publish artifact '{artifact_id}'", exc)) from exc
    persisted_result = {"artifactId": artifact_id, **result}
    store.update_artifact_metadata(artifact_id, publishResult=persisted_result)
    return persisted_result


async def _start_run(request: AnalysisRequest, store: PostgresPlatformStore, runtime: GeoAgentRuntime):
    # 分析任务启动器
    #
    # 统一负责：
    # 1. 解析 provider / model 默认值。
    # 2. 创建 run 并标记 running。
    # 3. 在测试环境同步执行，在开发/生产环境切到后台任务。
    session = store.get_session(request.session_id)
    adapter = runtime.model_registry.resolve_provider(request.provider or settings.default_model_provider)
    model_name = request.model or adapter.default_model or settings.default_model_name
    provider_name = adapter.provider
    run = store.create_run(session.id, request.query, model_provider=provider_name, model_name=model_name)
    store.mark_run_running(run.id)

    runner = runtime.run(
        run_id=run.id,
        session_id=session.id,
        query=request.query,
        latest_uploaded_layer_key=session.latest_uploaded_layer_key,
        provider=provider_name,
        model_name=model_name,
        context_factory=_build_tool_runtime,
    )
    if "PYTEST_CURRENT_TEST" in os.environ:
        await runner
        return store.get_run(run.id)

    task = asyncio.create_task(runner)
    app.state.background_tasks.add(task)
    task.add_done_callback(lambda finished: app.state.background_tasks.discard(finished))
    return store.get_run(run.id)


def _build_tool_runtime(*, run_id: str, session_id: str, latest_uploaded_layer_key: str | None) -> ToolRuntime:
    # ToolRuntime 组装器
    #
    # 将运行时拆成 context、state、store 三层，避免职责继续堆叠在单个对象上。
    # context 放本次调用不可变信息；state 放 alias 与最近结果；
    # store 放 catalog、publisher、qgis runner 这类持久依赖。
    return ToolRuntime(
        context=ToolRuntimeContext(
            run_id=run_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        ),
        state=ToolRuntimeState(alias_map=_load_run_alias_map(app.state.store, run_id)),
        store=ToolRuntimeStore(
            platform_store=app.state.platform_store,
            layer_repository=app.state.layer_repository,
            artifact_export_store=app.state.artifact_export_store,
            spatial_service=app.state.spatial_service,
            qgis_runner=app.state.qgis_runner,
            publisher=app.state.publisher,
            runtime_root=settings.resolved_runtime_root,
        ),
    )


def _load_run_alias_map(store: PostgresPlatformStore, run_id: str) -> dict[str, dict[str, object]]:
    # 运行状态恢复
    #
    # 根据既有 run 与 artifact metadata 恢复 alias、artifact 名称和集合引用，
    # 让连续工具调用能够使用人类可读的引用名。
    # 这里会同时注册 artifact_id、artifact.name 和 metadata.alias，
    # 因为用户、调试页和 agent 在不同阶段可能引用的是不同名字。
    alias_map: dict[str, dict[str, object]] = {}
    try:
        run = store.get_run(run_id)
    except HTTPException:
        return alias_map

    for artifact in run.state.artifacts:
        try:
            collection = store.get_artifact_collection(artifact.artifact_id)
            alias_map[artifact.artifact_id] = collection
            alias_map[artifact.name] = collection
            metadata = store.get_artifact_metadata(artifact.artifact_id)
            alias = metadata.get("alias")
            if isinstance(alias, str) and alias.strip():
                alias_map[alias.strip()] = collection
        except HTTPException:
            continue
    return alias_map


async def _execute_tool_request(payload: ToolRunRequest, *, run_id: str, session_id: str, latest_uploaded_layer_key: str | None) -> ToolExecutionResult:
    # 工具请求分发器
    #
    # registry 工具走 ToolRegistry；QGIS 工具走专门执行分支。
    # 这样工具调用虽然统一暴露成一个入口，但不同类型仍保留最合适的运行语义。
    if payload.tool_kind == "registry":
        runtime = _build_tool_runtime(run_id=run_id, session_id=session_id, latest_uploaded_layer_key=latest_uploaded_layer_key)
        return await app.state.tool_registry.execute(payload.tool_name, dict(payload.args), runtime)

    if payload.tool_kind == "qgis_algorithm":
        return await _run_qgis_algorithm_tool(payload, run_id=run_id)

    if payload.tool_kind == "qgis_model":
        return await _run_qgis_model_tool(payload, run_id=run_id)

    raise ValueError(f"不支持的工具类型：{payload.tool_kind}")


async def _run_qgis_algorithm_tool(payload: ToolRunRequest, *, run_id: str) -> ToolExecutionResult:
    # 动态 QGIS algorithm 执行器
    #
    # 从 runtime 发现结果中读取参数元数据，自动推断哪些字段需要做图层/结果解析。
    # ToolDescriptor 只负责描述参数和 UI；真正执行时仍需要在这里把通用 args
    # 还原成 QGIS algorithm request，并统一补齐 artifact 保存与结果命名策略。
    tool_args = dict(payload.args)
    available_algorithms = await app.state.qgis_runner.list_algorithms()
    algorithm = next((item for item in available_algorithms.get("algorithms", []) if item.get("id") == payload.tool_name), None)
    if algorithm is None:
        raise ValueError(f"未发现 QGIS Processing 算法：{payload.tool_name}")

    source_parameter_names = {
        str(parameter.get("name"))
        for parameter in algorithm.get("parameters", [])
        if str(parameter.get("type") or "") in {"source", "vector", "raster"}
    }
    inputs: dict[str, object] = {}
    for key, value in tool_args.items():
        if key in {"save_as_artifact", "result_name"}:
            continue
        if isinstance(value, str) and value.strip().startswith(("{", "[")):
            try:
                inputs[str(key)] = json.loads(value)
                continue
            except json.JSONDecodeError:
                pass
        inputs[str(key)] = value
    result = await _execute_qgis_process(
        QgisProcessRequest(
            algorithmId=payload.tool_name,
            runId=run_id,
            saveAsArtifact=bool(tool_args.get("save_as_artifact", True)),
            resultName=str(tool_args.get("result_name") or f"QGIS 算法：{payload.tool_name}"),
            outputParameterName=str(algorithm.get("output_parameter_name") or "OUTPUT"),
            inputs=inputs,
        ),
        store=app.state.store,
        source_parameter_names=source_parameter_names,
    )
    if result.get("status") == "failed":
        raise RuntimeError(str(result.get("error") or f"QGIS 算法 {payload.tool_name} 执行失败。"))
    artifact = _coerce_artifact_ref(result.get("artifact"))
    return ToolExecutionResult(message=f"已调用 QGIS 算法 {payload.tool_name}。", artifact=artifact, payload=result)


async def _run_qgis_model_tool(payload: ToolRunRequest, *, run_id: str) -> ToolExecutionResult:
    # QGIS model3 执行器
    #
    # 模型的输入结构允许更强的业务化约束，因此仍保留少量专用字段转换。
    # 例如 overlay_artifact_id 和 distance 这类字段，调试页不必知道模型内部
    # 真实输入名，只需要按平台约定传更高层的参数。
    tool_args = dict(payload.args)
    inputs = _coerce_json_inputs(tool_args.get("inputs_json"))

    overlay_artifact_id = tool_args.get("overlay_artifact_id")
    if overlay_artifact_id:
        inputs["OVERLAY"] = f"artifact:{overlay_artifact_id}"
    if "distance" in tool_args and tool_args["distance"] not in (None, ""):
        inputs["DISTANCE"] = float(tool_args["distance"])

    result = await run_qgis_model(
        QgisModelRequest(
            modelName=payload.tool_name,
            artifactId=str(tool_args["artifact_id"]),
            runId=run_id,
            saveAsArtifact=bool(tool_args.get("save_as_artifact", True)),
            resultName=str(tool_args.get("result_name") or f"QGIS 模型：{payload.tool_name}"),
            outputParameterName="output",
            inputs=inputs,
        ),
        app.state.store,
    )
    if result.get("status") == "failed":
        raise RuntimeError(str(result.get("error") or f"QGIS 模型 {payload.tool_name} 执行失败。"))
    artifact = _coerce_artifact_ref(result.get("artifact"))
    return ToolExecutionResult(message=f"已调用 QGIS 模型 {payload.tool_name}。", artifact=artifact, payload=result)


def _coerce_json_inputs(value: object) -> dict[str, object]:
    # JSON 参数容错解析
    #
    # 调试页表单会把 JSON 文本当作字符串传过来，这里统一负责把字符串、
    # 已解析对象或空值收敛成 dict，避免执行分支各自重复写解析逻辑。
    if value in (None, "", {}):
        return {}
    if isinstance(value, dict):
        return {str(key): val for key, val in value.items()}
    if isinstance(value, str):
        parsed = json.loads(value)
        if not isinstance(parsed, dict):
            raise ValueError("inputsJson 必须是 JSON 对象。")
        return {str(key): val for key, val in parsed.items()}
    raise ValueError("inputsJson 必须是 JSON 对象。")


def _coerce_artifact_ref(value: object) -> ArtifactRef | None:
    if not isinstance(value, dict):
        return None
    return ArtifactRef.model_validate(value)


def _apply_tool_result_to_run(
    store: PostgresPlatformStore,
    *,
    run_id: str,
    tool_name: str,
    args: dict[str, object],
    result: ToolExecutionResult,
    tool_kind: str,
):
    # 工具结果回灌
    #
    # 同步更新 run、artifact 列表与事件流，保证调试台可以立即看到执行结果。
    # 这样“直接跑工具”和“走 Agent 计划执行”虽然来源不同，但最终都能落成
    # 前端熟悉的 run.state / event stream 结构。
    run = store.get_run(run_id)
    tool_results = list(run.state.tool_results)
    tool_results.append(
        ToolCall(
            step_id=make_id("step"),
            tool=f"{tool_kind}:{tool_name}",
            args=args,
            status="completed",
            message=result.message,
            started_at=now_utc(),
            completed_at=now_utc(),
        )
    )
    artifacts = list(run.state.artifacts)
    if result.artifact and not any(item.artifact_id == result.artifact.artifact_id for item in artifacts):
        artifacts.append(result.artifact)
    updated_run = store.update_run_state(
        run_id,
        status="completed",
        tool_results=tool_results,
        artifacts=artifacts,
        warnings=[*run.state.warnings, *result.warnings],
    )
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            type=EventType.STEP_COMPLETED,
            message=result.message,
            timestamp=now_utc(),
            payload={"tool": tool_name, "toolKind": tool_kind, "artifact": result.artifact.model_dump(mode="json") if result.artifact else None},
        ),
    )
    return updated_run


def _record_tool_failure(
    store: PostgresPlatformStore,
    *,
    run_id: str,
    tool_name: str,
    args: dict[str, object],
    tool_kind: str,
    exc: Exception,
) -> None:
    # 工具失败落账
    #
    # 失败时显式写入 run 状态与事件流，而不是仅靠异常向外冒泡。
    # 这样即便 HTTP 请求已经结束，后续仍能在历史 run 和调试页里复盘失败原因。
    try:
        run = store.get_run(run_id)
    except HTTPException:
        return

    tool_results = list(run.state.tool_results)
    tool_results.append(
        ToolCall(
            step_id=make_id("step"),
            tool=f"{tool_kind}:{tool_name}",
            args=args,
            status="failed",
            message=str(exc),
            started_at=now_utc(),
            completed_at=now_utc(),
        )
    )
    errors = [*run.state.errors, str(exc)]
    store.update_run_state(run_id, status="failed", tool_results=tool_results, errors=errors, failed_tool=tool_name)
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            type=EventType.RUN_FAILED,
            message=str(exc),
            timestamp=now_utc(),
            payload={"tool": tool_name, "toolKind": tool_kind, "errors": errors},
        ),
    )


def _format_sse(event) -> str:
    data = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
    return f"id: {event.event_id}\ndata: {data}\n\n"


async def _read_upload_payload(file: UploadFile, *, max_bytes: int) -> bytes:
    # 分块读取上传文件，避免无上限 read()。
    #
    # 这样既能限制内存占用，也能在超过上限时尽早抛出 413，而不是等整文件读完。
    total = 0
    chunks: list[bytes] = []
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=f"上传文件过大，当前限制为 {max_bytes // (1024 * 1024)} MB。")
        chunks.append(chunk)
    return b"".join(chunks)


async def _maybe_attach_qgis_artifact(
    result: dict[str, object],
    *,
    run_id: str | None,
    save_as_artifact: bool,
    result_name: str,
    store: PostgresPlatformStore,
) -> dict[str, object]:
    # QGIS 结果转 artifact
    #
    # qgis-runtime 返回值里既可能只有执行日志，也可能已经包含输出文件路径。
    # 这里只有在 save_as_artifact=true 且输出文件真实存在时，才补建 artifact 索引。
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

    collection = load_geojson(_from_qgis_runtime_path(Path(output_path)))
    result_descriptor = app.state.layer_repository.save_result_layer(run_id, result_name, result_name, collection)
    artifact = store.save_geojson_artifact(
        run_id=run_id,
        artifact_id=make_id("artifact"),
        name=result_name,
        collection=collection,
        metadata={
            "source": "qgis_process",
            "output_path": output_path,
            "feature_count": len(collection.get("features", [])),
            "result_layer_key": result_descriptor.layer_key,
        },
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
    # QGIS Server / OGC API 能力探测
    #
    # 这里只回答“在线否、基础能力是否存在”，不做更深的巡检，
    # 避免系统状态页因为探测过重而拖慢。
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


def _resolve_qgis_inputs(
    inputs: dict[str, object],
    store: PostgresPlatformStore,
    *,
    source_parameter_names: set[str] | None,
) -> dict[str, object]:
    # QGIS 输入解析
    #
    # 将 artifact id、catalog layer key 和本地路径等高层引用统一解析为 runtime 可读取的输入值。
    # 调试页和工具工作台允许用户传更贴近业务的引用名，这里负责把它们收敛成
    # qgis_process 真正需要的路径或原始值。
    resolved: dict[str, object] = {}
    for key, value in inputs.items():
        if not isinstance(value, str):
            resolved[key] = value
            continue
        if source_parameter_names is not None and key not in source_parameter_names:
            resolved[key] = value
            continue
        if value.startswith("artifact:"):
            artifact_id = value.split(":", 1)[1]
            resolved[key] = _to_qgis_runtime_path(store.get_artifact_geojson_path(artifact_id))
            continue
        try:
            resolved[key] = _to_qgis_runtime_path(store.get_artifact_geojson_path(value))
            continue
        except HTTPException:
            pass
        if _looks_like_local_path(value):
            resolved[key] = value
            continue
        try:
            app.state.layer_repository.get_layer_descriptor(value)
        except Exception:
            resolved[key] = value
            continue
        resolved[key] = _to_qgis_runtime_path(_materialize_catalog_layer_for_qgis(value))
    return resolved


def _materialize_catalog_layer_for_qgis(layer_key: str) -> Path:
    # Catalog 图层物化
    #
    # 对非本地文件图层先导出 GeoJSON，再交给 qgis-runtime 使用。
    # 这是 API 层与 catalog 抽象的桥接点，避免把“如何导出给 QGIS”这件事泄漏到上层。
    collection = app.state.spatial_service.load_layer(layer_key)
    output_dir = settings.resolved_runtime_root / "artifacts" / "qgis-inputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{layer_key}_{make_id('layer')}.geojson"
    save_geojson(output_path, collection)
    return output_path


def _looks_like_local_path(value: str) -> bool:
    candidate = Path(value)
    return candidate.is_absolute() or value.startswith("./") or value.startswith("../")


def _to_qgis_runtime_path(path: Path) -> str:
    return str(path.resolve())


def _from_qgis_runtime_path(path: Path) -> Path:
    return path.resolve()
