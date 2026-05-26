# +-------------------------------------------------------------------------
#
#   地理智能平台 - Results 路由 (v1)
#
#   文件:       results.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# Artifact 数据访问与元数据读取。

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse, JSONResponse

from ..dependencies import get_store
from ..platform_store import PostgresPlatformStore

router = APIRouter(tags=["results"])


@router.get("/api/v1/results/{artifact_id}/geojson")
async def get_result_geojson(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return JSONResponse(store.get_artifact_collection(artifact_id))


@router.get("/api/v1/results/{artifact_id}/file")
async def get_result_file(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    artifact = store.get_artifact(artifact_id)
    path = store.get_artifact_file_path(artifact_id)
    media_type = _artifact_media_type(artifact.artifact_type)
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.get("/api/v1/results/{artifact_id}/metadata")
async def get_result_metadata(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    artifact = store.get_artifact(artifact_id)
    metadata = store.get_artifact_metadata(artifact_id)
    return {"artifact": artifact, "metadata": metadata}


def _artifact_media_type(artifact_type: str) -> str:
    if artifact_type in {"raster_png", "chart_png"}:
        return "image/png"
    if artifact_type == "docx_report":
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return "application/octet-stream"
