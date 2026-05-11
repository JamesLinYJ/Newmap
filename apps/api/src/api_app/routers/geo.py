# +-------------------------------------------------------------------------
#
#   地理智能平台 - Geo 路由 (v1)
#
#   文件:       geo.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 正逆向地理编码与底图列表。

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request

from ..dependencies import _format_component_error

router = APIRouter(tags=["geo"])


@router.get("/api/v1/map/basemaps")
async def list_basemaps(request: Request):
    return request.app.state.basemap_catalog.list_basemaps()


@router.get("/api/v1/geocode")
async def geocode(request: Request, q: str = Query(..., alias="q")):
    try:
        return await asyncio.to_thread(request.app.state.spatial_service.geocode_place, q)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Spatial service", f"geocode '{q}'", exc)) from exc


@router.get("/api/v1/reverse-geocode")
async def reverse_geocode(lat: float, lng: float, request: Request):
    try:
        return await asyncio.to_thread(request.app.state.spatial_service.reverse_geocode, lat, lng)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Spatial service", f"reverse geocode ({lat}, {lng})", exc)) from exc
