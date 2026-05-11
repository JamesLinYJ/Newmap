# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 路由 (v1)
#
#   文件:       qgis.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# QGIS 模型/算法发现和直接执行，委托给 qgis_core。

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from ..config import settings
from ..dependencies import _format_component_error, get_layer_repository, get_store
from ..models import QgisModelRequest, QgisProcessRequest
from ..platform_store import PostgresPlatformStore
from ..qgis_core import execute_qgis_model, execute_qgis_process
from ..tool_catalog import build_qgis_algorithm_descriptors, build_qgis_model_descriptors
from gis_postgis import PostGISLayerRepository

router = APIRouter(tags=["qgis"])


@router.get("/api/v1/qgis/models")
async def list_qgis_models(request: Request):
    health = await request.app.state.qgis_runner.health()
    model_dir = settings.resolved_qgis_models_dir
    if not health.get("available"):
        return {
            "available": False,
            "models": sorted(path.stem for path in model_dir.glob("*.model3")),
            "error": health.get("error"),
        }
    try:
        return await request.app.state.qgis_runner.list_models()
    except Exception as exc:
        return {
            "available": False,
            "models": sorted(path.stem for path in model_dir.glob("*.model3")),
            "error": str(exc).strip() or _format_component_error("QGIS runtime", "list models", exc),
        }


@router.get("/api/v1/qgis/algorithms")
async def list_qgis_algorithms(request: Request):
    catalog = request.app.state.tool_catalog_store.load_catalog()
    health = await request.app.state.qgis_runner.health()
    if not health.get("available"):
        return {
            "available": False,
            "algorithms": build_qgis_algorithm_descriptors([], available=False, error=health.get("error"), catalog=catalog),
            "error": health.get("error"),
        }
    try:
        payload = await request.app.state.qgis_runner.list_algorithms()
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


@router.post("/api/v1/qgis/process")
async def run_qgis_process(
    payload: QgisProcessRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    return await execute_qgis_process(
        payload,
        store=store,
        qgis_runner=request.app.state.qgis_runner,
        layer_repository=request.app.state.layer_repository,
        spatial_service=request.app.state.spatial_service,
    )


@router.post("/api/v1/qgis/models/run")
async def run_qgis_model(
    payload: QgisModelRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    return await execute_qgis_model(
        payload,
        store=store,
        qgis_runner=request.app.state.qgis_runner,
        layer_repository=request.app.state.layer_repository,
        spatial_service=request.app.state.spatial_service,
    )
