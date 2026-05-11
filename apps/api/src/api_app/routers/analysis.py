# +-------------------------------------------------------------------------
#
#   地理智能平台 - Analysis 路由 (v1)
#
#   文件:       analysis.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# v1 分析/chat 兼容层，内部委托给 run_core.start_run。

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from agent_core import GeoAgentRuntime
from ..dependencies import get_runtime, get_store
from ..models import AnalysisRequest
from ..platform_store import PostgresPlatformStore
from ..run_core import start_run

router = APIRouter(tags=["analysis"])


@router.post("/api/v1/chat")
async def chat(request: AnalysisRequest, req: Request, store: PostgresPlatformStore = Depends(get_store), runtime: GeoAgentRuntime = Depends(get_runtime)):
    return await start_run(request, store, runtime, req.app)


@router.post("/api/v1/analysis/run")
async def run_analysis(request: AnalysisRequest, req: Request, store: PostgresPlatformStore = Depends(get_store), runtime: GeoAgentRuntime = Depends(get_runtime)):
    return await start_run(request, store, runtime, req.app)


@router.get("/api/v1/analysis/{run_id}")
async def get_analysis_run(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_run(run_id)


@router.get("/api/v1/analysis/{run_id}/artifacts")
async def get_analysis_artifacts(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.list_artifacts(run_id)


@router.get("/api/v1/analysis/{run_id}/events")
async def stream_analysis_events(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    from .runs import _stream_analysis_events
    return await _stream_analysis_events(run_id, store)
