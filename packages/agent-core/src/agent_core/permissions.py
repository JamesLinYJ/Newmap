# +-------------------------------------------------------------------------
#
#   地理智能平台 - 分层权限规则
#
#   文件:       permissions.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 定义工具调用权限决策链：AlwaysDeny → AlwaysAllow → AlwaysAsk → DenialTracking → 默认行为。
# 独立于 graph.py 的权限判断逻辑，便于未来接入 ML 分类器（Classifier 预留接口）。

from __future__ import annotations

import fnmatch
import logging
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class PermissionRule(BaseModel):
    """权限规则定义

    每条规则包含一个工具匹配模式和对应的决策。
    tool_pattern 支持通配符 * 进行前缀或全局匹配：
    - "geocode_place": 精确匹配工具名 geocode_place
    - "geocode_*": 匹配所有 geocode_ 前缀的工具
    - "*": 匹配所有工具

    decision 取值：
    - 'always_deny': 永远拒绝，工具调用被直接阻止
    - 'always_allow': 永远允许，跳过审批直接执行
    - 'always_ask': 始终询问，触发用户审批流程

    priority 决定规则的优先级（数字越小优先级越高）。
    当多条规则匹配同一个工具时，优先使用 priority 最小的规则。
    """
    tool_pattern: str = Field(..., min_length=1, description="工具名或前缀匹配模式，支持 * 通配符")
    decision: str = Field(..., pattern=r"^(always_allow|always_deny|always_ask)$", description="决策: 'always_allow' | 'always_deny' | 'always_ask'")
    priority: int = Field(default=0, ge=0, le=100, description="优先级，数字越小越优先。")
    description: str = Field(default="", max_length=200, description="规则说明，用于审计和调试。")


def _match_tool_pattern(pattern: str, tool_name: str) -> bool:
    """判断 tool_name 是否匹配 pattern（支持 * 通配符）。

    Args:
        pattern: 匹配模式，如 "geocode_*"、"*"、"geocode_place"。
        tool_name: 实际工具名。

    Returns:
        True 如果工具名匹配模式。
    """
    if "*" in pattern:
        return fnmatch.fnmatch(tool_name, pattern)
    return tool_name == pattern


def evaluate_permission_chain(
    tool_name: str,
    args: dict[str, Any],
    rules: list[PermissionRule],
    denial_counts: dict[str, int],
    *,
    hook_blocked: bool = False,
) -> tuple[bool | None, str | None]:
    """权限决策链求值。

    按 6 层决策链顺序判断：
    1. AlwaysDeny: 永远拒绝 → 返回 (False, block_reason)
    2. AlwaysAllow: 永远允许 → 返回 (False, None)
    3. PreToolUse Hook: 通过 hook_blocked 参数 → 返回 (False, block_reason)
    4. AlwaysAsk: 始终询问 → 返回 (True, None)
    5. DenialTracking: 连续拒绝 ≥3 次后跳过询问 → 返回 (False, None)
    6. 回退 → 返回 (None, None)，由调用方决定默认行为

    Args:
        tool_name: 待评估的工具名。
        args: 工具调用参数字典。
        rules: 权限规则列表。
        denial_counts: 当前拒绝计数字典 {tool_name: count}。
        hook_blocked: PreToolUse Hook 是否阻断了调用。

    Returns:
        (needs_approval, block_reason):
        - needs_approval: True=需要审批，False=不需要，None=由调用方决定
        - block_reason: 如果不为 None，表示执行被拒绝（AlwaysDeny 或 Hook 阻断）
    """
    # 将 rules 按优先级排序（数字越小越优先）
    sorted_rules = sorted(rules, key=lambda r: r.priority)

    # ========== 第 1 层: AlwaysDeny — 永远拒绝 ==========
    denied = False
    deny_reason: str | None = None
    for rule in sorted_rules:
        if rule.decision == "always_deny" and _match_tool_pattern(rule.tool_pattern, tool_name):
            denied = True
            deny_reason = f"工具 {tool_name} 已被系统策略禁止执行（规则: {rule.description or rule.tool_pattern}）。"
            logger.info("权限 [AlwaysDeny] 阻止 %s: %s", tool_name, rule.description or rule.tool_pattern)
            break
    if denied:
        # AlwaysDeny 会覆盖同一工具的其他非拒绝规则
        return False, deny_reason

    # ========== 第 2 层: AlwaysAllow — 永远允许 ==========
    for rule in sorted_rules:
        if rule.decision == "always_allow" and _match_tool_pattern(rule.tool_pattern, tool_name):
            logger.debug("权限 [AlwaysAllow] 放行 %s: %s", tool_name, rule.description or rule.tool_pattern)
            return False, None

    # ========== 第 3 层: PreToolUse Hook 阻断 ==========
    if hook_blocked:
        logger.info("权限 [HookBlocked] 阻止 %s", tool_name)
        return False, f"PreToolUse Hook 阻止了工具 {tool_name} 的调用。"

    # ========== 第 4 层: AlwaysAsk — 始终询问（DenialTracking 优先覆盖） ==========
    always_ask_matched = False
    for rule in sorted_rules:
        if rule.decision == "always_ask" and _match_tool_pattern(rule.tool_pattern, tool_name):
            always_ask_matched = True
            break

    if always_ask_matched:
        # 第 5 层: DenialTracking — 连续拒绝 >=3 次后跳过询问，退回让模型决定
        current_denial_count = denial_counts.get(tool_name, 0)
        if current_denial_count >= 3:
            logger.info(
                "权限 [DenialTracking] 覆盖 AlwaysAsk: %s 已被连续拒绝 %d 次",
                tool_name,
                current_denial_count,
            )
            return False, None
        logger.info("权限 [AlwaysAsk] 要求审批 %s", tool_name)
        return True, None

    # ========== 第 6 层（无 AlwaysAsk 匹配时的 DenialTracking） ==========
    current_denial_count = denial_counts.get(tool_name, 0)
    if current_denial_count >= 3:
        logger.info(
            "权限 [DenialTracking] 跳过审批: %s 已被连续拒绝 %d 次",
            tool_name,
            current_denial_count,
        )
        return False, None

    # ========== 第 7 层: 回退 — 由调用方决定默认行为 ==========
    return None, None
