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
# Artifact 数据访问、元数据与发布。

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from shared_types.schemas import PublishRequest
from ..dependencies import _format_component_error, get_store
from ..platform_store import PostgresPlatformStore

router = APIRouter(tags=["results"])


@router.get("/api/v1/results/{artifact_id}/geojson")
async def get_result_geojson(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return JSONResponse(store.get_artifact_collection(artifact_id))


@router.get("/api/v1/results/{artifact_id}/metadata")
async def get_result_metadata(artifact_id: str, store: PostgresPlatformStore = Depends(get_store)):
    artifact = store.get_artifact(artifact_id)
    metadata = store.get_artifact_metadata(artifact_id)
    return {"artifact": artifact, "metadata": metadata}


@router.post("/api/v1/results/{artifact_id}/publish")
async def publish_result(
    artifact_id: str,
    payload: PublishRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    artifact = store.get_artifact(artifact_id)
    collection = store.get_artifact_collection(artifact_id)
    try:
        runtime_config = store.get_runtime_config()
        result = await request.app.state.publisher.publish_artifact(
            artifact.artifact_id,
            artifact.name,
            payload.project_key or runtime_config.default_publish_project_key,
            collection=collection,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Map publisher", f"publish artifact '{artifact_id}'", exc)) from exc
    persisted_result = {"artifactId": artifact_id, **result}
    store.update_artifact_metadata(artifact_id, publishResult=persisted_result)
    return persisted_result
