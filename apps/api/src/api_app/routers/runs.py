# +-------------------------------------------------------------------------
#
#   地理智能平台 - Runs 路由 (v2)
#
#   文件:       runs.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# v2 run 访问、SSE 事件流与审批决策。

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from agent_core import GeoAgentRuntime
from ..dependencies import _format_sse, get_runtime, get_store
from ..models import ApprovalResolutionRequest
from ..platform_store import PostgresPlatformStore
from ..run_core import _build_tool_runtime

router = APIRouter(tags=["runs"])


@router.get("/api/v2/runs/{run_id}")
async def get_thread_run(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_run(run_id)


@router.get("/api/v2/runs/{run_id}/events")
async def stream_thread_run_events(run_id: str, request: Request, store: PostgresPlatformStore = Depends(get_store)):
    return await _stream_analysis_events(run_id, store)


@router.post("/api/v2/runs/{run_id}/approvals/{approval_id}")
async def resolve_run_approval(
    run_id: str,
    approval_id: str,
    payload: ApprovalResolutionRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
    runtime: GeoAgentRuntime = Depends(get_runtime),
):
    run = store.get_run(run_id)
    session = store.get_session(run.session_id)
    return await runtime.resolve_approval(
        run_id=run_id,
        approval_id=approval_id,
        approved=payload.approved,
        context_factory=lambda **kw: _build_tool_runtime(**kw, app=request.app),
        latest_uploaded_layer_key=session.latest_uploaded_layer_key,
    )


async def _stream_analysis_events(run_id: str, store: PostgresPlatformStore):
    async def event_stream():
        seen_ids = set()
        history = store.list_events(run_id)
        terminal_seen = False
        for event in history:
            seen_ids.add(event.event_id)
            yield _format_sse(event)
            if event.type.value in {"run.completed", "run.failed"}:
                terminal_seen = True

        if terminal_seen:
            return

        queue = store.subscribe(run_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event.event_id not in seen_ids:
                    seen_ids.add(event.event_id)
                    yield _format_sse(event)
                if event.type.value in {"run.completed", "run.failed"}:
                    break
        finally:
            store.unsubscribe(run_id, queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
