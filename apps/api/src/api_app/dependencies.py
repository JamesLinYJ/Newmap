# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 依赖注入与共享工具
#
#   文件:       dependencies.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 提供 FastAPI 依赖注入访问器与跨路由共享的工具函数。

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import HTTPException, Request, UploadFile

from agent_core import GeoAgentRuntime
from gis_postgis import PostGISLayerRepository
from .config import settings
from .platform_store import PostgresPlatformStore

logger = logging.getLogger(__name__)


# 组件错误格式化
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


# 依赖注入访问器
def get_store(request: Request) -> PostgresPlatformStore:
    return request.app.state.store


def get_layer_repository(request: Request) -> PostGISLayerRepository:
    return request.app.state.layer_repository


def get_runtime(request: Request) -> GeoAgentRuntime:
    return request.app.state.runtime


def _format_sse(event) -> str:
    import json
    data = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
    return f"id: {event.event_id}\ndata: {data}\n\n"


def _split_form_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


async def _read_upload_payload(file: UploadFile, *, max_bytes: int) -> bytes:
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
