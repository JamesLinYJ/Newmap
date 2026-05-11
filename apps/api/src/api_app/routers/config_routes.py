# +-------------------------------------------------------------------------
#
#   地理智能平台 - Runtime Config 路由 (v1)
#
#   文件:       config_routes.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# Runtime 配置的读写，持久化到 Postgres 并即时生效。

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared_types.schemas import AgentRuntimeConfig
from ..dependencies import get_store
from ..platform_store import PostgresPlatformStore

router = APIRouter(tags=["runtime-config"])


@router.get("/api/v1/runtime/config")
async def get_runtime_config(store: PostgresPlatformStore = Depends(get_store)):
    return store.get_runtime_config()


@router.put("/api/v1/runtime/config")
async def update_runtime_config(payload: AgentRuntimeConfig, request: Request, store: PostgresPlatformStore = Depends(get_store)):
    saved = store.save_runtime_config(payload)
    request.app.state.publisher.default_project_key = saved.default_publish_project_key
    request.app.state.spatial_service.configure_geosearch(saved.geosearch)
    request.app.state.spatial_service.configure_external_poi(saved.external_poi)
    return saved
