# +-------------------------------------------------------------------------
#
#   地理智能平台 - Plan 模式工具
#
#   文件:       plan_tools.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# Plan 模式让 Agent 先只读探索数据（加载图层、分析气象、查询元数据），
# 生成执行计划后提交用户审批。审批通过后才允许发布/导出等写操作。

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime

_PLAN_STATE_KEY = "__plan_mode__"


@dataclass
class PlanState:
    active: bool = False
    plan_text: str = ""
    steps: list[dict[str, Any]] = field(default_factory=list)


def _get_plan_state(runtime: ToolRuntime) -> PlanState:
    raw = runtime.state.alias_map.get(_PLAN_STATE_KEY, {})
    if not isinstance(raw, dict):
        return PlanState()
    return PlanState(
        active=bool(raw.get("active", False)),
        plan_text=str(raw.get("plan_text", "")),
        steps=list(raw.get("steps", [])),
    )


def _set_plan_state(runtime: ToolRuntime, state: PlanState) -> None:
    runtime.state.alias_map[_PLAN_STATE_KEY] = {
        "active": state.active,
        "plan_text": state.plan_text,
        "steps": state.steps,
    }
    runtime.state.plan_mode = state.active


def is_plan_mode_active(runtime: ToolRuntime) -> bool:
    """运行时检查是否处于 plan 模式。"""
    return _get_plan_state(runtime).active


def get_plan_steps(runtime: ToolRuntime) -> list[dict[str, Any]]:
    """获取当前执行计划步骤列表。"""
    return _get_plan_state(runtime).steps


class EnterPlanModeArgs(ToolArgsModel):
    pass


async def enter_plan_mode_handler(
    _args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    _set_plan_state(runtime, PlanState(active=True))
    return ToolExecutionResult(
        message=(
            "已进入计划模式。只能执行只读探索操作。"
            "探索完成后调用 exit_plan_mode 提交执行计划。"
        ),
        payload={"mode": "plan", "restriction": "read_only"},
        source="plan_system",
    )


class ExitPlanModeArgs(ToolArgsModel):
    plan_summary: str | None = None
    steps: list[dict[str, Any]] | None = None


async def exit_plan_mode_handler(
    args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    plan_text = str(args.get("plan_summary") or "")
    steps: list[dict[str, Any]] = []
    for s in (args.get("steps") or []):
        if isinstance(s, dict):
            steps.append({
                "tool": str(s.get("tool", "")),
                "args": s.get("args", {}),
                "reason": str(s.get("reason", "")),
            })

    state = _get_plan_state(runtime)
    state.plan_text = plan_text
    state.steps = steps
    state.active = False
    _set_plan_state(runtime, state)

    return ToolExecutionResult(
        message=f"已提交执行计划（{len(steps)} 步），等待审批。",
        payload={"plan_summary": plan_text, "steps": steps, "requires_approval": True},
        source="plan_system",
        feature_count=len(steps),
    )
