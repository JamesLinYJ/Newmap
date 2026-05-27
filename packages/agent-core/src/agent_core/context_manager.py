# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 上下文管理器
#
#   文件:       context_manager.py
#
#   日期:       2026年05月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 从 JSONL 会话日志里的上下文索引读取可审计事实，统一装配 prompt 边界提示、
# 可复用引用和结果修正观察。具体历史内容默认不进 prompt，避免隐藏记忆。

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shared_types.schemas import AgentStateModel, ContextEntryRecord, ContextReference, RuntimeContextConfig


@dataclass(frozen=True)
class LiveContextPacket:
    # live supervisor 上下文包
    #
    # prompt_context 只给 supervisor 一个上下文边界提示；references 写回 run state；
    # entries 保留结构化事实，供显式 context 工具和 UI 继续有界复用。
    prompt_context: str
    references: list[ContextReference] = field(default_factory=list)
    entries: list[ContextEntryRecord] = field(default_factory=list)


class AgentContextManager:
    # AgentContextManager
    #
    # 只认会话日志里的 context_entry 与显式记忆文件。
    # 缺索引就是空上下文，不回退扫描旧 run 或 event log；有索引也不把
    # 具体历史事实自动塞进 prompt。
    def __init__(self, *, store: Any, config: RuntimeContextConfig, project_root: Path | None = None):
        self.store = store
        self.config = config
        self.project_root = (project_root or Path.cwd()).resolve()

    def build_live_packet(self, *, run_id: str, thread_id: str | None) -> LiveContextPacket:
        if not thread_id:
            memory_text = self._build_memory_text()
            return LiveContextPacket(prompt_context=memory_text)

        entries = self._list_context_entries(thread_id=thread_id, exclude_source_run_id=run_id)
        references = [entry.reference for entry in entries if entry.reference is not None]
        sections: list[str] = []
        if entries:
            # 历史上下文不是默认注入给模型的事实源。
            #
            # 这里只暴露检索边界，不泄露具体条目内容。模型只有在用户明确
            # 指代上一轮、已有结果或历史数据时，才应调用 context 工具取回
            # 可执行引用，避免“什么都自动知道”的外挂感。
            sections.extend(
                [
                    "## 上下文边界",
                    f"- 当前线程有 {len(entries)} 个已索引的历史上下文对象。",
                    "- 不要根据未展示的历史内容直接作答；只有用户明确要求延续、引用上一轮或复用已有数据时，先调用 list_context_references 或 search_thread_context。",
                ]
            )
        memory_text = self._build_memory_text()
        if memory_text:
            sections.append(memory_text)
        return LiveContextPacket(
            prompt_context=self._clip("\n".join(sections), self.config.prompt_max_chars),
            references=references,
            entries=entries,
        )

    def build_repair_observation(
        self,
        *,
        query: str,
        validation_error: RuntimeError | None,
        run_state: AgentStateModel,
        packet: LiveContextPacket,
    ) -> str:
        reason = str(validation_error or "运行时校验未通过。")
        lines = [
            f"用户原始问题：{query}",
            f"上一轮结果边界未通过：{reason}",
        ]
        tool_results = run_state.tool_results[-self.config.tool_call_window :]
        if tool_results:
            lines.append("当前 run 已执行工具：")
            for item in tool_results:
                lines.append(f"- {item.tool}: {item.message}（{item.status}）")
        artifacts = run_state.artifacts[-self.config.artifact_window :]
        if artifacts:
            lines.append("当前 run 已生成结果：")
            for artifact in artifacts:
                lines.append(f"- {artifact.name}，artifactId={artifact.artifact_id}")
        warnings = run_state.warnings[-self.config.warning_window :]
        if warnings:
            lines.append("当前 run 告警：")
            lines.extend(f"- {warning}" for warning in warnings)
        if packet.prompt_context:
            lines.extend(["可用线程上下文：", packet.prompt_context])
        lines.extend(
            [
                "请只基于以上事实修正结果：",
                "- 空间分析必须使用真实工具、artifactId、collectionRef 或 layerKey。",
                "- 地图跳转任务必须先写回真实 place_resolution。",
                "- 不能把过程描述或机械完成句当作最终交付。",
            ]
        )
        return self._clip("\n".join(lines), self.config.prompt_max_chars)

    def _list_context_entries(self, *, thread_id: str, exclude_source_run_id: str) -> list[ContextEntryRecord]:
        method = getattr(self.store, "list_context_entries", None)
        if not callable(method):
            return []
        return list(
            method(
                thread_id,
                limit=self.config.context_entry_window,
                exclude_source_run_id=exclude_source_run_id,
            )
        )

    def _get_thread_context(self, thread_id: str):
        method = getattr(self.store, "get_thread_context", None)
        if not callable(method):
            return None
        return method(thread_id)

    def _build_memory_text(self) -> str:
        snippets: list[str] = []
        for raw_path in self.config.memory_file_paths:
            content = self._read_memory_file(raw_path)
            if content:
                snippets.append(f"### {raw_path}\n{content}")
        if not snippets:
            return ""
        return "## 显式记忆文件\n" + "\n\n".join(snippets)

    def _read_memory_file(self, raw_path: str) -> str:
        candidate = self._resolve_memory_path(raw_path)
        if candidate is None or not candidate.exists() or not candidate.is_file():
            return ""
        try:
            text = candidate.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"显式记忆文件不是有效 UTF-8：{candidate}") from exc
        return self._clip(text.strip(), self.config.memory_file_char_limit)

    def _resolve_memory_path(self, raw_path: str) -> Path | None:
        value = raw_path.strip()
        if not value:
            return None
        path = Path(value.lstrip("/")) if value.startswith("/") else Path(value)
        candidate = (self.project_root / path).resolve()
        try:
            candidate.relative_to(self.project_root)
        except ValueError:
            return None
        return candidate

    @staticmethod
    def _clip(text: str, max_chars: int) -> str:
        if max_chars <= 0 or len(text) <= max_chars:
            return text
        head = max_chars * 2 // 3
        tail = max_chars - head
        omitted = len(text) - head - tail
        return f"{text[:head]}\n[... {omitted} 个字符已省略 ...]\n{text[-tail:]}"
