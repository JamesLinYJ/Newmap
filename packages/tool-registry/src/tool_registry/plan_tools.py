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
    """进入计划模式。将运行时标记为只读探索状态。

    进入后 Agent 只能执行只读操作（加载数据、查询属性、空间分析、
    气象分析、生成图表），不能执行发布、导出、删除等写操作。

    探索完成后调用 exit_plan_mode 提交执行计划供用户审批。
    """
    _set_plan_state(runtime, PlanState(active=True))

    # tool_result message 包含分步指引，与 EnterPlanMode 的
    # mapToolResultToToolResultBlockParam 对齐
    instructions = (
        "已进入计划模式。你现在应该聚焦于探索数据并设计分析方案。\n\n"
        "在计划模式下，你应该：\n"
        "1. 加载相关图层和气象数据，了解其结构、属性和空间范围\n"
        "2. 执行只读空间分析（缓冲、相交、统计、制图等）来验证数据可用性和假设\n"
        "3. 如果不确定选哪个图层或分析路径，使用 request_clarification 向用户确认\n"
        "4. 设计具体的分析步骤：每一步用什么工具、什么参数、预期产出什么\n"
        "5. 准备好后，使用 exit_plan_mode 将完整执行计划提交给用户审批\n\n"
        "切记：**不要**在此阶段执行任何写操作。这是只读探索与规划阶段。\n"
        "你只能执行只读操作：加载数据、查询属性、空间分析、气象分析、生成图表。"
    )

    return ToolExecutionResult(
        message=instructions,
        payload={"mode": "plan", "restriction": "read_only"},
        source="plan_system",
    )


class ExitPlanModeArgs(ToolArgsModel):
    plan_summary: str | None = None
    """计划摘要文本。描述整体方案、关键决策及其理由。"""
    steps: list[dict[str, Any]] | None = None
    """执行步骤列表。每步包含 tool（工具名）、args（参数）、reason（原因）。"""
    allowed_prompts: list[dict[str, Any]] | None = None
    """实现计划时需要的 Bash 权限声明。每项包含 tool（固定 "Bash"）和 prompt（语义描述，如 "运行测试"）。"""


async def exit_plan_mode_handler(
    args: dict[str, Any], runtime: ToolRuntime,
) -> ToolExecutionResult:
    """退出计划模式，将执行计划提交给用户审批。

    此工具只能在 plan mode 内调用。提交后 agent 恢复为默认权限模式，
    审批通过后即可开始实现。

    计划应包含：
    - plan_summary：方案摘要
    - steps：具体执行步骤
    - allowed_prompts：实现阶段需要的 Bash 操作（可选）
    """
    # --- validateInput 等效检查：不在 plan mode 时拒绝 ---
    plan_state = _get_plan_state(runtime)
    if not plan_state.active:
        return ToolExecutionResult(
            message=(
                "你现在不在计划模式中。此工具仅用于退出计划模式并提交计划。"
                "如果你需要先进入计划模式来设计方案，请使用 enter_plan_mode。"
            ),
            payload={"error": "not_in_plan_mode"},
            source="plan_system",
        )

    plan_text = str(args.get("plan_summary") or "")
    steps: list[dict[str, Any]] = []
    for s in (args.get("steps") or []):
        if isinstance(s, dict):
            steps.append({
                "tool": str(s.get("tool", "")),
                "args": s.get("args", {}),
                "reason": str(s.get("reason", "")),
            })

    allowed_prompts: list[dict[str, Any]] = []
    for p in (args.get("allowed_prompts") or []):
        if isinstance(p, dict) and "prompt" in p:
            allowed_prompts.append({
                "tool": str(p.get("tool", "Bash")),
                "prompt": str(p["prompt"]),
            })

    state = _get_plan_state(runtime)
    state.plan_text = plan_text
    state.steps = steps
    state.active = False
    _set_plan_state(runtime, state)

    step_count = len(steps)

    # --- 根据场景返回不同的 tool_result 内容 ---
    if not plan_text.strip() and step_count == 0:
        # 空计划：简单退出
        result_message = "已退出计划模式。你现在可以开始执行分析。"
    else:
        # 有内容的计划：将计划原文返回给 Agent 供参考
        plan_block = f"## 已审批计划\n\n{plan_text}\n"
        if steps:
            plan_block += "\n### 执行步骤\n"
            for i, s in enumerate(steps):
                plan_block += (
                    f"{i + 1}. **{s.get('tool', '')}**"
                    f"({', '.join(f'{k}={v}' for k, v in s.get('args', {}).items())})"
                    f" — {s.get('reason', '')}\n"
                )
        result_message = (
            f"用户已审批你的计划。你现在可以开始执行分析了。"
            f"如有未完成的 todo 列表，请先更新。\n\n{plan_block}"
            f"\n你可以随时参考此计划。"
        )

    return ToolExecutionResult(
        message=result_message,
        payload={
            "plan_summary": plan_text,
            "steps": steps,
            "requires_approval": True,
            "allowed_prompts": allowed_prompts,
            "step_count": step_count,
        },
        source="plan_system",
        feature_count=step_count,
    )
