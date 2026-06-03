# +-------------------------------------------------------------------------
#
#   地理智能平台 - Task/Todo 工具
#
#   文件:       task_tools.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 实现多步分析的进度追踪。Agent 拆解复杂 GIS 分析任务为子步骤，
# 通过 todo_write 写入/更新待办列表，前端展示进度条和状态标签。

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from gis_common.ids import make_id

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime

_TODO_STATE_KEY = "__todo_list__"
_TODO_STATUS_ALIASES = {
    "in_progress": "running",
    "doing": "running",
    "done": "completed",
}


@dataclass
class TodoItem:
    id: str = ""
    content: str = ""        # "分析澳门医院分布"
    status: str = "pending"  # pending | in_progress | completed
    active_form: str = ""    # "分析澳门医院分布中"


def _get_todo_list(runtime: ToolRuntime) -> list[dict[str, Any]]:
    if runtime.state.todos:
        return runtime.state.todos
    raw = runtime.state.alias_map.get(_TODO_STATE_KEY)
    if isinstance(raw, list):
        return raw
    return []


def _set_todo_list(runtime: ToolRuntime, items: list[dict[str, Any]]) -> None:
    runtime.state.alias_map[_TODO_STATE_KEY] = items
    runtime.state.todos = items


def _normalize_todo_item(item: dict[str, Any]) -> dict[str, Any]:
    raw_status = str(item.get("status", "pending"))
    status = _TODO_STATUS_ALIASES.get(raw_status, raw_status)
    title = str(item.get("title") or item.get("content") or item.get("activeForm") or item.get("active_form") or "")
    active_form = item.get("activeForm", item.get("active_form"))
    return {
        "todoId": str(item.get("todoId") or item.get("todo_id") or item.get("id") or make_id("todo")),
        "title": title,
        "status": status,
        "description": str(item.get("description") or item.get("content") or "") or None,
        "activeForm": str(active_form) if active_form else None,
        "ownerAgentId": item.get("ownerAgentId") or item.get("owner_agent_id"),
        "stepId": item.get("stepId") or item.get("step_id"),
    }


def get_todo_items(runtime: ToolRuntime) -> list[TodoItem]:
    """获取当前待办列表（供前端和权限系统使用）。"""
    return [
        TodoItem(
            id=item.get("todoId", item.get("id", "")),
            content=item.get("title", item.get("content", "")),
            status=item.get("status", "pending"),
            active_form=item.get("activeForm", item.get("active_form", "")) or "",
        )
        for item in _get_todo_list(runtime)
    ]


# ─── TodoWrite ─────────────────────────────────────────────────────

class TodoWriteArgs(ToolArgsModel):
    todos: list[dict[str, Any]] = []
    """完整的待办列表。新列表替换旧列表。每项: {content, status, activeForm}。"""


async def todo_write_handler(
    args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    """创建或更新待办列表。覆盖式写入（新列表替换旧列表）。

    Agent 在执行多步分析前调用。每项包含：
    - content: 祈使形式，描述要做什么（如"分析澳门医院分布"）
    - status: pending | in_progress | completed
    - activeForm: 进行时形式，描述正在做什么（如"正在分析澳门医院分布"）
    """
    old_todos: list[dict[str, Any]] = list(_get_todo_list(runtime))

    raw = args.get("todos", [])
    if not isinstance(raw, list):
        raw = []

    items: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_todo_item(item)
        if normalized["title"]:
            items.append(normalized)

    # 全部完成时清空列表（与参考实现一致：allDone → newTodos = []）
    all_done = all(i["status"] == "completed" for i in items) if items else False
    if all_done:
        items.clear()

    _set_todo_list(runtime, items)

    done = sum(1 for i in items if i["status"] == "completed")
    total = len(items)

    # --- 验证提醒 ---
    # 当主管 Agent 关闭了 3+ 项任务，且其中没有一项是验证/检查类步骤时，
    # 在结果中追加提醒——让 Agent 考虑是否需要最终验证。
    verification_nudge: str | None = None
    if all_done and len(old_todos) >= 3:
        has_verification = any(
            "验证" in (str(i.get("title", ""))) or "检查" in (str(i.get("title", "")))
            or "review" in str(i.get("title", "")).lower()
            for i in old_todos
        )
        if not has_verification:
            verification_nudge = (
                "注意：你刚刚关闭了 3 个以上的任务，其中没有包含验证步骤。"
                "在写最终总结前，建议再检查一遍结果是否正确。"
            )

    # 结果消息：前后对比，简洁明了
    old_count = len(old_todos)
    if total > 0:
        message = f"待办列表已更新：{done}/{total} 完成"
    elif old_count > 0:
        message = "待办列表已清空。"
    else:
        message = "待办列表无变化。"

    if verification_nudge:
        message += f"\n\n{verification_nudge}"

    return ToolExecutionResult(
        message=message,
        payload={
            "oldTodos": old_todos,
            "newTodos": items,
            "total": total,
            "completed": done,
            "verificationNudgeNeeded": bool(verification_nudge),
        },
        source="task_system",
        feature_count=total,
    )


# ─── TaskCreate ────────────────────────────────────────────────────

class TaskCreateArgs(ToolArgsModel):
    agent_type: str = "general"
    prompt: str = ""
    description: str = ""


async def task_create_handler(
    args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    """创建异步后台任务。Agent 将独立子任务委托给子 Agent 后台执行。"""
    agent_type = str(args.get("agent_type", "general"))
    prompt = str(args.get("prompt", ""))
    desc = str(args.get("description", prompt[:80]))

    todos = _get_todo_list(runtime)
    task_id = make_id("task")
    todos.append({
        "todoId": task_id,
        "title": desc,
        "description": desc,
        "status": "pending",
        "activeForm": f"执行中：{desc}",
        "agent_type": agent_type, "prompt": prompt,
    })
    _set_todo_list(runtime, todos)

    return ToolExecutionResult(
        message=f"已创建后台任务：{desc}",
        payload={"task_id": task_id, "agent_type": agent_type, "status": "pending"},
        source="task_system",
    )


# ─── TaskList ───────────────────────────────────────────────────────

class TaskListArgs(ToolArgsModel):
    status: str | None = None


async def task_list_handler(
    args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    """列出当前 run 的所有任务。可按状态过滤。"""
    filter_status = str(args.get("status", "")).strip() or None
    todos = _get_todo_list(runtime)
    if filter_status:
        todos = [t for t in todos if t.get("status") == filter_status]

    return ToolExecutionResult(
        message=f"当前有 {len(todos)} 个任务。",
        payload={"tasks": todos, "total": len(todos)},
        source="task_system",
        feature_count=len(todos),
    )


# ─── TaskUpdate ─────────────────────────────────────────────────────

class TaskUpdateArgs(ToolArgsModel):
    task_id: str = ""
    status: str = "completed"


async def task_update_handler(
    args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    """更新任务状态。"""
    task_id = str(args.get("task_id", args.get("taskId", "")))
    new_status = str(args.get("status", "completed"))

    todos = _get_todo_list(runtime)
    updated = False
    for item in todos:
        if item.get("todoId") == task_id or item.get("id") == task_id:
            item["status"] = _TODO_STATUS_ALIASES.get(new_status, new_status)
            updated = True
            break

    if not updated:
        return ToolExecutionResult(
            message=f"未找到任务 {task_id}。", payload={}, source="task_system"
        )

    _set_todo_list(runtime, todos)
    return ToolExecutionResult(
        message=f"任务 {task_id} 状态已更新为 {new_status}。",
        payload={"task_id": task_id, "status": new_status},
        source="task_system",
    )
