# +-------------------------------------------------------------------------
#
#   地理智能平台 - Tools 路由 (v1)
#
#   文件:       tools.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 工具聚合视图、目录管理、工具执行入口。

from __future__ import annotations

from json import JSONDecodeError

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from shared_types.exceptions import NotFoundError
from shared_types.schemas import ToolDescriptor
from ..dependencies import get_store
from ..models import ToolCatalogEntryUpsertRequest, ToolRunRequest
from ..platform_store import PostgresPlatformStore
from ..run_core import _apply_tool_result_to_run, _execute_tool_request, _record_tool_failure

router = APIRouter(tags=["tools"])


@router.get("/api/v1/tools")
async def list_tools(request: Request) -> list[ToolDescriptor]:
    catalog = request.app.state.tool_catalog_store.load_catalog()
    from ..tool_catalog import build_registry_tool_descriptors
    registry_tools = build_registry_tool_descriptors(request.app.state.tool_registry, catalog)
    return sorted(registry_tools, key=lambda item: (item.group, item.tool_kind, item.label))


@router.get("/api/v1/tools/catalog")
async def list_tool_catalog_entries(request: Request):
    return request.app.state.tool_catalog_store.list_entries()


@router.put("/api/v1/tools/catalog/{tool_kind}/{tool_name:path}")
async def upsert_tool_catalog_entry(tool_kind: str, tool_name: str, payload: ToolCatalogEntryUpsertRequest, request: Request):
    entry = request.app.state.tool_catalog_store.upsert_entry(
        tool_name=tool_name,
        tool_kind=tool_kind,
        payload=dict(payload.payload),
        sort_order=payload.sort_order,
    )
    return entry


@router.delete("/api/v1/tools/catalog/{tool_kind}/{tool_name:path}")
async def delete_tool_catalog_entry(tool_kind: str, tool_name: str, request: Request):
    deleted = request.app.state.tool_catalog_store.delete_entry(tool_name=tool_name, tool_kind=tool_kind)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Tool catalog entry not found: {tool_kind}/{tool_name}")
    return {"deleted": True, "toolName": tool_name, "toolKind": tool_kind}


@router.post("/api/v1/tools/run")
async def run_tool(payload: ToolRunRequest, request: Request, store: PostgresPlatformStore = Depends(get_store)):
    session = store.get_session(payload.session_id)
    thread = store.get_or_create_thread_for_session(session.id, title=f"工具调用：{payload.tool_name}")
    run = store.get_run(payload.run_id) if payload.run_id else store.create_run(session.id, f"工具调用：{payload.tool_name}", thread_id=thread.id)
    if not payload.run_id:
        store.mark_run_running(run.id)
    tool_label = _resolve_tool_label(request, payload)

    try:
        result = await _execute_tool_request(
            payload,
            run_id=run.id,
            session_id=session.id,
            latest_uploaded_layer_key=session.latest_uploaded_layer_key,
            latest_weather_dataset_id=session.latest_weather_dataset_id,
            app=request.app,
        )
        updated_run = _apply_tool_result_to_run(
            store,
            run_id=run.id,
            tool_name=payload.tool_name,
            args=dict(payload.args),
            result=result,
            tool_kind=payload.tool_kind,
            tool_label=tool_label,
        )
        return {
            "run": updated_run.model_dump(mode="json"),
            "tool": payload.tool_name,
            "toolKind": payload.tool_kind,
            "message": result.message,
            "artifact": result.artifact.model_dump(mode="json") if result.artifact else None,
            "payload": result.payload,
            "warnings": result.warnings,
        }
    except NotFoundError as exc:
        _record_tool_failure(store, run_id=run.id, tool_name=payload.tool_name, args=dict(payload.args), tool_kind=payload.tool_kind, tool_label=tool_label, exc=Exception(str(exc)))
        raise
    except HTTPException as exc:
        _record_tool_failure(store, run_id=run.id, tool_name=payload.tool_name, args=dict(payload.args), tool_kind=payload.tool_kind, tool_label=tool_label, exc=Exception(str(exc.detail)))
        raise
    except Exception as exc:
        _record_tool_failure(store, run_id=run.id, tool_name=payload.tool_name, args=dict(payload.args), tool_kind=payload.tool_kind, tool_label=tool_label, exc=exc)
        raise HTTPException(
            status_code=400 if isinstance(exc, (ValueError, KeyError, JSONDecodeError, ValidationError)) else 503,
            detail=str(exc).strip() or f"Tool runner {payload.tool_name} failed: {exc.__class__.__name__}: {exc}",
        ) from exc


def _resolve_tool_label(request: Request, payload: ToolRunRequest) -> str:
    # 工具事件展示名只来自 registry metadata；未注册工具后续仍按原路径失败。
    if payload.tool_kind != "registry":
        return ""
    try:
        return str(request.app.state.tool_registry.get_definition(payload.tool_name).metadata.label)
    except Exception:
        return ""
