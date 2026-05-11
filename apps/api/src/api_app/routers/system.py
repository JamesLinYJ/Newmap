# +-------------------------------------------------------------------------
#
#   地理智能平台 - System 路由
#
#   文件:       system.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 系统组件状态与模型 provider 列表。

from __future__ import annotations

from fastapi import APIRouter, Request

from agent_core import GeoAgentRuntime
from shared_types.schemas import SystemComponentsStatus
from ..config import settings
from ..qgis_core import qgis_server_capabilities

router = APIRouter(tags=["system"])


@router.get("/api/v1/system/components")
async def system_components(request: Request):
    app = request.app
    qgis_runtime = await app.state.qgis_runner.health()
    qgis_server_available, ogc_api_available = await qgis_server_capabilities()
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


@router.get("/api/v1/providers")
async def list_providers(request: Request):
    return request.app.state.runtime.model_registry.descriptors()
