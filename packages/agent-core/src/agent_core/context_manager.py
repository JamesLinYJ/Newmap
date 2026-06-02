"""
===============================================================================
 AGENTS.md — context_manager.py
===============================================================================
  File:        src/services/compact/context_manager.py
               - AutoCompactTrackingState  — 自动压缩追踪 (autoCompact.ts:51-59)
               - ToolResultBudget          — 累积工具结果 Token 预算 (query.ts)
               - Microcompact              — 微观压缩 (microCompact.ts)
               - SnipCompact               — 历史剪枝 (query.ts:396-409)
               - AutoCompact               — 自动压缩编排 (autoCompact.ts)
               - ReactiveCompact           — 响应式 PTL 恢复 (compact.ts:243-291)
               - CompactionBoundaryMessage — 压缩边界消息
               - AgentContextManager       — 对外公开的 Facade

  Licensed under the MIT License.
===============================================================================
"""

from __future__ import annotations

import json
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

# ---------------------------------------------------------------------------
# 常量 — 对应 Agent SDK autoCompact.ts / microCompact.ts
# ---------------------------------------------------------------------------

AUTOCOMPACT_BUFFER_TOKENS: int = 13000
"""自动压缩缓冲区：context_window 减去此值得到触发阈值。"""

WARNING_THRESHOLD_BUFFER_TOKENS: int = 20000
"""警告阈值缓冲区：阈值减去此值得到警告线。"""

ERROR_THRESHOLD_BUFFER_TOKENS: int = 20000
"""错误阈值缓冲区：阈值减去此值得到错误线。"""

MANUAL_COMPACT_BUFFER_TOKENS: int = 3000
"""手动压缩缓冲区：阻止用户操作的硬限制缓冲区。"""

MAX_OUTPUT_TOKENS_FOR_SUMMARY: int = 20000
"""压缩摘要最大输出 tokens。p99.99 compact summary = 17,387 tokens。"""

MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: int = 3
"""连续自动压缩失败次数断路器上限。防止死循环重试。"""

IMAGE_MAX_TOKEN_SIZE: int = 2000
"""图片/文档类型 block 的近似 token 大小。"""

TIME_BASED_MC_CLEARED_MESSAGE: str = "[Old tool result content cleared]"
"""基于时间的微压缩：旧工具结果被替换为此标记字符串。"""

MAX_PTL_RETRIES: int = 3
"""Prompt-Too-Long 最大重试次数。"""

PTL_RETRY_MARKER: str = "[earlier conversation truncated for compaction retry]"
"""PTL 重试时插入的合成 user 消息内容。"""

# ---------------------------------------------------------------------------
# 类型别名
# ---------------------------------------------------------------------------

MessageDict = dict[str, Any]
"""单条消息的字典表示。"""


# ===================================================================
# 1. AutoCompactTrackingState — Agent SDK autoCompact.ts:51-59
# ===================================================================

@dataclass
class AutoCompactTrackingState:
    """自动压缩追踪状态。每次查询迭代开始前更新。


    turn_counter: 从压缩后开始计数的轮次（压缩后重置为0）。
    turn_id:      每轮唯一 ID (uuid4 hex)。
    compacted:    本轮是否已执行过压缩。
    consecutive_failures: 连续自动压缩失败次数，成功后重置。
                          用作断路器，达到 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
                          后停止重试（CC:58-60）。
    """

    turn_counter: int = 0
    turn_id: str = ""
    compacted: bool = False
    consecutive_failures: int = 0


# ===================================================================
# 2. ToolResultBudget — Agent SDK query.ts toolResultBudget 累积逻辑
# ===================================================================

@dataclass
class ConsumeResult:
    """consume() 的返回值。"""

    display_text: str
    truncated: bool


@dataclass
class ToolResultBudget:
    """累积工具结果 token 预算。每次工具执行后调用 consume()。

    预算上限默认 80K tokens。超出后所有后续工具结果均被截断。

    max_tokens:  预算上限（默认 80000）。
    used_tokens: 已消耗的 token 数。
    truncated:   是否已触发截断。
    """

    max_tokens: int = 80000
    used_tokens: int = 0
    truncated: bool = False

    def consume(self, result_text: str) -> ConsumeResult:
        """消耗工具结果文本。返回 (可展示文本, 是否被截断)。

        如果累积预算已超限，则返回空字符串标记；否则正常返回原文。
        """
        # WHY: 使用与 Agent SDK roughTokenCountEstimation 一致的 4 字符/token 估算
        result_tokens = max(1, len(result_text) // 4)

        if self.truncated:
            # 预算已超限，不再累积
            return ConsumeResult(display_text="", truncated=True)

        if self.used_tokens + result_tokens > self.max_tokens:
            # 本次执行导致预算超限 → 标记截断并返回空
            self.truncated = True
            return ConsumeResult(display_text="", truncated=True)

        self.used_tokens += result_tokens
        return ConsumeResult(display_text=result_text, truncated=False)

    def reset(self) -> None:
        """重置预算状态。"""
        self.used_tokens = 0
        self.truncated = False


# ===================================================================
# 3. Microcompact — Agent SDK microCompact.ts 核心逻辑
# ===================================================================

# 只有这些工具的结果会被微压缩
COMPACTABLE_TOOLS: set[str] = {
    "file_read",
    "bash", "powershell", "cmd", "shell",  # SHELL_TOOL_NAMES
    "grep",
    "glob",
    "web_search",
    "web_fetch",
    "file_edit",
    "file_write",
}

_TIME_BASED_CLEARED = TIME_BASED_MC_CLEARED_MESSAGE


def rough_token_estimate(content: str, bytes_per_token: int = 4) -> int:
    """估算字符串的 token 数。

    roughTokenCountEstimation(content, bytesPerToken=4)
    """
    return max(1, len(content) // bytes_per_token)


def _calculate_tool_result_tokens(block: dict[str, Any]) -> int:
    """计算 tool_result block 的 token 数。

    """
    content = block.get("content")
    if content is None:
        return 0

    if isinstance(content, str):
        return rough_token_estimate(content)

    if isinstance(content, list):
        total = 0
        for item in content:
            if not isinstance(item, dict):
                continue
            t = item.get("type", "")
            if t == "text":
                total += rough_token_estimate(item.get("text", ""))
            elif t in ("image", "document"):
                total += IMAGE_MAX_TOKEN_SIZE
            else:
                total += rough_token_estimate(json.dumps(item, ensure_ascii=False))
        return total

    return rough_token_estimate(json.dumps(content, ensure_ascii=False))


def estimate_messages_tokens(messages: list[MessageDict]) -> int:
    """估算消息列表的 token 总数（保守上估）。

    使用 4/3 padding 因子以保守估算。
    """
    total = 0
    for msg in messages:
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue
            t = block.get("type", "")
            if t == "text":
                total += rough_token_estimate(block.get("text", ""))
            elif t == "tool_result":
                total += _calculate_tool_result_tokens(block)
            elif t in ("image", "document"):
                total += IMAGE_MAX_TOKEN_SIZE
            elif t == "thinking":
                total += rough_token_estimate(block.get("thinking", ""))
            elif t == "redacted_thinking":
                total += rough_token_estimate(block.get("data", ""))
            elif t == "tool_use":
                name = block.get("name", "")
                inp = block.get("input", {})
                total += rough_token_estimate(
                    name + json.dumps(inp, ensure_ascii=False)
                )
            else:
                total += rough_token_estimate(
                    json.dumps(block, ensure_ascii=False)
                )

    # WHY: 4/3 padding 因子 — Agent SDK microCompact.ts:204
    return math.ceil(total * 4 / 3)


@dataclass
class MicrocompactResult:
    """微压缩结果元数据。

    """

    messages: list[MessageDict] = field(default_factory=list)
    tokens_saved: int = 0
    cleared_tool_ids: list[str] = field(default_factory=list)


def _collect_compactable_tool_ids(messages: list[MessageDict]) -> list[str]:
    """收集所有可压缩的 tool_use ID。

    """
    ids: list[str] = []
    for msg in messages:
        role = msg.get("role", "")
        if role != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") in COMPACTABLE_TOOLS:
                tid = block.get("id") or block.get("tool_use_id")
                if tid:
                    ids.append(tid)
    return ids


@dataclass
class TimeBasedMCConfig:
    """时间基准微压缩配置。

    """
    enabled: bool = False
    gap_threshold_minutes: int = 60
    keep_recent: int = 5


def get_time_based_mc_config() -> TimeBasedMCConfig:
    """获取时间基准微压缩配置。

    在生产代码中，此配置来自 GrowthBook/远程配置。
    此处返回硬编码默认值。
    """
    return TimeBasedMCConfig(
        enabled=False,        # 默认关闭
        gap_threshold_minutes=60,
        keep_recent=5,
    )


def _evaluate_time_based_trigger(
    messages: list[MessageDict],
    query_source: str | None = None,
) -> tuple[int, TimeBasedMCConfig] | None:
    """评估时间基准触发条件。


    返回 (gap_minutes, config) 当触发条件满足，否则 None。
    """
    config = get_time_based_mc_config()
    if not config.enabled:
        return None

    # WHY: 只对主线程触发 — microCompact.ts:431-433
    if query_source is None:
        return None

    # 找到最后一条 assistant 消息
    last_assistant: MessageDict | None = None
    for msg in reversed(messages):
        if msg.get("role") == "assistant":
            last_assistant = msg
            break

    if last_assistant is None:
        return None

    # 解析时间戳
    ts_str = last_assistant.get("timestamp", "")
    if not ts_str:
        return None

    try:
        # 支持 ISO 格式和 Unix 时间戳
        if ts_str.isdigit() or (ts_str.startswith("-") and ts_str[1:].isdigit()):
            ts = datetime.fromtimestamp(float(ts_str) / 1000.0, tz=timezone.utc)
        else:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None

    now = datetime.now(timezone.utc)
    gap_minutes = (now - ts).total_seconds() / 60.0

    if not math.isfinite(gap_minutes) or gap_minutes < config.gap_threshold_minutes:
        return None

    return int(gap_minutes), config


def microcompact_messages(
    messages: list[MessageDict],
    tool_result_budget: ToolResultBudget | None = None,
    compactable_tools: set[str] | None = None,
    query_source: str | None = None,
) -> tuple[list[MessageDict], MicrocompactResult]:
    """对消息列表执行微观压缩。


    只修改 tool 角色的消息（tool_result）。
    对每条 tool_result：
    1. 如果 tool_name 不在 compactable_tools 中，跳过
    2. 如果累积预算已超限，截断到标记长度
    3. 对超长 tool_result，保留前后各 1/3
    4. 更新 tool_result_budget

    步骤：
    1. 检查时间基准触发（time-based microcompact）
    2. 执行常规微压缩

    Args:
        messages:           待压缩的消息列表。
        tool_result_budget: 累积预算追踪器（可选）。
        compactable_tools:  可压缩的工具名称集合，默认 COMPACTABLE_TOOLS。
        query_source:       查询来源标识（用于时间基准触发过滤）。

    Returns:
        (压缩后消息列表, 压缩结果元数据)
    """
    if compactable_tools is None:
        compactable_tools = COMPACTABLE_TOOLS

    # ---- 步骤 1: 时间基准触发检查 ----
    time_trigger = _evaluate_time_based_trigger(messages, query_source)
    if time_trigger is not None:
        gap_minutes, config = time_trigger
        return _apply_time_based_microcompact(messages, gap_minutes, config)

    # ---- 步骤 2: 常规微压缩 ----
    # WHY: 只对 tool_result 消息进行压缩，保留所有其他消息不变
    # CC: microcompact 压缩可压缩工具的结果，保留前后 1/3
    result = MicrocompactResult()
    budget = tool_result_budget

    compactable_ids = set(_collect_compactable_tool_ids(messages))

    # 构建 tool_use_id → tool_name 的映射（从 assistant 消息中提取）
    tool_id_to_name: dict[str, str] = {}
    for msg in messages:
        role = msg.get("role", "")
        if role != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                tid = block.get("id") or block.get("tool_use_id")
                if tid:
                    tool_id_to_name[tid] = block.get("name", "")

    new_messages: list[MessageDict] = []
    for msg in messages:
        role = msg.get("role", "")
        if role != "user":
            new_messages.append(msg)
            continue

        content = msg.get("content")
        if not isinstance(content, list):
            new_messages.append(msg)
            continue

        modified = False
        new_content: list[dict[str, Any]] = []
        for block in content:
            if not isinstance(block, dict):
                new_content.append(block)
                continue

            if block.get("type") != "tool_result":
                new_content.append(block)
                continue

            tool_use_id = block.get("tool_use_id", "")
            tool_name = tool_id_to_name.get(tool_use_id, "")

            # (A) 跳过不可压缩的工具 — Agent SDK microCompact.ts:41-50
            if tool_name not in compactable_tools:
                new_content.append(block)
                continue

            # (B) 提取 block 文本内容用于预算/截断判断
            block_text = _extract_tool_result_text(block)

            # (C) 预算检查 — Agent SDK query.ts toolResultBudget
            if budget is not None:
                consume_result = budget.consume(block_text)
                if consume_result.truncated:
                    # 预算超限，截断此结果
                    new_content.append({
                        **block,
                        "content": "[Tool result truncated due to budget limit]",
                    })
                    result.tokens_saved += _calculate_tool_result_tokens(block)
                    result.cleared_tool_ids.append(tool_use_id)
                    modified = True
                    continue

            # (D) 对超长 tool_result 执行首尾保留 — Agent SDK microcompact 截断模式
            # 保留前 1/3 + 后 1/3，中间替换为省略标记
            truncated_block = _truncate_tool_result(block)
            if truncated_block is not block:
                modified = True
                # 计算节省的 token
                orig_tokens = _calculate_tool_result_tokens(block)
                new_tokens = _calculate_tool_result_tokens(truncated_block)
                saved = orig_tokens - new_tokens
                if saved > 0:
                    result.tokens_saved += saved
                    result.cleared_tool_ids.append(tool_use_id)

            new_content.append(truncated_block)

        if modified:
            new_messages.append({**msg, "content": new_content})
        else:
            new_messages.append(msg)

    result.messages = new_messages
    return new_messages, result


def _extract_tool_result_text(block: dict[str, Any]) -> str:
    """从 tool_result block 中提取文本内容。"""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(item.get("text", ""))
        return "\n".join(texts)
    return json.dumps(content, ensure_ascii=False) if content else ""


def _truncate_tool_result(block: dict[str, Any]) -> dict[str, Any]:
    """对超长 tool_result 执行首尾保留截断。

    - 保留 result 的前 1/3 + 后 1/3
    - 中间替换为省略标记
    - 保留 tool_use_id 和 type 不做修改
    """
    content = block.get("content")
    threshold = 2000  # WHY: 超过此字符数进行截断的阈值

    if isinstance(content, str) and len(content) > threshold:
        third = len(content) // 3
        head = content[:third]
        tail = content[-third:]
        omitted = len(content) - 2 * third
        return {
            **block,
            "content": f"{head}\n[... {omitted} characters omitted ...]\n{tail}",
        }

    if isinstance(content, list):
        new_content: list[dict[str, Any]] = []
        modified = False
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "")
                if len(text) > threshold:
                    third = len(text) // 3
                    head = text[:third]
                    tail = text[-third:]
                    omitted = len(text) - 2 * third
                    new_content.append({
                        **item,
                        "text": f"{head}\n[... {omitted} characters omitted ...]\n{tail}",
                    })
                    modified = True
                else:
                    new_content.append(item)
            else:
                new_content.append(item)
        if modified:
            return {**block, "content": new_content}

    return block


def _apply_time_based_microcompact(
    messages: list[MessageDict],
    gap_minutes: int,
    config: TimeBasedMCConfig,
) -> tuple[list[MessageDict], MicrocompactResult]:
    """执行基于时间的微压缩。


    当距离最后一条 assistant 消息的时间间隔超过阈值时，
    将旧的可压缩工具结果内容清除为固定标记。
    """
    compactable_ids = _collect_compactable_tool_ids(messages)

    keep_recent = max(1, config.keep_recent)
    keep_set = set(compactable_ids[-keep_recent:])
    clear_set = [tid for tid in compactable_ids if tid not in keep_set]

    if not clear_set:
        return messages, MicrocompactResult()

    tokens_saved = 0
    result_messages: list[MessageDict] = []

    for msg in messages:
        role = msg.get("role", "")
        if role != "user":
            result_messages.append(msg)
            continue

        content = msg.get("content")
        if not isinstance(content, list):
            result_messages.append(msg)
            continue

        touched = False
        new_content: list[dict[str, Any]] = []
        for block in content:
            if not isinstance(block, dict):
                new_content.append(block)
                continue
            if (
                block.get("type") == "tool_result"
                and block.get("tool_use_id") in clear_set
                and block.get("content") != _TIME_BASED_CLEARED
            ):
                tokens_saved += _calculate_tool_result_tokens(block)
                touched = True
                new_content.append({**block, "content": _TIME_BASED_CLEARED})
            else:
                new_content.append(block)

        if touched:
            result_messages.append({**msg, "content": new_content})
        else:
            result_messages.append(msg)

    if tokens_saved == 0:
        return messages, MicrocompactResult()

    return result_messages, MicrocompactResult(
        messages=result_messages,
        tokens_saved=tokens_saved,
        cleared_tool_ids=clear_set,
    )


# ===================================================================
# 4. SnipCompact — Agent SDK query.ts:396-409 历史剪枝
# ===================================================================

@dataclass
class SnipCompactResult:
    """历史剪枝压缩结果。


    messages:        剪枝后的消息列表。
    tokens_freed:    释放的 token 数。
    boundary_message: 可选的边界标记消息 (user role, isMeta=True)。
    rounds_removed:  移除的 API round 数。
    """

    messages: list[MessageDict]
    tokens_freed: int
    boundary_message: MessageDict | None = None
    rounds_removed: int = 0


def _group_messages_by_api_round(messages: list[MessageDict]) -> list[list[MessageDict]]:
    """将消息按 API round 分组。


    每组对应一次 API 往返（assistant → tool_results）。
    边界条件：遇到新的 assistant id 时切分。
    """
    groups: list[list[MessageDict]] = []
    current: list[MessageDict] = []
    last_assistant_id: str | None = None

    for msg in messages:
        role = msg.get("role", "")
        if role == "assistant":
            msg_id = msg.get("id", "")
            if msg_id != last_assistant_id and current:
                groups.append(current)
                current = [msg]
            else:
                current.append(msg)
            last_assistant_id = msg_id
        else:
            current.append(msg)

    if current:
        groups.append(current)

    return groups


def snip_compact_if_needed(
    messages: list[MessageDict],
    max_tokens: int | None = None,
) -> SnipCompactResult:
    """逐轮剪枝：从最旧的轮次开始整轮移除。


    消息按 API round 分组（每组 = assistant → tool_results）。
    从最旧的非系统 round 开始移除整组，
    直到 token 数降到目标以下或只剩 2 轮。

    如果移除了任何轮次，插入 boundaryMessage：
    {
        "role": "user",
        "content": "[Earlier conversation has been trimmed to manage context size. ...]",
        "isMeta": True
    }

    Args:
        messages:  待剪枝的消息列表。
        max_tokens: 目标最大 token 数。如果为 None，自动计算。

    Returns:
        SnipCompactResult 包含剪枝后的消息和释放的 token 数。
    """
    if not messages:
        return SnipCompactResult(messages=messages, tokens_freed=0, rounds_removed=0)

    total_tokens = estimate_messages_tokens(messages)

    # WHY: 默认目标为总 tokens 的 75%，或小于 1000 则不处理
    if max_tokens is None:
        max_tokens = max(total_tokens - 5000, int(total_tokens * 0.75))

    if total_tokens <= max_tokens:
        return SnipCompactResult(messages=messages, tokens_freed=0, rounds_removed=0)

    # 按 API round 分组
    groups = _group_messages_by_api_round(messages)

    # 保留至少 2 轮
    min_rounds = 2
    if len(groups) <= min_rounds:
        return SnipCompactResult(messages=messages, tokens_freed=0, rounds_removed=0)

    # 从最旧的 round 开始移除（跳过第一组，因为它通常是系统消息/前缀）
    # WHY: groups[0] 是前缀（可能包含系统消息），从 groups[1] 开始剪枝
    tokens_freed = 0
    rounds_removed = 0
    groups_to_keep = [groups[0]]  # 保留前缀

    for i in range(1, len(groups)):
        if len(groups_to_keep) + (len(groups) - i) < min_rounds:
            # 不能再移除了，保留足够轮次
            groups_to_keep.extend(groups[i:])
            break

        group_tokens = estimate_messages_tokens(groups[i])
        if total_tokens - tokens_freed - group_tokens >= max_tokens:
            tokens_freed += group_tokens
            rounds_removed += 1
        else:
            groups_to_keep.append(groups[i])

    # 超过 min_rounds 限制，继续移除
    while len(groups_to_keep) > min_rounds and rounds_removed > 0:
        # 检查 groups_to_keep[1] 是否可以移除
        if len(groups_to_keep) > 2:
            group_tokens = estimate_messages_tokens(groups_to_keep[1])
            if total_tokens - tokens_freed - group_tokens >= max_tokens:
                tokens_freed += group_tokens
                rounds_removed += 1
                groups_to_keep.pop(1)
            else:
                break
        else:
            break

    if rounds_removed == 0:
        return SnipCompactResult(messages=messages, tokens_freed=0, rounds_removed=0)

    # 展平保留的组
    trimmed_messages: list[MessageDict] = []
    for g in groups_to_keep:
        trimmed_messages.extend(g)

    # 插入边界标记消息 — Agent SDK query.ts 插入 isMeta user 消息
    boundary_message: MessageDict = {
        "role": "user",
        "content": (
            "[Earlier conversation has been trimmed to manage context size. "
            "The key context has been preserved above.]"
        ),
        "isMeta": True,
    }

    return SnipCompactResult(
        messages=[trimmed_messages[0], boundary_message] + trimmed_messages[1:],
        tokens_freed=tokens_freed,
        boundary_message=boundary_message,
        rounds_removed=rounds_removed,
    )


# ===================================================================
# 5. AutoCompact — Agent SDK autoCompact.ts 自动压缩编排
# ===================================================================

def _get_context_window_for_model(model: str) -> int:
    """获取模型的上下文窗口大小。


    默认映射：
    - claude-3-5-sonnet / claude-3-opus: 200K
    - claude-3-haiku: 200K
    - 其他: 200K
    """
    return 200_000  # WHY: 默认 200K context window


def _get_max_output_tokens_for_model(model: str) -> int:
    """获取模型的最大输出 token 数。

    """
    return 8192  # WHY: 默认输出 token 上限


def get_effective_context_window_size(model: str) -> int:
    """获取有效上下文窗口大小（减去摘要输出保留）。


    返回 context_window_size - max_output_tokens_for_summary
    """
    reserved = min(
        _get_max_output_tokens_for_model(model),
        MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    )
    context_window = _get_context_window_for_model(model)
    return context_window - reserved


def get_auto_compact_threshold(model: str) -> int:
    """计算自动压缩的触发阈值。


    threshold = effective_context_window - AUTOCOMPACT_BUFFER_TOKENS
    """
    effective_window = get_effective_context_window_size(model)
    threshold = effective_window - AUTOCOMPACT_BUFFER_TOKENS

    # 在 Python 中可通过 os.environ 读取，此处忽略

    return threshold


def is_auto_compact_enabled() -> bool:
    """检查自动压缩是否启用。


    检查 DISABLE_COMPACT / DISABLE_AUTO_COMPACT 环境变量和用户配置。
    """
    import os

    if os.environ.get("DISABLE_COMPACT", "").lower() in ("1", "true", "yes"):
        return False
    if os.environ.get("DISABLE_AUTO_COMPACT", "").lower() in ("1", "true", "yes"):
        return False
    # WHY: 生产代码中读取用户配置，默认启用
    return True


def calculate_token_warning_state(
    token_usage: int,
    model: str,
) -> dict[str, Any]:
    """计算 token 警告状态。


    返回:
        percentLeft:                剩余百分比
        isAboveWarningThreshold:    是否超过警告线
        isAboveErrorThreshold:      是否超过错误线
        isAboveAutoCompactThreshold: 是否超过自动压缩触发线
        isAtBlockingLimit:          是否达到阻止操作的硬限制
    """
    auto_compact_threshold = get_auto_compact_threshold(model)
    effective_window = get_effective_context_window_size(model)

    threshold = (
        auto_compact_threshold
        if is_auto_compact_enabled()
        else effective_window
    )

    percent_left = max(0, round(((threshold - token_usage) / max(threshold, 1)) * 100))

    warning_threshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
    error_threshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS
    blocking_limit = effective_window - MANUAL_COMPACT_BUFFER_TOKENS

    return {
        "percentLeft": percent_left,
        "isAboveWarningThreshold": token_usage >= warning_threshold,
        "isAboveErrorThreshold": token_usage >= error_threshold,
        "isAboveAutoCompactThreshold": (
            is_auto_compact_enabled() and token_usage >= auto_compact_threshold
        ),
        "isAtBlockingLimit": token_usage >= blocking_limit,
    }


# ===================================================================
# 5a. CompactConversation — 调用模型生成摘要
# ===================================================================

@dataclass
class AutoCompactResult:
    """自动压缩结果元数据。

    """

    was_compacted: bool
    summary: str = ""
    boundary_marker: MessageDict | None = None
    summary_messages: list[MessageDict] = field(default_factory=list)
    pre_compact_token_count: int = 0
    post_compact_token_count: int = 0
    consecutive_failures: int | None = None


def _default_summarize_fn(messages: list[MessageDict], model: str) -> str:
    """默认的摘要生成函数。当模型客户端不可用时使用轻量替代。

    在生产代码中会调用 API。此实现使用基于事实的截断摘要。
    """
    # WHY: 轻量替代方案 — 提取关键信息作为"摘要"
    total = estimate_messages_tokens(messages)

    # 提取各角色消息数
    user_count = sum(1 for m in messages if m.get("role") == "user")
    assistant_count = sum(1 for m in messages if m.get("role") == "assistant")

    # 提取工具调用信息
    tool_calls = 0
    file_ops = 0
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls += 1
                    if block.get("name") in ("file_read", "file_edit", "file_write"):
                        file_ops += 1

    return (
        f"Conversation summary (auto-compacted): "
        f"{user_count} user messages, {assistant_count} assistant messages, "
        f"{tool_calls} tool calls ({file_ops} file operations). "
        f"Total estimated tokens: {total}."
    )


def build_compaction_boundary_message(
    level: str = "auto",
    summary: str = "",
) -> MessageDict:
    """构建压缩边界消息。


    类型: SystemCompactBoundaryMessage
    消息内容告知模型上下文已被压缩，应基于当前可见消息继续。

    Args:
        level:  压缩级别 ("auto" / "manual")。
        summary: 压缩摘要文本。

    Returns:
        边界消息字典，包含 isMeta=True 标记（不展示给用户）。
    """
    return {
        "role": "system",
        "subtype": "compact_boundary",
        "content": f"[Context has been compacted. Previous conversation summarized: {summary}]"
        if summary
        else "[Context has been compacted. The conversation has been summarized to manage context size. Continue based on the current visible messages.]",
        "isMeta": True,
        "level": level,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uuid": uuid.uuid4().hex,
    }


def autocompact_if_needed(
    messages: list[MessageDict],
    model: str,
    tracking_state: AutoCompactTrackingState | None = None,
    tool_result_budget: ToolResultBudget | None = None,
    snip_tokens_freed: int = 0,
    summarize_fn: Callable[[list[MessageDict], str], str] | None = None,
) -> tuple[list[MessageDict], AutoCompactResult]:
    """完整的自动压缩编排。

    + query.ts 的主循环压缩部分。

    流程：
    1. tokenCountWithEstimation(messages) - snipTokensFreed 得到实际 token
    2. 与 autocompact threshold 比较
    3. 断路器检查：连续失败超过 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES 时跳过
    4. 超限时调用 compactConversation（generate summary via model call）
    5. 更新 tracking_state
    6. 注入压缩边界消息（SystemCompactBoundaryMessage）

    Args:
        messages:          待检查的消息列表。
        model:             使用的模型名称。
        tracking_state:    自动压缩追踪状态。
        tool_result_budget: 工具结果预算（可选）。
        snip_tokens_freed:  snip 已释放的 token 数。
        summarize_fn:       摘要生成函数。如果为 None，使用默认轻量实现。

    Returns:
        (压缩后消息列表, 压缩结果元数据)
    """
    if summarize_fn is None:
        summarize_fn = _default_summarize_fn

    # ---- 步骤 1: 断路器检查 — Agent SDK autoCompact.ts:257-265 ----
    if (
        tracking_state is not None
        and tracking_state.consecutive_failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    ):
        return messages, AutoCompactResult(was_compacted=False)

    # ---- 步骤 2: 计算实际 token 数 — Agent SDK autoCompact.ts:225 ----
    token_count = estimate_messages_tokens(messages) - snip_tokens_freed
    threshold = get_auto_compact_threshold(model)

    # ---- 步骤 3: 比较阈值 — Agent SDK autoCompact.ts:233-238 ----
    warning_state = calculate_token_warning_state(token_count, model)
    if not warning_state["isAboveAutoCompactThreshold"]:
        return messages, AutoCompactResult(was_compacted=False)

    # ---- 步骤 4: 执行压缩 — Agent SDK autoCompact.ts:312-321 ----
    pre_compact_count = estimate_messages_tokens(messages)

    try:
        # 调用摘要生成函数（生产代码中为模型调用）
        summary = summarize_fn(messages, model)
    except Exception:
        prev_failures = tracking_state.consecutive_failures if tracking_state else 0
        next_failures = prev_failures + 1
        return messages, AutoCompactResult(
            was_compacted=False,
            consecutive_failures=next_failures,
        )

    # ---- 步骤 5: 构建压缩结果 — Agent SDK compact.ts:598-624 ----
    boundary_marker = build_compaction_boundary_message(
        level="auto",
        summary=summary,
    )

    summary_message: MessageDict = {
        "role": "user",
        "content": f"[Previous conversation summary]:\n{summary}",
        "isCompactSummary": True,
        "isVisibleInTranscriptOnly": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uuid": uuid.uuid4().hex,
    }

    # ---- 步骤 6: 构建压缩后的消息列表 ----
    compacted_messages: list[MessageDict] = [
        boundary_marker,
        summary_message,
    ]

    # ---- 步骤 7: 更新追踪状态 — Agent SDK query.ts:521-526 ----
    if tracking_state is not None:
        tracking_state.compacted = True
        tracking_state.turn_id = uuid.uuid4().hex
        tracking_state.turn_counter = 0
        tracking_state.consecutive_failures = 0

    post_compact_count = estimate_messages_tokens(compacted_messages)

    return compacted_messages, AutoCompactResult(
        was_compacted=True,
        summary=summary,
        boundary_marker=boundary_marker,
        summary_messages=[summary_message],
        pre_compact_token_count=pre_compact_count,
        post_compact_token_count=post_compact_count,
        consecutive_failures=0,
    )


# ===================================================================
# 6. ReactiveCompact — prompt-too-long 恢复 (compact.ts:243-291)
# ===================================================================

@dataclass
class ReactiveCompactResult:
    """响应式压缩结果。"""

    messages: list[MessageDict]
    can_retry: bool
    rounds_removed: int = 0
    tokens_freed: int = 0


def _get_prompt_too_long_token_gap(error_message: str) -> int | None:
    """从 PTL 错误消息中解析需要减少的 token 数。

    """
    # 尝试匹配类似 "expected X, found Y" 的格式
    import re

    # 常见 PTL 错误格式
    patterns = [
        r"expected\s+(\d+)[^,]*,\s*found\s+(\d+)",
        r"reduce\s+by\s+(\d+)\s+tokens?",
        r"maximum\s+context\s+length\s+is\s+(\d+).*?(\d+)",
    ]

    for pattern in patterns:
        match = re.search(pattern, error_message, re.IGNORECASE)
        if match:
            groups = match.groups()
            if len(groups) == 2:
                # expected 和 found: gap = found - expected
                expected = int(groups[0])
                found = int(groups[1])
                if found > expected:
                    return found - expected
            elif len(groups) == 1:
                return int(groups[0])

    return None


def try_reactive_compact(
    messages: list[MessageDict],
    error_message: str,
    tracking_state: AutoCompactTrackingState | None = None,
) -> tuple[list[MessageDict], bool]:
    """响应式压缩：当 API 返回 context_length_exceeded 错误时触发。

    + query.ts 的 PTL 恢复循环。

    流程：
    1. 解析错误消息中的 token_gap（需要减少的 token 数）
    2. 从最旧的 API round 开始逐组移除
    3. 保留至少 1 组用于继续对话
    4. 如果无法再减少，返回 can_retry=False

    Args:
        messages:       导致 PTL 的消息列表。
        error_message:  API 返回的错误消息。
        tracking_state: 自动压缩追踪状态（可选，用于断路器）。

    Returns:
        (恢复后的消息列表, 是否可以重试)
    """
    # 断路器检查
    if (
        tracking_state is not None
        and tracking_state.consecutive_failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    ):
        return messages, False

    # 解析 token gap
    token_gap = _get_prompt_too_long_token_gap(error_message)

    # 按 API round 分组
    groups = _group_messages_by_api_round(messages)

    if len(groups) < 2:
        return messages, False

    # 移除前一条 PTL 重试标记 — Agent SDK compact.ts:250-255
    stripped = messages
    first_msg = messages[0] if messages else {}
    if (
        first_msg.get("role") == "user"
        and first_msg.get("isMeta")
        and first_msg.get("content") == PTL_RETRY_MARKER
    ):
        stripped = messages[1:]

    # 重新分组（去除标记后）
    groups = _group_messages_by_api_round(stripped)
    if len(groups) < 2:
        return messages, False

    # 计算需要移除的组数 — Agent SDK compact.ts:260-272
    if token_gap is not None:
        accumulated = 0
        drop_count = 0
        for g in groups:
            accumulated += estimate_messages_tokens(g)
            drop_count += 1
            if accumulated >= token_gap:
                break
    else:
        # WHY: 无法解析 gap 时，移除 20% 的组 — Agent SDK compact.ts:271
        drop_count = max(1, int(len(groups) * 0.2))

    # 保留至少 1 组 — Agent SDK compact.ts:275
    drop_count = min(drop_count, len(groups) - 1)
    if drop_count < 1:
        return messages, False

    # 移除最旧的 drop_count 组 — Agent SDK compact.ts:278
    sliced = groups[drop_count:]
    flattened: list[MessageDict] = []
    for g in sliced:
        flattened.extend(g)

    # 如果移除后第一条是 assistant，需要插入合成 user 消息 — Agent SDK compact.ts:284-289
    if flattened and flattened[0].get("role") == "assistant":
        flattened = [
            {
                "role": "user",
                "content": PTL_RETRY_MARKER,
                "isMeta": True,
            }
        ] + flattened

    # 计算释放的 token 数
    tokens_freed = estimate_messages_tokens(messages) - estimate_messages_tokens(flattened)

    # 更新追踪状态
    if tracking_state is not None:
        tracking_state.consecutive_failures = (
            tracking_state.consecutive_failures + 1
        )

    return flattened, True


# ===================================================================
# 7. AgentContextManager — 对外公开的 Facade
# ===================================================================

class AgentContextManager:
    """Agent 上下文管理器。对外公开的 Facade。

    整合所有压缩策略的完整编排：
    - snip_compact_if_needed: 历史剪枝（逐轮移除）
    - microcompact_messages:  微观压缩（工具结果截断）
    - autocompact_if_needed:  自动压缩（调用模型生成摘要）
    - try_reactive_compact:   响应式压缩（PTL 恢复）
    """

    def __init__(self, *, store: Any, config: Any, project_root: Path | None = None) -> None:
        """Agent 上下文管理器。

        整合上下文装配（线程上下文 + 记忆）与压缩编排（snip/micro/auto/reactive）。
        """
        self.store = store
        self.config = config
        self.project_root = (project_root or Path.cwd()).resolve()
        self.tracking_state = AutoCompactTrackingState()
        self.tool_result_budget = ToolResultBudget()
        self._compactable_tools: set[str] = set(COMPACTABLE_TOOLS)
        self._memory_manager: Any = None
        # 初始化 MemoryManager（如果目录存在）
        try:
            from .memory import MemoryManager
            memory_root = self.project_root / ".geoagent" / "memory"
            if memory_root.exists():
                self._memory_manager = MemoryManager(memory_root=memory_root)
        except Exception:
            pass

    def reset_tracking(self) -> None:
        """重置追踪状态（例如 /clear 后）。"""
        self.tracking_state = AutoCompactTrackingState()

    def reset_budget(self) -> None:
        """重置工具结果预算。"""
        self.tool_result_budget.reset()

    def update_turn_counter(self) -> None:
        """递增轮次计数器。每次查询迭代开始前调用。"""
        self.tracking_state.turn_counter += 1

    # ---- 公共 API: 单步压缩策略 ----

    def should_auto_compact(self, messages: list[MessageDict]) -> bool:
        """检查是否需要自动压缩。

        """
        if not is_auto_compact_enabled():
            return False

        token_count = estimate_messages_tokens(messages)
        warning_state = calculate_token_warning_state(token_count, "default")
        return warning_state["isAboveAutoCompactThreshold"]

    def get_token_warning_state(self, messages: list[MessageDict]) -> dict[str, Any]:
        """获取当前 token 警告状态。"""
        token_count = estimate_messages_tokens(messages)
        return calculate_token_warning_state(token_count, "default")

    def get_token_usage_info(self, messages: list[MessageDict]) -> dict[str, Any]:
        """获取 token 使用信息。


        Returns:
            包含 current_tokens, max_tokens, percent_left, is_above_threshold 等信息。
        """
        token_count = estimate_messages_tokens(messages)
        threshold = get_auto_compact_threshold("default")
        percent_left = max(0, round(((threshold - token_count) / max(threshold, 1)) * 100))

        return {
            "current_tokens": token_count,
            "max_tokens": threshold,
            "context_window": get_effective_context_window_size("default"),
            "percent_left": percent_left,
            "is_above_warning": token_count >= threshold - WARNING_THRESHOLD_BUFFER_TOKENS,
            "is_above_error": token_count >= threshold - ERROR_THRESHOLD_BUFFER_TOKENS,
            "is_above_auto_compact_threshold": (
                is_auto_compact_enabled() and token_count >= threshold
            ),
        }

    # ---- 公共 API: 完整压缩编排 ----

    def run_snip_compact(
        self,
        messages: list[MessageDict],
        max_tokens: int | None = None,
    ) -> SnipCompactResult:
        """执行历史剪枝。

        """
        return snip_compact_if_needed(messages, max_tokens=max_tokens)

    def run_microcompact(
        self,
        messages: list[MessageDict],
        query_source: str | None = None,
    ) -> tuple[list[MessageDict], MicrocompactResult]:
        """执行微观压缩。

        """
        return microcompact_messages(
            messages,
            tool_result_budget=self.tool_result_budget,
            compactable_tools=self._compactable_tools,
            query_source=query_source,
        )

    def run_autocompact(
        self,
        messages: list[MessageDict],
        snip_tokens_freed: int = 0,
        summarize_fn: Callable[[list[MessageDict], str], str] | None = None,
    ) -> tuple[list[MessageDict], AutoCompactResult]:
        """执行自动压缩。

        """
        return autocompact_if_needed(
            messages,
            "default",
            tracking_state=self.tracking_state,
            tool_result_budget=self.tool_result_budget,
            snip_tokens_freed=snip_tokens_freed,
            summarize_fn=summarize_fn,
        )

    def run_reactive_compact(
        self,
        messages: list[MessageDict],
        error_message: str,
    ) -> tuple[list[MessageDict], bool]:
        """执行响应式压缩（PTL 恢复）。


        Args:
            messages:      导致 PTL 的消息列表。
            error_message: API 返回的错误消息。

        Returns:
            (恢复后的消息列表, 是否可以重试)
        """
        return try_reactive_compact(
            messages,
            error_message,
            tracking_state=self.tracking_state,
        )

    def run_full_compact_pipeline(
        self,
        messages: list[MessageDict],
        query_source: str | None = None,
        summarize_fn: Callable[[list[MessageDict], str], str] | None = None,
    ) -> tuple[list[MessageDict], dict[str, Any]]:
        """执行完整的压缩管道。

        1. SnipCompact (if applicable)
        2. Microcompact
        3. AutoCompact

        此方法按顺序执行所有压缩策略，每一步的输出作为下一步的输入。

        Args:
            messages:     待压缩的消息列表。
            query_source: 查询来源标识。
            summarize_fn: 摘要生成函数。

        Returns:
            (压缩后的消息列表, 包含各步骤元数据的字典)
        """
        pipeline_metadata: dict[str, Any] = {
            "snip": None,
            "microcompact": None,
            "autocompact": None,
        }

        current_messages = messages

        # 步骤 1: SnipCompact — Agent SDK query.ts:396-409
        # WHY: snip 和 microcompact 不互斥，两者都可以运行
        snip_result = self.run_snip_compact(current_messages)
        if snip_result.rounds_removed > 0:
            current_messages = snip_result.messages
        pipeline_metadata["snip"] = {
            "rounds_removed": snip_result.rounds_removed,
            "tokens_freed": snip_result.tokens_freed,
        }

        # 步骤 2: Microcompact — Agent SDK query.ts:412-419
        current_messages, micro_result = self.run_microcompact(
            current_messages,
            query_source=query_source,
        )
        pipeline_metadata["microcompact"] = {
            "tokens_saved": micro_result.tokens_saved,
            "cleared_tool_ids": micro_result.cleared_tool_ids,
        }

        # 步骤 3: AutoCompact — Agent SDK query.ts:453-467
        current_messages, auto_result = self.run_autocompact(
            current_messages,
            snip_tokens_freed=snip_result.tokens_freed,
            summarize_fn=summarize_fn,
        )
        pipeline_metadata["autocompact"] = {
            "was_compacted": auto_result.was_compacted,
            "pre_compact_tokens": auto_result.pre_compact_token_count,
            "post_compact_tokens": auto_result.post_compact_token_count,
        }

        return current_messages, pipeline_metadata

    # ---- 工具结果预算管理 ----

    def consume_tool_result(self, result_text: str) -> ConsumeResult:
        """消耗工具结果文本并更新预算。

        """
        return self.tool_result_budget.consume(result_text)

    @property
    def is_budget_truncated(self) -> bool:
        """检查工具结果预算是否已超限。"""
        return self.tool_result_budget.truncated

    # ---- 上下文装配方法 ----

    def build_live_packet(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        query: str = "",
        context_entries: list[Any] | None = None,
        session_summary: str = "",
    ) -> ContextPacket:
        """构建实时上下文包，供 supervisor prompt 装配使用。

        从线程上下文索引和记忆系统收集信息，构建一个包含 prompt 文本、
        引用列表和上下文条目的包。

        Args:
            run_id: 运行 ID。
            thread_id: 线程 ID。
            query: 当前用户查询。
            context_entries: 历史上下文条目列表。
            session_summary: 会话摘要文本（用于 /resume 恢复时提供历史背景）。
        """
        entries = context_entries or []
        references = [getattr(e, "reference", None) for e in entries if getattr(e, "reference", None)]
        sections: list[str] = []

        if session_summary:
            sections.extend([
                "## 会话历史摘要",
                "",
                session_summary.strip(),
                "",
            ])

        if entries:
            sections.extend([
                "## 上下文边界",
                f"- 当前线程有 {len(entries)} 个已索引的历史上下文对象。",
                "- 不要根据未展示的历史内容直接作答；只有用户明确要求延续、引用上一轮或复用已有数据时，先调用 list_context_references 或 search_thread_context。",
            ])

        prompt_text = "\n".join(sections) if sections else ""
        return ContextPacket(
            prompt_context=prompt_text,
            references=references,
            entries=entries,
        )

    def build_repair_observation(
        self,
        *,
        query: str,
        validation_error: RuntimeError | None,
        run_state: Any,
        packet: ContextPacket,
    ) -> str:
        """构建校验失败后的修正观察文本。

        参照 Agent SDK context_manager: buildRepairObservation()
        """
        reason = str(validation_error or "运行时校验未通过。")
        lines = [f"用户原始问题：{query}", f"上一轮结果边界未通过：{reason}"]
        tool_results = getattr(run_state, "tool_results", []) or []
        if tool_results:
            lines.append("当前 run 已执行工具：")
            for tr in tool_results[-5:]:
                t = getattr(tr, "tool", "") or tr.get("tool", "") if isinstance(tr, dict) else ""
                m = getattr(tr, "message", "") or tr.get("message", "") if isinstance(tr, dict) else ""
                s = getattr(tr, "status", "") or tr.get("status", "") if isinstance(tr, dict) else ""
                lines.append(f"- {t}: {m}（{s}）")
        if packet.prompt_context:
            lines.extend(["可用线程上下文：", packet.prompt_context])
        lines.extend(["请只基于以上事实修正结果。"])
        return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════════════════
# 上下文包与辅助函数
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class ContextPacket:
    """运行时上下文包。传递给 supervisor prompt 装配器。

    prompt_context: 注入到 supervisor prompt 的上下文文本
    references: 当前线程的历史上下文引用列表
    entries: 结构化上下文条目
    auto_compact_result: 自动压缩结果（如果执行了 autocompact）
    """
    prompt_context: str = ""
    references: list[Any] = field(default_factory=list)
    entries: list[Any] = field(default_factory=list)
    auto_compact_result: AutoCompactResult | None = None


def prepend_user_context(messages: list[MessageDict], user_context: str) -> list[MessageDict]:
    """在消息历史最前面插入用户环境上下文。

    参照 Agent SDK query.ts: prependUserContext()
    """
    if not user_context.strip():
        return messages
    return [{"role": "user", "content": f"<user-context>\n{user_context.strip()}\n</user-context>", "isMeta": True}, *messages]


def append_system_context(system_prompt: str, system_context: str) -> str:
    """将系统上下文追加到系统 prompt 尾部。参照 Agent SDK query.ts: appendSystemContext()"""
    if not system_context.strip():
        return system_prompt
    return f"{system_prompt}\n\n{system_context.strip()}"
