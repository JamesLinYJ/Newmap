# +-------------------------------------------------------------------------
#
#   地理智能平台 - Threads 路由 (v2)
#
#   文件:       threads.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# v2 thread 生命周期与 thread 上下文内的 run 创建。

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from agent_core import GeoAgentRuntime
from ..dependencies import get_runtime, get_store
from ..models import ThreadCreateRequest, ThreadRunRequest, ThreadUpdateRequest, AnalysisRequest
from ..platform_store import PostgresPlatformStore
from ..run_core import start_run

router = APIRouter(tags=["threads"])


@router.post("/api/v2/threads")
async def create_thread(payload: ThreadCreateRequest, store: PostgresPlatformStore = Depends(get_store)):
    return store.create_thread(payload.session_id, title=payload.title)


@router.get("/api/v2/threads/{thread_id}")
async def get_thread(thread_id: str, store: PostgresPlatformStore = Depends(get_store)):
    thread = store.get_thread(thread_id)
    runs = store.list_runs_for_thread(thread_id)
    latest_run = runs[0] if runs else None
    return {
        "thread": thread,
        "runs": runs,
        "latestRun": latest_run,
    }


@router.patch("/api/v2/threads/{thread_id}")
async def update_thread(thread_id: str, payload: ThreadUpdateRequest, store: PostgresPlatformStore = Depends(get_store)):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="线程标题不能为空。")
    return store.update_thread(thread_id, title=title)


@router.delete("/api/v2/threads/{thread_id}")
async def delete_thread(thread_id: str, store: PostgresPlatformStore = Depends(get_store)):
    store.delete_thread(thread_id)
    return {"deleted": True, "threadId": thread_id}


@router.post("/api/v2/threads/{thread_id}/runs")
async def create_thread_run(
    thread_id: str,
    req: ThreadRunRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
    runtime: GeoAgentRuntime = Depends(get_runtime),
):
    thread = store.get_thread(thread_id)
    return await start_run(
        AnalysisRequest(
            sessionId=thread.session_id,
            query=req.query,
            provider=req.provider,
            model=req.model,
            clarificationOptionId=req.clarification_option_id,
        ),
        store,
        runtime,
        request.app,
        thread_id=thread_id,
    )
