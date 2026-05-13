# +-------------------------------------------------------------------------
#
#   地理智能平台 - Run 执行核心
#
#   文件:       run_core.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 封装分析任务的启动、工具执行分发、结果回灌和失败记录，
# 供 v1 chat/analysis 和 v2 thread/run 路由共享复用。

from __future__ import annotations

import asyncio
import json
import logging
import os
from json import JSONDecodeError
from typing import Any

from fastapi import HTTPException
from shared_types.exceptions import NotFoundError
from pydantic import ValidationError

logger = logging.getLogger(__name__)

from agent_core import GeoAgentRuntime
from gis_common.ids import make_id, now_utc
from shared_types.schemas import (
    ArtifactRef,
    EventType,
    RunEvent,
    ToolCall,
)
from tool_registry import ToolExecutionResult, ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore

from .config import settings
from .models import AnalysisRequest, ToolRunRequest
from .platform_store import PostgresPlatformStore


def _derive_thread_title_seed(query: str) -> str:
    normalized = " ".join(query.strip().split())
    if not normalized:
        return "新建任务"
    return normalized[:32]


async def _generate_thread_title(
    runtime: GeoAgentRuntime,
    provider: str,
    model_name: str | None,
    query: str,
) -> str | None:
    try:
        adapter = runtime.model_registry.resolve_provider(provider)
        response = await adapter.chat(
            (
                "请把下面这条用户需求压缩成一个简短中文任务标题。\n"
                "要求：\n"
                "1. 只返回标题文本，不要解释。\n"
                "2. 控制在 8 到 18 个中文字符内。\n"
                "3. 保留任务目标，不要写成口号。\n\n"
                f"用户需求：{query}"
            ),
            model=model_name,
            temperature=0.1,
        )
    except Exception:
        return None

    content = str(response.get("content", "")).strip().splitlines()
    title = next((line.strip().strip("`#*- ") for line in content if line.strip()), "")
    if not title:
        return None
    return title[:24]


def _build_tool_runtime(
    *,
    run_id: str,
    thread_id: str | None,
    session_id: str,
    latest_uploaded_layer_key: str | None,
    app,
) -> ToolRuntime:
    store = app.state.store
    return ToolRuntime(
        context=ToolRuntimeContext(
            run_id=run_id,
            thread_id=thread_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        ),
        state=ToolRuntimeState(alias_map=_load_run_alias_map(store, run_id)),
        store=ToolRuntimeStore(
            platform_store=app.state.platform_store,
            layer_repository=app.state.layer_repository,
            artifact_export_store=app.state.artifact_export_store,
            spatial_service=app.state.spatial_service,
            qgis_runner=app.state.qgis_runner,
            publisher=app.state.publisher,
            runtime_root=settings.resolved_runtime_root,
        ),
    )


def _load_run_alias_map(store: PostgresPlatformStore, run_id: str) -> dict[str, dict[str, object]]:
    alias_map: dict[str, dict[str, object]] = {}
    try:
        run = store.get_run(run_id)
    except (HTTPException, NotFoundError):
        return alias_map

    for artifact in run.state.artifacts:
        try:
            collection = store.get_artifact_collection(artifact.artifact_id)
            alias_map[artifact.artifact_id] = collection
            alias_map[artifact.name] = collection
            metadata = store.get_artifact_metadata(artifact.artifact_id)
            alias = metadata.get("alias")
            if isinstance(alias, str) and alias.strip():
                alias_map[alias.strip()] = collection
        except (HTTPException, NotFoundError):
            continue
    return alias_map


async def _execute_tool_request(
    payload: ToolRunRequest,
    *,
    run_id: str,
    session_id: str,
    latest_uploaded_layer_key: str | None,
    app,
) -> ToolExecutionResult:
    if payload.tool_kind == "registry":
        run = app.state.store.get_run(run_id)
        runtime = _build_tool_runtime(
            run_id=run_id,
            thread_id=run.thread_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
            app=app,
        )
        return await app.state.tool_registry.execute(payload.tool_name, dict(payload.args), runtime)

    if payload.tool_kind == "qgis_algorithm":
        from .qgis_core import run_qgis_algorithm_tool
        return await run_qgis_algorithm_tool(
            payload,
            run_id=run_id,
            store=app.state.store,
            qgis_runner=app.state.qgis_runner,
            layer_repository=app.state.layer_repository,
            spatial_service=app.state.spatial_service,
        )

    if payload.tool_kind == "qgis_model":
        from .qgis_core import run_qgis_model_tool
        return await run_qgis_model_tool(
            payload,
            run_id=run_id,
            store=app.state.store,
            qgis_runner=app.state.qgis_runner,
            layer_repository=app.state.layer_repository,
            spatial_service=app.state.spatial_service,
        )

    raise ValueError(f"不支持的工具类型：{payload.tool_kind}")


def _apply_tool_result_to_run(
    store: PostgresPlatformStore,
    *,
    run_id: str,
    tool_name: str,
    args: dict[str, object],
    result: ToolExecutionResult,
    tool_kind: str,
):
    run = store.get_run(run_id)
    tool_results = list(run.state.tool_results)
    tool_results.append(
        ToolCall(
            step_id=make_id("step"),
            tool=f"{tool_kind}:{tool_name}",
            args=args,
            status="completed",
            message=result.message,
            started_at=now_utc(),
            completed_at=now_utc(),
        )
    )
    artifacts = list(run.state.artifacts)
    if result.artifact and not any(item.artifact_id == result.artifact.artifact_id for item in artifacts):
        artifacts.append(result.artifact)
    updated_run = store.update_run_state(
        run_id,
        status="completed",
        tool_results=tool_results,
        artifacts=artifacts,
        warnings=[*run.state.warnings, *result.warnings],
    )
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            thread_id=run.thread_id,
            type=EventType.TOOL_COMPLETED,
            message=result.message,
            timestamp=now_utc(),
            payload={"tool": tool_name, "toolKind": tool_kind, "artifact": result.artifact.model_dump(mode="json") if result.artifact else None},
        ),
    )
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            thread_id=run.thread_id,
            type=EventType.STEP_COMPLETED,
            message=result.message,
            timestamp=now_utc(),
            payload={"tool": tool_name, "toolKind": tool_kind, "artifact": result.artifact.model_dump(mode="json") if result.artifact else None},
        ),
    )
    return updated_run


def _record_tool_failure(
    store: PostgresPlatformStore,
    *,
    run_id: str,
    tool_name: str,
    args: dict[str, object],
    tool_kind: str,
    exc: Exception,
) -> None:
    try:
        run = store.get_run(run_id)
    except (HTTPException, NotFoundError):
        return

    tool_results = list(run.state.tool_results)
    tool_results.append(
        ToolCall(
            step_id=make_id("step"),
            tool=f"{tool_kind}:{tool_name}",
            args=args,
            status="failed",
            message=str(exc),
            started_at=now_utc(),
            completed_at=now_utc(),
        )
    )
    errors = [*run.state.errors, str(exc)]
    store.update_run_state(run_id, status="failed", tool_results=tool_results, errors=errors, failed_tool=tool_name)
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            thread_id=run.thread_id,
            type=EventType.TOOL_COMPLETED,
            message=str(exc),
            timestamp=now_utc(),
            payload={"tool": tool_name, "toolKind": tool_kind, "errors": errors},
        ),
    )
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            thread_id=run.thread_id,
            type=EventType.RUN_FAILED,
            message=str(exc),
            timestamp=now_utc(),
            payload={"tool": tool_name, "toolKind": tool_kind, "errors": errors},
        ),
    )


async def start_run(
    request: AnalysisRequest,
    store: PostgresPlatformStore,
    runtime: GeoAgentRuntime,
    app,
    *,
    thread_id: str | None = None,
):
    session = store.get_session(request.session_id)
    thread = store.get_thread(thread_id) if thread_id else store.create_thread(session.id, title=_derive_thread_title_seed(request.query))
    if thread_id is not None and any(r.status == "running" for r in store.list_runs_for_thread(thread_id)):
        raise HTTPException(status_code=409, detail="该线程已有正在执行的分析任务，请等待完成后再提交。")
    try:
        adapter = runtime.model_registry.resolve_provider(request.provider or settings.default_model_provider)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    model_name = request.model or adapter.default_model or settings.default_model_name
    provider_name = adapter.provider
    if not runtime.model_registry.supports_live_supervisor(provider_name):
        raise HTTPException(status_code=400, detail=f"模型 provider '{provider_name}' 不支持 live supervisor 主路径，请更换已配置的 provider。")
    if thread_id is None:
        generated_title = await _generate_thread_title(runtime, provider_name, model_name, request.query)
        if generated_title:
            thread = store.update_thread(thread.id, title=generated_title)
    run = store.create_run(session.id, request.query, thread_id=thread.id, model_provider=provider_name, model_name=model_name)
    store.mark_run_running(run.id)

    runner = runtime.run(
        run_id=run.id,
        thread_id=thread.id,
        session_id=session.id,
        query=request.query,
        latest_uploaded_layer_key=session.latest_uploaded_layer_key,
        provider=provider_name,
        model_name=model_name,
        context_factory=lambda **kw: _build_tool_runtime(**kw, app=app),
        clarification_option_id=request.clarification_option_id,
    )
    if "PYTEST_CURRENT_TEST" in os.environ:
        await runner
        return store.get_run(run.id)

    task = asyncio.create_task(runner)
    app.state.background_tasks.add(task)

    def _on_task_done(finished: asyncio.Task[Any]) -> None:
        app.state.background_tasks.discard(finished)
        if not finished.cancelled():
            exc = finished.exception()
            if exc is not None:
                logger.error("Background run %s crashed: %s: %s", run.id, exc.__class__.__name__, exc)

    task.add_done_callback(_on_task_done)
    return store.get_run(run.id)
