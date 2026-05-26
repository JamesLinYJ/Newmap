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

router = APIRouter(tags=["system"])


@router.get("/api/v1/system/components")
async def system_components(request: Request):
    app = request.app
    return SystemComponentsStatus(
        catalog_backend=app.state.layer_repository.__class__.__name__,
        postgis_enabled=True,
        session_log_root=str(app.state.store.session_log_store.root_path),
        providers=app.state.runtime.model_registry.descriptors(),
    )


@router.get("/api/v1/providers")
async def list_providers(request: Request):
    return request.app.state.runtime.model_registry.descriptors()
