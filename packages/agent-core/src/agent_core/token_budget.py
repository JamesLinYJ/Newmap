# +-------------------------------------------------------------------------
#
#   地理智能平台 - Token 预算追踪器
#
#   文件:       token_budget.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 追踪每次 Agent 运行的 token 消耗，在接近上限时执行保护措施。
# BudgetTracker 接收每次 API 调用的 usage 信息，更新 TokenBudget 状态，
# 并提供 can_continue / should_renew 等语义判断，让上层在预算迫近时
# 主动缩短输出、申请续期或提前终止。

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 预算状态枚举
# ---------------------------------------------------------------------------

class BudgetStatus(str, Enum):
    """Token 预算状态枚举。

    normal:     预算充足，正常运行。
    warning:    已超过警告阈值，建议关注消耗速度。
    critical:   已超过临界阈值，建议立即采取保护措施。
    exceeded:   已超出预算上限，不能继续执行。
    """
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"
    EXCEEDED = "exceeded"


# ---------------------------------------------------------------------------
# TokenBudget
# ---------------------------------------------------------------------------

@dataclass
class TokenBudget:
    """Token 预算状态。

    记录单次 Agent 运行的总预算上限和当前消耗量，
    提供阈值判断和续期能力。

    Attributes:
        total_limit:        总 token 预算上限。
        used_tokens:        已消耗 token 数。
        warning_threshold:  警告阈值比例（0.0 ~ 1.0），超过此比例返回 warning。
        critical_threshold: 临界阈值比例（0.0 ~ 1.0），超过此比例返回 critical。
        turn_count:         当前轮次数（每轮 API 调用计为 1）。
        last_renewal_turn:  上次续期的轮次，用于限制续期频率。
    """
    total_limit: int
    used_tokens: int = 0
    warning_threshold: float = 0.7
    critical_threshold: float = 0.9
    turn_count: int = 0
    last_renewal_turn: int = 0

    def __post_init__(self) -> None:
        """初始化校验。"""
        if self.total_limit <= 0:
            raise ValueError(f"total_limit 必须为正数，当前值：{self.total_limit}")
        if not 0.0 < self.warning_threshold < 1.0:
            raise ValueError(f"warning_threshold 必须在 0~1 之间，当前值：{self.warning_threshold}")
        if not 0.0 < self.critical_threshold < 1.0:
            raise ValueError(f"critical_threshold 必须在 0~1 之间，当前值：{self.critical_threshold}")
        if self.warning_threshold >= self.critical_threshold:
            raise ValueError(
                f"warning_threshold（{self.warning_threshold}）必须小于 "
                f"critical_threshold（{self.critical_threshold}）"
            )

    def consume(self, prompt_tokens: int, completion_tokens: int) -> BudgetStatus:
        """消费 token，返回当前预算状态。

        Args:
            prompt_tokens:     本轮 prompt token 数。
            completion_tokens: 本轮 completion token 数。

        Returns:
            更新后的预算状态。
        """
        self.used_tokens += prompt_tokens + completion_tokens
        self.turn_count += 1
        return self.status

    @property
    def status(self) -> BudgetStatus:
        """根据当前使用量判断预算状态。"""
        if self.used_tokens >= self.total_limit:
            return BudgetStatus.EXCEEDED
        usage_ratio = self.used_tokens / self.total_limit
        if usage_ratio >= self.critical_threshold:
            return BudgetStatus.CRITICAL
        if usage_ratio >= self.warning_threshold:
            return BudgetStatus.WARNING
        return BudgetStatus.NORMAL

    def can_continue(self) -> bool:
        """判断是否可继续执行（未超过临界阈值）。

        Returns:
            未超过临界阈值返回 True，否则返回 False。
        """
        return self.status not in (BudgetStatus.CRITICAL, BudgetStatus.EXCEEDED)

    def should_renew(self) -> bool:
        """判断是否需要申请预算续期。

        条件：超过警告阈值 + 距离上次续期超过 5 轮。
        避免高频续期申请对运行流程的干扰。

        Returns:
            需要续期返回 True。
        """
        if self.status == BudgetStatus.EXCEEDED:
            return False  # 已超限，续期也无法挽救
        if self.status not in (BudgetStatus.WARNING, BudgetStatus.CRITICAL):
            return False
        # 距离上次续期至少间隔 5 轮
        return (self.turn_count - self.last_renewal_turn) >= 5

    def request_renewal(self, additional_tokens: int) -> None:
        """续期预算：增加预算上限。

        Args:
            additional_tokens: 增加的 token 数。
        """
        if additional_tokens <= 0:
            logger.warning("续期 token 数必须为正数，忽略：%d", additional_tokens)
            return
        self.total_limit += additional_tokens
        self.last_renewal_turn = self.turn_count
        logger.info(
            "Token 预算已续期，新增 %d token，总上限：%d，当前已用：%d",
            additional_tokens, self.total_limit, self.used_tokens,
        )

    @property
    def remaining(self) -> int:
        """剩余 token 数。"""
        return max(0, self.total_limit - self.used_tokens)

    @property
    def usage_ratio(self) -> float:
        """当前使用比例（0.0 ~ 1.0）。"""
        if self.total_limit <= 0:
            return 0.0
        return min(1.0, self.used_tokens / self.total_limit)


# ---------------------------------------------------------------------------
# BudgetTracker
# ---------------------------------------------------------------------------

class BudgetTracker:
    """Token 预算追踪器。

    每次 API 调用完成后接收 usage 信息并更新 TokenBudget，
    提供人类可读的状态消息用于日志和 prompt 注入。

    Usage:
        tracker = BudgetTracker(total_token_budget=200000)
        status = tracker.track_response({"input_tokens": 1500, "output_tokens": 3200})
        if not tracker.budget.can_continue():
            # 执行保护措施
            pass
        message = tracker.get_status_message()
    """

    def __init__(self, total_token_budget: int = 200000):
        """初始化 BudgetTracker。

        Args:
            total_token_budget: 单次 Agent 运行的总 token 预算上限。
        """
        self.budget = TokenBudget(total_limit=total_token_budget)

    def track_response(self, usage: dict[str, Any] | None) -> BudgetStatus:
        """从 API usage 字典中提取 token 消耗并更新预算。

        兼容 OpenAI / Anthropic / DeepSeek 等不同 usage 格式。

        Args:
            usage: API 返回的 usage 字典，可能包含：
                - input_tokens / output_tokens (OpenAI)
                - prompt_tokens / completion_tokens (Anthropic)
                - input_tokens / output_tokens (DeepSeek)

        Returns:
            更新后的预算状态。
        """
        if usage is None:
            return self.budget.status

        # 尝试多种常见 usage 字段名
        prompt_tokens = (
            usage.get("input_tokens") or
            usage.get("prompt_tokens") or
            0
        )
        completion_tokens = (
            usage.get("output_tokens") or
            usage.get("completion_tokens") or
            0
        )
        # 尝试将可能的值转为 int
        try:
            prompt_tokens = int(prompt_tokens) if prompt_tokens else 0
        except (TypeError, ValueError):
            prompt_tokens = 0
        try:
            completion_tokens = int(completion_tokens) if completion_tokens else 0
        except (TypeError, ValueError):
            completion_tokens = 0

        return self.budget.consume(prompt_tokens, completion_tokens)

    def get_status_message(self) -> str:
        """生成人类可读的预算状态消息，可注入到 prompt 中供 Agent 参考。

        Returns:
            预算状态中文描述字符串。当预算充足时返回空字符串，
            避免不必要的 prompt 噪音。
        """
        if self.budget.status == BudgetStatus.NORMAL:
            return ""
        ratio = self.budget.usage_ratio
        remaining = self.budget.remaining
        status_map = {
            BudgetStatus.WARNING: (
                f"注意：Token 预算已使用 {ratio:.0%}，剩余约 {remaining} tokens。"
                f"请尽量精简后续工具调用和输出。"
            ),
            BudgetStatus.CRITICAL: (
                f"警告：Token 预算已使用 {ratio:.0%}，仅剩约 {remaining} tokens。"
                f"必须大幅精简后续输出，优先完成最核心的步骤。"
            ),
            BudgetStatus.EXCEEDED: (
                f"Token 预算已耗尽，无法继续执行。"
            ),
        }
        return status_map.get(self.budget.status, "")
