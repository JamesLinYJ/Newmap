# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 单轮运行时组件
#
#   文件:       turn_runtime.py
#
#   日期:       2026年06月04日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 封装 Claude Code 风格单轮运行边界：事件写入、SDK stream drain、工具结果
# 校验与大结果持久化。graph.py 仍负责编排业务状态，本模块负责可审计消息流
# 和工具结果进入模型前的硬边界。

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

from gis_common.ids import make_id, now_utc
from shared_types.schemas import (
    AgentContentBlock,
    AgentFinalResponse,
    AgentMessage,
    AgentMessageFrame,
    ArtifactRef,
    EventType,
    RunEvent,
)
from tool_registry import ToolExecutionResult


logger = logging.getLogger(__name__)


class RunEventSink:
    # RunEventSink
    #
    # AgentSessionLogStore 是 run/event/thread 的事实源；这里集中创建事件 ID
    # 与终态事件 payload，避免运行路径各自拼装不一致的 SSE/JSONL 投影。
    def __init__(self, *, store: Any, run_id: str, thread_id: str | None):
        self.store = store
        self.run_id = run_id
        self.thread_id = thread_id

    def emit(self, event_type: EventType, message: str, *, payload: dict[str, Any] | None = None) -> RunEvent:
        event = RunEvent(
            event_id=make_id("evt"),
            run_id=self.run_id,
            thread_id=self.thread_id,
            type=event_type,
            message=message,
            timestamp=now_utc(),
            payload=payload or {},
        )
        self.store.append_event(self.run_id, event)
        return event


class MessageLedgerSink:
    # MessageLedgerSink
    #
    # Claude Code 风格聊天 ledger 的唯一写入入口。SDK stream、工具执行和
    # terminal 状态都写成 AgentMessageFrame，前端只 replay 这些帧。
    def __init__(self, *, store: Any, run_id: str, thread_id: str | None):
        self.store = store
        self.run_id = run_id
        self.thread_id = thread_id

    def emit_frame(
        self,
        op: str,
        *,
        message_id: str | None = None,
        block_id: str | None = None,
        block_index: int | None = None,
        message: AgentMessage | None = None,
        block: AgentContentBlock | None = None,
        delta: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AgentMessageFrame:
        frame = AgentMessageFrame(
            frame_id=make_id("msgfrm"),
            run_id=self.run_id,
            thread_id=self.thread_id,
            timestamp=now_utc(),
            op=op,
            message_id=message_id,
            block_id=block_id,
            block_index=block_index,
            message=message,
            block=block,
            delta=delta or {},
            result=result or {},
            metadata=metadata or {},
        )
        self.store.append_message_frame(self.run_id, frame)
        return frame

    def start_assistant_message(self, message_id: str) -> None:
        self.emit_frame(
            "message_start",
            message_id=message_id,
            message=AgentMessage(
                message_id=message_id,
                run_id=self.run_id,
                thread_id=self.thread_id,
                type="assistant",
                role="assistant",
                timestamp=now_utc(),
                status="streaming",
                content=[],
            ),
            metadata={"type": "assistant", "role": "assistant"},
        )

    def start_block(self, message_id: str, block: AgentContentBlock, *, block_index: int | None = None) -> None:
        self.emit_frame(
            "block_start",
            message_id=message_id,
            block_id=block.block_id,
            block_index=block_index,
            block=block,
        )

    def delta_block(self, message_id: str, block_id: str, delta: dict[str, Any]) -> None:
        self.emit_frame("block_delta", message_id=message_id, block_id=block_id, delta=delta)

    def stop_block(self, message_id: str, block_id: str) -> None:
        self.emit_frame("block_stop", message_id=message_id, block_id=block_id)

    def stop_message(self, message_id: str, *, status: str = "completed") -> None:
        self.emit_frame("message_stop", message_id=message_id, metadata={"status": status})

    def append_message(self, message: AgentMessage) -> None:
        self.emit_frame("message_append", message_id=message.message_id, message=message)

    def append_tool_use(self, *, tool_use_id: str, tool_name: str, args: dict[str, Any]) -> None:
        message_id = f"tooluse:{self.run_id}:{tool_use_id}"
        self.append_message(
            AgentMessage(
                message_id=message_id,
                run_id=self.run_id,
                thread_id=self.thread_id,
                type="assistant",
                role="assistant",
                timestamp=now_utc(),
                status="completed",
                content=[
                    AgentContentBlock(
                        block_id=f"{message_id}:block",
                        type="tool_use",
                        id=tool_use_id,
                        name=tool_name,
                        input=args,
                    )
                ],
            )
        )

    def append_tool_result(
        self,
        *,
        tool_use_id: str,
        tool_name: str,
        content: str,
        is_error: bool = False,
        structured_content: Any | None = None,
        artifact_id: str | None = None,
        value_refs: list[Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        message_id = f"toolresult:{self.run_id}:{tool_use_id}"
        self.append_message(
            AgentMessage(
                message_id=message_id,
                run_id=self.run_id,
                thread_id=self.thread_id,
                type="user",
                role="user",
                timestamp=now_utc(),
                status="failed" if is_error else "completed",
                parent_tool_use_id=tool_use_id,
                content=[
                    AgentContentBlock(
                        block_id=f"{message_id}:block",
                        type="tool_result",
                        tool_use_id=tool_use_id,
                        name=tool_name,
                        content=content,
                        is_error=is_error,
                        structured_content=structured_content,
                        artifact_id=artifact_id,
                        value_refs=value_refs or [],
                        metadata=metadata or {},
                    )
                ],
            )
        )

    def append_result(self, result_type: str, *, message: str = "", payload: dict[str, Any] | None = None) -> None:
        self.emit_frame(
            "result",
            result={"type": result_type, "message": message, **(payload or {})},
            metadata={"terminal": True},
        )

    def append_item(self, item_type: str, *, call_id: str | None = None,
                    name: str | None = None, arguments: str | None = None,
                    output: str | None = None, is_error: bool = False,
                    metadata: dict | None = None) -> None:
        """写入 Codex 风格的 ConversationItem。"""
        from shared_types.schemas import ConversationItem
        from datetime import datetime as dt_datetime
        item = ConversationItem(
            item_type=item_type,
            run_id=self.run_id,
            thread_id=self.thread_id,
            call_id=call_id,
            name=name,
            arguments=arguments,
            output=output,
            is_error=is_error,
            timestamp=dt_datetime.utcnow(),
        )
        try:
            self.store.append_response_item(item)
        except AttributeError:
            pass

    # ---- ItemSink（Codex 风格 item/started → item/delta → item/completed） ----

    def start_item(self, item_type: str, *, item_id: str, role: str | None = None,
                   name: str | None = None, call_id: str | None = None,
                   arguments: str | None = None) -> None:
        """item/started — 写入 running 状态的 ConversationItem。"""
        self.append_item(item_type, call_id=call_id, name=name, arguments=arguments)

    def delta_item(self, item_id: str, text: str) -> None:
        """item/delta — 追加文本（in-memory only，不单独写 JSONL）。"""
        pass

    def complete_item(self, item_id: str, *, item_type: str = "message",
                      role: str | None = None, content: str | None = None,
                      output: str | None = None, is_error: bool = False,
                      call_id: str | None = None, name: str | None = None) -> None:
        """item/completed — 更新 item 为 completed 并写入 output/content。"""
        self.append_item(item_type, call_id=call_id, name=name,
                         output=output or content, is_error=is_error)


class TurnRunner:
    # TurnRunner
    #
    # SDK 仍然拥有 agent/tool loop；本类只拥有当前 turn 的 stream 消费、
    # thinking/message ledger 投影和 token usage 归集。
    def __init__(
        self,
        *,
        event_sink: RunEventSink,
        message_sink: MessageLedgerSink,
        raw_event_cls: type[Any] | None,
        budget_tracker: Any = None,
        stats: Any = None,
        final_summary_extractor: Callable[[Any], str] | None = None,
        json_summary_extractor: Callable[[str], str] | None = None,
    ):
        self.event_sink = event_sink
        self.message_sink = message_sink
        self.raw_event_cls = raw_event_cls
        self.budget_tracker = budget_tracker
        self.stats = stats
        self.final_summary_extractor = final_summary_extractor or (lambda value: str(value or ""))
        self.json_summary_extractor = json_summary_extractor or (lambda value: "")

    def run_streamed(self, runner_cls: Any, agent: Any, input_value: Any, **kwargs: Any) -> Any:
        return runner_cls.run_streamed(agent, input_value, **kwargs)

    async def drain_stream(self, streaming: Any, *, output_contract: str) -> str:
        final_summary = ""
        buffer_json = output_contract in ("json_object", "sdk_structured")
        message_id = f"assistant:{self.event_sink.run_id}"
        thinking_block_id = f"{message_id}:thinking"
        text_block_id = f"{message_id}:text"
        message_started = False
        thinking_started = False
        thinking_stopped = False
        text_started = False

        def ensure_assistant_message() -> None:
            nonlocal message_started
            if message_started:
                return
            self.message_sink.start_assistant_message(message_id)
            message_started = True

        def start_thinking_block() -> None:
            nonlocal thinking_started
            ensure_assistant_message()
            if thinking_started:
                return
            self.message_sink.start_block(
                message_id,
                AgentContentBlock(
                    block_id=thinking_block_id,
                    type="thinking",
                    thinking="",
                ),
                block_index=0,
            )
            self.message_sink.start_item("reasoning", item_id=thinking_block_id)
            thinking_started = True

        def stop_thinking_block() -> None:
            nonlocal thinking_stopped
            if thinking_started and not thinking_stopped:
                self.message_sink.stop_block(message_id, thinking_block_id)
                self.message_sink.complete_item(thinking_block_id, item_type="reasoning")
                thinking_stopped = True

        def start_text_block() -> None:
            nonlocal text_started
            ensure_assistant_message()
            if text_started:
                return
            stop_thinking_block()
            self.message_sink.start_block(
                message_id,
                AgentContentBlock(
                    block_id=text_block_id,
                    type="text",
                    text="",
                ),
                block_index=1 if thinking_started else 0,
            )
            self.message_sink.start_item("message", item_id=text_block_id, role="assistant")
            text_started = True

        async for event in streaming.stream_events():
            if self.raw_event_cls is not None and isinstance(event, self.raw_event_cls):
                data = event.data
                delta = getattr(data, "delta", None) or ""
                if delta and isinstance(delta, str):
                    data_type = type(data).__name__
                    if "Reasoning" in data_type:
                        start_thinking_block()
                        self.message_sink.delta_block(message_id, thinking_block_id, {"thinking": delta})
                        self.message_sink.delta_item(thinking_block_id, delta)
                    elif "Text" in data_type:
                        final_summary += delta
                        if not buffer_json:
                            if not text_started and final_summary.lstrip().startswith("{"):
                                buffer_json = True
                            else:
                                start_text_block()
                                self.message_sink.delta_block(message_id, text_block_id, {"text": delta})
                                self.message_sink.delta_item(text_block_id, delta)
                await asyncio.sleep(0)

        stop_thinking_block()

        streamed = final_summary.strip()
        clean = self.json_summary_extractor(streamed)
        if clean:
            if not text_started:
                start_text_block()
                self.message_sink.delta_block(message_id, text_block_id, {"text": clean})
            self.message_sink.stop_block(message_id, text_block_id)
            self.message_sink.stop_message(message_id)
            self.message_sink.complete_item(text_block_id, item_type="message", role="assistant", content=clean)
            self._track_usage(streaming)
            return clean

        final_output = self.final_summary_extractor(getattr(streaming, "final_output", None))
        if not buffer_json:
            if text_started:
                self.message_sink.stop_block(message_id, text_block_id)
            if message_started:
                self.message_sink.stop_message(message_id)
            self._track_usage(streaming)
            return streamed or final_output

        if final_output and not text_started:
            start_text_block()
            self.message_sink.delta_block(message_id, text_block_id, {"text": final_output})
        if text_started:
            self.message_sink.stop_block(message_id, text_block_id)
        if message_started:
            self.message_sink.stop_message(message_id)
        self._track_usage(streaming)
        return streamed or final_output

    def _track_usage(self, streaming: Any) -> None:
        if self.budget_tracker is None:
            return
        try:
            response = getattr(streaming, "raw_response", None) or getattr(streaming, "response", None)
            usage = getattr(response, "usage", None) if response is not None else None
            if usage is None:
                return
            if hasattr(usage, "model_dump"):
                usage = usage.model_dump()
            elif hasattr(usage, "_asdict"):
                usage = usage._asdict()
            self.budget_tracker.track_response(usage)
            if self.stats is not None:
                self.stats.tokens_used = self.budget_tracker.budget.used_tokens
        except Exception:
            logger.debug("SDK usage 统计写入失败。", exc_info=True)


@dataclass(frozen=True)
class ToolObservationDelivery:
    text: str
    persisted_artifact: ArtifactRef | None
    full_size_chars: int


class SdkToolAdapter:
    # SdkToolAdapter
    #
    # 工具 handler 只能返回标准 ToolExecutionResult。缺失 message/payload 的输出
    # 是失败的工具调用，不再合成“成功”消息掩盖 schema 问题。
    @staticmethod
    def validate_result_message(result: Any, tool_name: str) -> str:
        if not isinstance(result, ToolExecutionResult):
            raise TypeError(f"工具 {tool_name} 返回了非法结果类型：{type(result).__name__}")
        if not isinstance(result.message, str) or not result.message.strip():
            raise ValueError(f"工具 {tool_name} 返回结果缺少非空 message。")
        if not isinstance(result.payload, dict):
            raise ValueError(f"工具 {tool_name} 返回结果 payload 必须是对象。")
        if not isinstance(result.warnings, list):
            raise ValueError(f"工具 {tool_name} 返回结果 warnings 必须是列表。")
        if not isinstance(result.value_refs, list):
            raise ValueError(f"工具 {tool_name} 返回结果 value_refs 必须是列表。")
        return result.message

    @staticmethod
    def prepare_observation(
        *,
        tool_name: str,
        result: ToolExecutionResult,
        run_id: str,
        format_observation: Callable[..., str],
        truncate: Callable[..., str],
        max_chars: int,
        persist_threshold: int,
        artifact_export_store: Any,
        logger_obj: logging.Logger | None = None,
    ) -> ToolObservationDelivery:
        full_observation = format_observation(tool_name=tool_name, result=result)
        full_size = len(full_observation)
        text = truncate(full_observation, max_chars)
        persisted_artifact: ArtifactRef | None = None

        if full_size > persist_threshold and artifact_export_store is not None and hasattr(artifact_export_store, "put"):
            persist_artifact_id = make_id("tool_persist")
            persisted_artifact = ArtifactRef(
                artifact_id=persist_artifact_id,
                run_id=run_id,
                uri=f"runtime://tool_persist/{persist_artifact_id}",
                name=f"{tool_name}_result_{make_id('res')}",
                artifact_type="tool_result_persist",
                metadata={"tool": tool_name, "size_chars": full_size},
            )
            raw_result_str = (
                json.dumps(result.payload, ensure_ascii=False, default=str)
                if result.payload
                else full_observation
            )
            try:
                artifact_export_store.put(persist_artifact_id, raw_result_str)
            except Exception as exc:
                if logger_obj is not None:
                    logger_obj.warning("工具结果持久化失败：%s —— %s", tool_name, exc)
                persisted_artifact = None
            else:
                text = f"{text}\n\n[完整结果已持久化: artifact_id={persist_artifact_id}]"

        return ToolObservationDelivery(
            text=truncate(text),
            persisted_artifact=persisted_artifact,
            full_size_chars=full_size,
        )


class TurnFinalizer:
    # TurnFinalizer
    #
    # 成功、澄清等待和失败终态都通过 RunEventSink 发射 terminal 事件。
    # Store 仍是快照事实源；finalizer 只统一 terminal payload 的形状。
    def __init__(self, *, store: Any, event_sink: RunEventSink, message_sink: MessageLedgerSink):
        self.store = store
        self.event_sink = event_sink
        self.message_sink = message_sink

    def complete(self, final_response: AgentFinalResponse, *, completed_todos: Any = None) -> Any:
        updates: dict[str, Any] = {"final_response": final_response}
        if completed_todos is not None:
            updates["todos"] = completed_todos
        self.store.update_run_state(self.event_sink.run_id, **updates)
        final_state = self.store.get_run(self.event_sink.run_id).state
        completed_run = self.store.complete_run(self.event_sink.run_id, final_state)
        event_type = (
            EventType.CLARIFICATION_REQUIRED
            if completed_run.status == "clarification_needed"
            else EventType.RUN_COMPLETED
        )
        self.event_sink.emit(
            event_type,
            final_response.summary,
            payload={
                "finalResponse": final_response.model_dump(mode="json"),
                "clarification": completed_run.state.clarification.model_dump(mode="json")
                if completed_run.state.clarification
                else None,
                "status": completed_run.status,
            },
        )
        self.message_sink.append_result(
            "waiting_clarification" if completed_run.status == "clarification_needed" else "success",
            message=final_response.summary,
            payload={"status": completed_run.status, "finalResponse": final_response.model_dump(mode="json")},
        )
        return completed_run

    def fail(self, final_response: AgentFinalResponse, *, errors: list[str]) -> Any:
        self.store.update_run_state(
            self.event_sink.run_id,
            errors=errors,
            final_response=final_response,
        )
        final_state = self.store.get_run(self.event_sink.run_id).state
        failed_run = self.store.complete_run(self.event_sink.run_id, final_state)
        self.event_sink.emit(
            EventType.RUN_FAILED,
            "分析流程执行失败。",
            payload={"errors": errors, "finalResponse": final_response.model_dump(mode="json")},
        )
        self.message_sink.append_result(
            "failed",
            message=final_response.summary or "分析流程执行失败。",
            payload={"errors": errors, "finalResponse": final_response.model_dump(mode="json")},
        )
        return failed_run
