# +-------------------------------------------------------------------------
#
#   地理智能平台 - SSE 事件边界测试
#
#   文件:       test_sse_event_boundaries.py
#
#   日期:       2026年05月14日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定前端 run hydrate 所依赖的 SSE 终止事件语义。

from __future__ import annotations

from datetime import datetime, timezone

from api_app.routers.runs import _is_terminal_sse_event
from shared_types.schemas import EventType, RunEvent


def test_approval_required_terminates_sse_for_hydration() -> None:
    # approval.required 已经代表后端 run 进入 waiting_approval 快照。
    #
    # 如果 SSE 不在这里终止，前端会继续把 run 当作 running 等待，审批块不稳定显示。
    assert _is_terminal_sse_event(_event(EventType.APPROVAL_REQUIRED)) is True
    assert _is_terminal_sse_event(_event(EventType.CLARIFICATION_REQUIRED)) is True
    assert _is_terminal_sse_event(_event(EventType.RUN_COMPLETED)) is True
    assert _is_terminal_sse_event(_event(EventType.RUN_FAILED)) is True
    assert _is_terminal_sse_event(_event(EventType.TOOL_COMPLETED)) is False


def _event(event_type: EventType) -> RunEvent:
    return RunEvent(
        event_id=f"evt_{event_type.value}",
        run_id="run_test",
        type=event_type,
        message="test",
        timestamp=datetime.now(timezone.utc),
    )
