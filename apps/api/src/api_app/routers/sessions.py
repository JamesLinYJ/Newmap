# +-------------------------------------------------------------------------
#
#   地理智能平台 - Sessions 路由 (v1)
#
#   文件:       sessions.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 会话生命周期管理、上传注册与会话内 runs/threads 列表。

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from gis_postgis import PostGISLayerRepository
from ..dependencies import _format_component_error, _read_upload_payload, get_layer_repository, get_store
from ..config import settings
from ..platform_store import PostgresPlatformStore

router = APIRouter(tags=["sessions"])


@router.post("/api/v1/sessions")
async def create_session(store: PostgresPlatformStore = Depends(get_store)):
    return store.create_session()


@router.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_session(session_id)


@router.get("/api/v1/sessions/{session_id}/runs")
async def list_session_runs(session_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.list_runs_for_session(session_id)


@router.get("/api/v1/sessions/{session_id}/threads")
async def list_session_threads(session_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.list_threads_for_session(session_id)


@router.post("/api/v1/layers/register")
async def register_layer(
    request: Request,
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
