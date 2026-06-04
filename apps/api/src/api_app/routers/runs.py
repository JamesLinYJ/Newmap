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

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from agent_core import GeoAgentRuntime
from ..dependencies import _format_sse, get_runtime, get_store
from ..models import ApprovalResolutionRequest
from ..platform_store import PostgresPlatformStore
from ..run_core import _build_tool_runtime

router = APIRouter(tags=["runs"])

TERMINAL_SSE_EVENT_TYPES = {"run.completed", "run.failed", "approval.required", "clarification.required"}
TERMINAL_MESSAGE_RESULT_TYPES = {"success", "failed", "waiting_approval", "waiting_clarification", "cancelled"}


def _is_terminal_sse_event(event) -> bool:
    # SSE 终止语义。
    #
    # approval.required / clarification.required 都表示 run 已进入人工等待快照，
    # 前端需要立刻 hydrate，不能继续把事件流挂在 running 状态里等 run.completed。
    return event.type.value in TERMINAL_SSE_EVENT_TYPES


def _is_terminal_message_frame(frame) -> bool:
    if frame.op != "result":
        return False
    result_type = str((frame.result or {}).get("type") or "")
    return result_type in TERMINAL_MESSAGE_RESULT_TYPES


def _format_message_sse(frame) -> str:
    import json

    data = json.dumps(frame.model_dump(mode="json", by_alias=True), ensure_ascii=False)
    return f"id: {frame.frame_id}\ndata: {data}\n\n"


@router.get("/api/v2/runs/{run_id}")
async def get_thread_run(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_run(run_id)


@router.get("/api/v2/runs/{run_id}/messages")
async def get_thread_run_messages(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    store.get_run(run_id)
    return store.list_messages(run_id)

@router.get("/api/v2/runs/{run_id}/items")
async def get_thread_run_items(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    """Codex 风格平铺 item 列表 — 前端按行序渲染。"""
    store.get_run(run_id)
    return store.list_items(run_id)


@router.get("/api/v2/runs/{run_id}/messages/stream")
async def stream_thread_run_messages(run_id: str, request: Request, store: PostgresPlatformStore = Depends(get_store)):
    return await _stream_analysis_messages(run_id, store)


@router.get("/api/v2/runs/{run_id}/events")
async def stream_thread_run_events(run_id: str, request: Request, store: PostgresPlatformStore = Depends(get_store)):
    return await _stream_analysis_events(run_id, store)


@router.get("/api/v2/runs/{run_id}/events.json")
async def get_run_events_json(run_id: str, store: PostgresPlatformStore = Depends(get_store)):
    """返回历史事件列表（JSON），供前端 hydrate 使用。"""
    return store.list_events(run_id)


@router.post("/api/v2/runs/{run_id}/cancel")
async def cancel_run(
    run_id: str,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    # 中断以后台 task 为事实源；找不到 task 时只允许返回已终止 run，
    # 避免把已完成/已失败的历史任务重新改写成取消。
    run = store.get_run(run_id)
    if run.status != "running":
        return run
    run_tasks = getattr(request.app.state, "background_run_tasks", {})
    task: asyncio.Task | None = run_tasks.get(run_id)
    if task is None or task.done():
        raise HTTPException(status_code=409, detail="该运行任务已经不在后台执行队列中。")

    task.cancel()
    try:
        await asyncio.wait_for(task, timeout=2)
    except asyncio.CancelledError:
        pass
    except asyncio.TimeoutError:
        # 取消信号已经发出；先把快照标记为 cancelled，让前端按钮立即回到可用状态。
        store.update_run_state(run_id, status="cancelled")

    return store.get_run(run_id)


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
            if _is_terminal_sse_event(event):
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
                if _is_terminal_sse_event(event):
                    break
        finally:
            store.unsubscribe(run_id, queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


async def _stream_analysis_messages(run_id: str, store: PostgresPlatformStore):
    async def event_stream():
        seen_ids = set()
        history = store.list_message_frames(run_id)
        terminal_seen = False
        for frame in history:
            seen_ids.add(frame.frame_id)
            yield _format_message_sse(frame)
            if _is_terminal_message_frame(frame):
                terminal_seen = True

        if terminal_seen or store.get_run(run_id).status != "running":
            return

        queue = store.subscribe_messages(run_id)
        try:
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if frame.frame_id not in seen_ids:
                    seen_ids.add(frame.frame_id)
                    yield _format_message_sse(frame)
                if _is_terminal_message_frame(frame):
                    break
        finally:
            store.unsubscribe_messages(run_id, queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
