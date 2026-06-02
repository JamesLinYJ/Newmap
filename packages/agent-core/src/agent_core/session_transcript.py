# +-------------------------------------------------------------------------
#
#   地理智能平台 - Session Transcript 会话日志与恢复
#
#   文件:       session_transcript.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------

# 模块职责
#
# JSONL 格式写入每轮对话（每行一个 JSON event），支持 /resume 恢复。
# 事件类型:
# - user_input: {"ts","type":"user_input","run_id","content"}
# - assistant: {"ts","type":"assistant","run_id","content","tool_calls":[...]}
# - tool_result: {"ts","type":"tool_result","run_id","tool","result","error"}
# - system: {"ts","type":"system","run_id","message","event_type"}
#
# 恢复策略:
# - 从 JSONL 文件重建 message history
# - 保留最近 N 轮作为上下文
# - 不注入到当前 run 的 prompt（与上下文管理器规则一致）

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

TRANSCRIPT_DIR: str = ".geoagent/transcripts"
"""会话日志存储目录（相对项目根目录）。"""

DEFAULT_RECENT_LIMIT: int = 50
"""get_recent_history 默认返回的最大事件数。"""

TRANSCRIPT_LOG_FILENAME: str = "session.jsonl"
"""每个 thread 对应的 JSONL 文件名。"""

SUMMARY_MAX_LINES: int = 40
"""build_summary 摘要最大行数。"""

SUMMARY_MAX_CHARS: int = 4000
"""build_summary 摘要最大字符数。"""

# ---------------------------------------------------------------------------
# 事件类型常量
# ---------------------------------------------------------------------------

EVENT_USER_INPUT: str = "user_input"
EVENT_ASSISTANT: str = "assistant"
EVENT_TOOL_RESULT: str = "tool_result"
EVENT_SYSTEM: str = "system"

VALID_EVENT_TYPES: frozenset[str] = frozenset({
    EVENT_USER_INPUT, EVENT_ASSISTANT, EVENT_TOOL_RESULT, EVENT_SYSTEM,
})


# ---------------------------------------------------------------------------
# 数据类
# ---------------------------------------------------------------------------

@dataclass
class TranscriptEvent:
    """单个会话日志事件。

    Attributes:
        ts: ISO 格式时间戳。
        type: 事件类型（user_input / assistant / tool_result / system）。
        run_id: 关联的运行 ID。
        content: 事件内容（用户消息、助手回复、工具结果等）。
        tool_calls: assistant 事件的工具调用列表（可选）。
        tool: tool_result 事件的工具名称（可选）。
        result: tool_result 事件的结果数据（可选）。
        error: tool_result 事件的错误信息（可选）。
        message: system 事件的消息内容（可选）。
        event_type: system 事件的子类型（可选）。
    """
    ts: str
    type: str
    run_id: str
    content: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool: str = ""
    result: Any = None
    error: str = ""
    message: str = ""
    event_type: str = ""


# ===================================================================
# SessionTranscript — 核心类
# ===================================================================

class SessionTranscript:
    """JSONL 会话日志管理器。

    以 thread_id 为单位组织 JSONL 文件，每行一个 JSON 事件。
    提供事件写入、历史读取和摘要生成功能。

    Usage:
        transcript = SessionTranscript(project_root=Path.cwd())
        transcript.append_event({
            "ts": "2026-06-01T10:00:00Z",
            "type": "user_input",
            "run_id": "run_xxx",
            "content": "查询杭州市天气",
        })
        history = transcript.get_recent_history("thread_xxx", limit=20)
        summary = transcript.build_summary("thread_xxx")
    """

    def __init__(self, project_root: Path) -> None:
        """初始化。

        Args:
            project_root: 项目根目录路径。
        """
        self._project_root: Path = project_root.resolve()
        self._transcript_root: Path = self._project_root / TRANSCRIPT_DIR
        self._transcript_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # 内部路径解析
    # ------------------------------------------------------------------

    def _thread_log_path(self, thread_id: str) -> Path:
        """获取指定 thread 的 JSONL 文件路径。

        Args:
            thread_id: 线程 ID。

        Returns:
            JSONL 文件的绝对路径。
        """
        # 使用 thread_id 的前 8 位作为子目录，防止单目录文件过多
        subdir = thread_id[:8] if len(thread_id) > 8 else thread_id
        thread_dir = self._transcript_root / subdir / thread_id
        thread_dir.mkdir(parents=True, exist_ok=True)
        return thread_dir / TRANSCRIPT_LOG_FILENAME

    # ------------------------------------------------------------------
    # 事件写入
    # ------------------------------------------------------------------

    def append_event(self, event: dict[str, Any]) -> None:
        """追加一个事件到当前会话的 JSONL 日志。

        Args:
            event: 事件字典。必须包含 "ts"、"type"、"run_id" 字段。
                   type 必须是 VALID_EVENT_TYPES 中的值。

        Raises:
            ValueError: 事件缺少必要字段或 type 不合法。
        """
        event_type = event.get("type", "")
        if event_type not in VALID_EVENT_TYPES:
            raise ValueError(
                f"不支持的事件类型: '{event_type}'。"
                f"合法值: {', '.join(sorted(VALID_EVENT_TYPES))}"
            )
        if "ts" not in event:
            # 自动填充时间戳
            event["ts"] = datetime.now(timezone.utc).isoformat()
        if "run_id" not in event:
            logger.warning("事件缺少 run_id 字段: %s", event.get("type", "unknown"))

        # 从事件中提取 thread_id（如果存在）
        thread_id = event.get("thread_id") or event.get("threadId") or ""
        if not thread_id:
            logger.warning("事件缺少 thread_id，将写入默认日志: %s", event_type)
            thread_id = "_default"

        log_path = self._thread_log_path(thread_id)
        try:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        except OSError as exc:
            logger.error("写入会话日志失败: %s — %s", log_path, exc)

    # ------------------------------------------------------------------
    # 历史读取
    # ------------------------------------------------------------------

    def get_recent_history(
        self,
        thread_id: str,
        limit: int = DEFAULT_RECENT_LIMIT,
    ) -> list[dict[str, Any]]:
        """获取指定 thread 的最近会话历史。

        从 JSONL 文件末尾读取，保留最近 N 个事件。
        返回的事件按时间正序排列。

        Args:
            thread_id: 线程 ID。
            limit: 最大返回事件数。

        Returns:
            按时间正序排列的事件字典列表。
        """
        log_path = self._thread_log_path(thread_id)
        if not log_path.exists() or log_path.stat().st_size == 0:
            return []

        events: list[dict[str, Any]] = []
        try:
            with log_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                        if isinstance(parsed, dict):
                            events.append(parsed)
                    except json.JSONDecodeError:
                        logger.warning("解析 JSONL 行失败（已跳过）: %s", line[:80])
                        continue
        except (OSError, UnicodeDecodeError) as exc:
            logger.error("读取会话日志失败: %s — %s", log_path, exc)
            return []

        # 只保留最近 N 条
        if len(events) > limit:
            events = events[-limit:]

        return events

    def get_all_events(self, thread_id: str) -> list[dict[str, Any]]:
        """获取指定 thread 的全部会话事件。

        Args:
            thread_id: 线程 ID。

        Returns:
            按时间正序排列的全部事件字典列表。
        """
        return self.get_recent_history(thread_id, limit=0)

    # ------------------------------------------------------------------
    # 摘要生成
    # ------------------------------------------------------------------

    def build_summary(self, thread_id: str) -> str:
        """生成指定 thread 的会话摘要。

        从 JSONL 文件中提取关键信息，生成人类可读的摘要文本。
        适用于 /resume 恢复时提供给模型作为上下文。

        Args:
            thread_id: 线程 ID。

        Returns:
            格式化的会话摘要字符串。无可用日志时返回空字符串。
        """
        events = self.get_recent_history(thread_id, limit=DEFAULT_RECENT_LIMIT)
        if not events:
            return ""

        lines: list[str] = []
        lines.append(f"## 会话摘要（thread: {thread_id}）")
        lines.append("")

        # 统计和元信息
        user_count = sum(1 for e in events if e.get("type") == EVENT_USER_INPUT)
        assistant_count = sum(1 for e in events if e.get("type") == EVENT_ASSISTANT)
        tool_count = sum(1 for e in events if e.get("type") == EVENT_TOOL_RESULT)
        total_events = len(events)

        lines.append(f"- 总事件数: {total_events}")
        lines.append(f"- 用户消息: {user_count}")
        lines.append(f"- 助手回复: {assistant_count}")
        lines.append(f"- 工具调用: {tool_count}")

        # 时间范围
        timestamps = [
            e.get("ts", "") for e in events if e.get("ts")
        ]
        if timestamps:
            lines.append(f"- 时间范围: {timestamps[0]} ~ {timestamps[-1]}")
        lines.append("")

        # 提取用户输入和助手回复作为对话摘要
        lines.append("### 对话记录")
        for event in events[-30:]:  # 只展示最近 30 条
            event_type = event.get("type", "")
            content = event.get("content", "")
            ts = event.get("ts", "")[:19] if event.get("ts") else ""

            if event_type == EVENT_USER_INPUT:
                preview = content[:200] if content else ""
                lines.append(f"- [{ts}] **用户**: {preview}")
            elif event_type == EVENT_ASSISTANT:
                preview = content[:200] if content else ""
                tool_calls = event.get("tool_calls", []) or []
                tool_text = f"（{len(tool_calls)} 个工具调用）" if tool_calls else ""
                lines.append(f"- [{ts}] **助手**: {preview} {tool_text}")
            elif event_type == EVENT_TOOL_RESULT:
                tool_name = event.get("tool", "unknown")
                has_error = bool(event.get("error"))
                status = "失败" if has_error else "成功"
                lines.append(f"- [{ts}] **工具 {tool_name}**: {status}")
            elif event_type == EVENT_SYSTEM:
                msg = event.get("message", "")[:100]
                lines.append(f"- [{ts}] **系统**: {msg}")

        # 限制长度
        summary = "\n".join(lines)

        # 截断到最大行数
        summary_lines = summary.splitlines()
        if len(summary_lines) > SUMMARY_MAX_LINES:
            summary_lines = summary_lines[:SUMMARY_MAX_LINES]
            summary_lines.append("\n[... 摘要已截断 ...]")
            summary = "\n".join(summary_lines)

        # 截断到最大字符数
        if len(summary) > SUMMARY_MAX_CHARS:
            summary = summary[:SUMMARY_MAX_CHARS] + "\n[... 摘要已截断 ...]"

        return summary

    # ------------------------------------------------------------------
    # 维护
    # ------------------------------------------------------------------

    def evict_old_transcripts(self, max_age_days: int = 30) -> int:
        """清理超过指定天数的旧会话日志。

        Args:
            max_age_days: 保留的最大天数。超过此天数的日志将被删除。

        Returns:
            已删除的日志文件数。
        """
        removed = 0
        now = time.time()
        cutoff = now - max_age_days * 86400

        for root, _dirs, files in os.walk(str(self._transcript_root)):
            for filename in files:
                if filename != TRANSCRIPT_LOG_FILENAME:
                    continue
                filepath = Path(root) / filename
                try:
                    mtime = filepath.stat().st_mtime
                    if mtime < cutoff:
                        filepath.unlink()
                        removed += 1
                        logger.info("已清理过期会话日志: %s", filepath)
                except OSError as exc:
                    logger.warning("清理会话日志失败: %s — %s", filepath, exc)

        return removed

    def get_thread_ids(self) -> list[str]:
        """获取所有有日志的 thread ID 列表。

        Returns:
            有日志文件的 thread ID 列表。
        """
        thread_ids: list[str] = []
        for root, _dirs, files in os.walk(str(self._transcript_root)):
            for filename in files:
                if filename != TRANSCRIPT_LOG_FILENAME:
                    continue
                # 路径格式: transcripts/{subdir}/{thread_id}/session.jsonl
                parent = Path(root).parent
                thread_id = parent.name if parent.name != root else Path(root).name
                if thread_id and thread_id != "_default":
                    thread_ids.append(thread_id)
        return thread_ids
