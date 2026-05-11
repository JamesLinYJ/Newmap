# +-------------------------------------------------------------------------
#
#   地理智能平台 - Layers 路由 (v1)
#
#   文件:       layers.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 图层目录 CRUD，支持托管图层创建、导入和替换。

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile

from gis_postgis import PostGISLayerRepository
from ..dependencies import _format_component_error, _read_upload_payload, _split_form_list, get_layer_repository, get_store
from ..config import settings
from ..models import LayerCreateRequest, LayerUpdateRequest
from ..platform_store import PostgresPlatformStore

router = APIRouter(tags=["layers"])


@router.get("/api/v1/layers")
async def list_layers(
    include_inactive: bool = Query(True, alias="includeInactive"),
    layer_repository: PostGISLayerRepository = Depends(get_layer_repository),
):
    return layer_repository.list_layers(include_inactive=include_inactive)


@router.post("/api/v1/layers")
async def create_layer(
    request: LayerCreateRequest,
    layer_repository: PostGISLayerRepository = Depends(get_layer_repository),
):
    try:
        return layer_repository.create_managed_layer(
            name=request.name,
            collection=request.geojson,
            description=request.description,
            category=request.category,
            tags=request.tags,
            status=request.status,
            analysis_capabilities=request.analysis_capabilities,
            source_type=request.source_type,
            source_config_summary=request.source_config_summary,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_format_component_error("Layer catalog", f"create layer '{request.name}'", exc)) from exc


@router.post("/api/v1/layers/import")
async def import_layer(
    request: Request,
    file: UploadFile = File(...),
    name: Annotated[str | None, Form()] = None,
    description: Annotated[str, Form()] = "",
    category: Annotated[str | None, Form()] = None,
    tags: Annotated[str, Form()] = "",
    status: Annotated[str, Form()] = "active",
    analysis_capabilities: Annotated[str, Form(alias="analysisCapabilities")] = "",
    source_config_summary: Annotated[str | None, Form(alias="sourceConfigSummary")] = None,
    layer_repository: PostGISLayerRepository = Depends(get_layer_repository),
):
    payload = await _read_upload_payload(file, max_bytes=settings.upload_max_bytes)
    try:
        return layer_repository.import_managed_layer(
            filename=file.filename or "layer.geojson",
            payload=payload,
            name=name,
            description=description,
            category=category,
            tags=_split_form_list(tags),
            status=status,
            analysis_capabilities=_split_form_list(analysis_capabilities),
            source_config_summary=source_config_summary,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_format_component_error("Layer catalog", f"import layer '{file.filename or 'layer.geojson'}'", exc)) from exc


@router.patch("/api/v1/layers/{layer_key}")
async def update_layer(
    layer_key: str,
    request: LayerUpdateRequest,
    layer_repository: PostGISLayerRepository = Depends(get_layer_repository),
):
    try:
        return layer_repository.update_managed_layer(
            layer_key,
            name=request.name,
            description=request.description,
            category=request.category,
            tags=request.tags,
            status=request.status,
            analysis_capabilities=request.analysis_capabilities,
            source_config_summary=request.source_config_summary,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_format_component_error("Layer catalog", f"update layer '{layer_key}'", exc)) from exc


@router.post("/api/v1/layers/{layer_key}/replace")
async def replace_layer(
    layer_key: str,
    file: UploadFile = File(...),
    layer_repository: PostGISLayerRepository = Depends(get_layer_repository),
):
    payload = await _read_upload_payload(file, max_bytes=settings.upload_max_bytes)
    try:
        return layer_repository.replace_managed_layer_data(layer_key, filename=file.filename or "layer.geojson", payload=payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_format_component_error("Layer catalog", f"replace layer '{layer_key}'", exc)) from exc


@router.delete("/api/v1/layers/{layer_key}")
async def delete_layer(
    layer_key: str,
    layer_repository: PostGISLayerRepository = Depends(get_layer_repository),
):
    deleted = layer_repository.delete_layer(layer_key)
    if not deleted:
        raise HTTPException(status_code=404, detail="图层不存在。")
    return {"deleted": True, "layerKey": layer_key}
