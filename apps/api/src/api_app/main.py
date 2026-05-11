# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 服务入口
#
#   文件:       main.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 装配 FastAPI、GIS 运行时、事件流、审批流和对外 API 路由，是整个平台的 HTTP 入口。
#
# 路由已按领域拆分到 routers/ 子包中，main.py 仅保留 app 创建、lifespan 装配与中间件。

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agent_core import GeoAgentRuntime
from gis_postgis import PostGISLayerRepository, SpatialAnalysisService
from gis_qgis import QgisRuntimeClient
from map_publisher import MapPublisher
from model_adapters import ModelAdapterRegistry
from tool_registry.registry import build_default_registry

from .artifact_store import ArtifactExportStore
from .basemap_catalog import BasemapCatalog
from .config import settings
from .dependencies import _build_allowed_origins
from .platform_store import PostgresPlatformStore
from .tool_catalog import ToolCatalogStore

from .routers import (
    health,
    system,
    sessions,
    threads,
    runs,
    analysis,
    layers,
    tools,
    qgis,
    results,
    config_routes,
    geo,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database_url = settings.effective_database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL is required. Postgres/PostGIS is now the only supported persistence backend.")

    runtime_root = settings.resolved_runtime_root
    runtime_root.mkdir(parents=True, exist_ok=True)
    basemap_catalog = BasemapCatalog(tianditu_api_key=settings.tianditu_api_key)
    basemap_catalog.ensure_schema()
    layer_repository = PostGISLayerRepository(database_url=database_url, seed_dir=settings.resolved_seed_layers_dir)
    layer_repository.ensure_schema()
    artifact_export_store = ArtifactExportStore(runtime_root)
    store = PostgresPlatformStore(database_url, artifact_store=artifact_export_store)
    store.ensure_schema()
    runtime_config = store.get_runtime_config()
    spatial_service = SpatialAnalysisService(
        layer_repository,
        geosearch_config=runtime_config.geosearch.model_copy(
            update={"base_url": runtime_config.geosearch.base_url or settings.nominatim_base_url}
        ),
        poi_config=runtime_config.external_poi,
    )
    qgis_runner = QgisRuntimeClient(settings.qgis_runtime_base_url)
    publisher = MapPublisher(
        settings.resolved_qgis_publish_dir,
        settings.qgis_server_base_url,
        app_base_url=settings.app_base_url,
        qgis_runtime=qgis_runner,
        default_project_key=runtime_config.default_publish_project_key,
    )
    tool_registry = build_default_registry()
    tool_catalog_store = ToolCatalogStore(database_url)
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
        try:
            await asyncio.wait_for(asyncio.gather(*pending_tasks, return_exceptions=True), timeout=10)
        except asyncio.TimeoutError:
            logger.warning("Timed out waiting for %d background tasks to finish", len(pending_tasks))


app = FastAPI(title="geo-agent-platform", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_build_allowed_origins(
        settings.web_base_url,
        *(["http://localhost:5173", "http://127.0.0.1:5173"] if settings.app_env == "development" else []),
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由注册
app.include_router(health.router)
app.include_router(system.router)
app.include_router(sessions.router)
app.include_router(threads.router)
app.include_router(runs.router)
app.include_router(analysis.router)
app.include_router(layers.router)
app.include_router(tools.router)
app.include_router(qgis.router)
app.include_router(results.router)
app.include_router(config_routes.router)
app.include_router(geo.router)
