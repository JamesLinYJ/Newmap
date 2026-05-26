# +-------------------------------------------------------------------------
#
#   地理智能平台 - OAI Agents SDK 运行时
#
#   文件:       graph.py
#
#   日期:       2026年05月11日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 基于 OpenAI Agents SDK 实现主智能体运行时、子智能体调度、状态写回和审批续跑。

from __future__ import annotations
import asyncio
import json
import logging
import time as _time
from typing import Any

try:
    from agents import (
        Agent,
        FunctionTool,
        GuardrailFunctionOutput,
        ModelSettings,
        OpenAIChatCompletionsModel,
        OutputGuardrailTripwireTriggered,
        RawResponsesStreamEvent,
        RunConfig,
        Runner,
        RunState,
        output_guardrail,
    )
    from openai import AsyncOpenAI
    from openai.types.responses import ResponseCompletedEvent, ResponseFunctionToolCall, ResponseOutputMessage
except ModuleNotFoundError:  # pragma: no cover - exercised by deployment smoke checks.
    Agent = FunctionTool = GuardrailFunctionOutput = ModelSettings = OpenAIChatCompletionsModel = OutputGuardrailTripwireTriggered = RawResponsesStreamEvent = None  # type: ignore[assignment]
    RunConfig = Runner = RunState = output_guardrail = None  # type: ignore[assignment]
    AsyncOpenAI = None  # type: ignore[assignment]
    ResponseCompletedEvent = ResponseFunctionToolCall = ResponseOutputMessage = None  # type: ignore[assignment]

from gis_common.ids import make_id, now_utc
from shared_types.schemas import (
    AgentFinalResponse,
    AgentStateModel,
    ApprovalRequest,
    ClarificationState,
    ClarificationOption,
    ContextReference,
    ContextResolution,
    EventType,
    ExecutionPlan,
    LoopTraceEntry,
    PlaceResolution,
    PlaceSearchCandidate,
    RunEvent,
    SubAgentState,
    ToolCall,
    UserIntent,
)
from tool_registry import ToolRegistry, ToolRuntime, ToolExecutionResult
from tool_registry.value_refs import serialize_value_refs_for_model

from .context_manager import AgentContextManager, LiveContextPacket
from .parser import build_execution_plan, parse_user_intent, verify_execution_plan
from .supervisor_config import LOOP_PHASES, build_default_runtime_config

logger = logging.getLogger(__name__)


# Chat Completions 工具消息顺序修正
#
# 一些 OpenAI-compatible provider 会在同一轮里同时流出说明文本和 tool_call，
# 且 streaming item 顺序可能是 function_call -> message。Agents SDK 回放到
# Chat Completions 时会把它转成 assistant(tool_calls) -> assistant(text) -> tool，
# 严格 provider 会直接拒绝。这里只调整同一轮 model output 的投影顺序，仍然让
# SDK 负责 agent loop、工具执行、审批和 trace。
def _normalize_chat_completions_tool_output_order(output: list[Any]) -> list[Any]:
    if ResponseFunctionToolCall is None or ResponseOutputMessage is None:
        return output
    has_tool_call = any(isinstance(item, ResponseFunctionToolCall) for item in output)
    if not has_tool_call:
        return output
    first_tool_index = next(index for index, item in enumerate(output) if isinstance(item, ResponseFunctionToolCall))
    if not any(isinstance(item, ResponseOutputMessage) for item in output[first_tool_index + 1 :]):
        return output

    prefix: list[Any] = []
    rest = list(output)
    while rest and getattr(rest[0], "type", None) == "reasoning":
        prefix.append(rest.pop(0))

    messages = [item for item in rest if isinstance(item, ResponseOutputMessage)]
    tool_calls = [item for item in rest if isinstance(item, ResponseFunctionToolCall)]
    others = [item for item in rest if not isinstance(item, (ResponseOutputMessage, ResponseFunctionToolCall))]
    return [*prefix, *messages, *tool_calls, *others]


if OpenAIChatCompletionsModel is not None:
    class _StrictToolHistoryChatCompletionsModel(OpenAIChatCompletionsModel):  # type: ignore[misc, valid-type]
        # OpenAI-compatible Chat Completions 模型包装。
        #
        # 只修正 SDK streaming 完成态 output 顺序；不自研工具循环，也不吞掉 provider
        # 错误。修正后的 output 会被 SDK 自己用于下一轮历史回放。
        async def get_response(self, *args: Any, **kwargs: Any):
            response = await super().get_response(*args, **kwargs)
            response.output = _normalize_chat_completions_tool_output_order(list(response.output))
            return response

        async def stream_response(self, *args: Any, **kwargs: Any):
            async for event in super().stream_response(*args, **kwargs):
                if ResponseCompletedEvent is not None and isinstance(event, ResponseCompletedEvent):
                    normalized_response = event.response.model_copy(
                        update={"output": _normalize_chat_completions_tool_output_order(list(event.response.output))}
                    )
                    yield event.model_copy(update={"response": normalized_response})
                    continue
                yield event
else:  # pragma: no cover - SDK 缺失时启动错误由运行边界负责。
    _StrictToolHistoryChatCompletionsModel = None  # type: ignore[assignment]


# 统一格式化运行时错误
#
# 将工具名、step id 和异常类型压成稳定字符串，
# 便于 state / event / final response 复用同一份错误表达。
def _format_agent_error(exc: Exception, *, tool: str | None = None, step_id: str | None = None) -> str:
    prefix = "Agent 运行出错"
    if step_id or tool:
        prefix = f"工具执行出错（步骤 {step_id or 'unknown'}，工具 {tool or 'unknown'}）"
    return f"{prefix}: {exc.__class__.__name__}: {exc}"


# 澄清文本归一化
#
# 地点候选通常来自按钮选择，但也允许用户手动粘贴或删减少量空白。
# 这里统一归一化比较键，用于识别"这次输入是否是在回答上一轮澄清问题"。
def _normalize_clarification_label(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _infer_clarification_kind(options: list[ClarificationOption]) -> str:
    # 通用澄清状态面向地点、图层、距离、发布目标等多种候选。
    #
    # 如果候选来自同一种 kind，就把它提升到 state 层；混合候选则保留 generic，
    # 让前端按每个 option 自己的 kind 渲染，不在这里猜业务含义。
    kinds = {item.kind for item in options if item.kind}
    return next(iter(kinds)) if len(kinds) == 1 else "generic"


# 最终摘要质量判定
#
# SDK 结构化最终答复如果只吐出极短、极空泛的模板句，
# 这里会把它视作无效结果，让运行失败或进入修正，而不是伪装成功。
def _is_mechanical_final_summary(summary: str) -> bool:
    normalized = " ".join(summary.strip().split())
    if not normalized:
        return True
    generic_phrases = {
        "分析已完成。",
        "分析完成。",
        "处理完成。",
        "已完成。",
        "任务已完成。",
        "结果已生成。",
        "分析执行失败。",
        "抱歉，这次分析没能完成。",
    }
    if normalized in generic_phrases:
        return True
    return len(normalized) < 10


def _format_tool_observation(*, tool_name: str, result: Any) -> str:
    """将工具执行结果格式化为 Agent 可读的观察文本——只给数据，不报状态。"""
    payload = getattr(result, "payload", {}) or {}
    compact_payload = payload
    value_refs = getattr(result, "value_refs", None) or []
    if value_refs:
        compact_payload = {
            "valueRefs": serialize_value_refs_for_model(value_refs),
            "collectionRef": payload.get("collectionRef"),
            "collectionRefs": payload.get("collectionRefs", []),
            "artifactId": getattr(getattr(result, "artifact", None), "artifact_id", None),
            "featureCount": payload.get("featureCount") or payload.get("feature_count") or getattr(result, "feature_count", None),
        }
    if tool_name == "list_context_references":
        compact_payload = {"references": payload.get("references", [])[:12]}
    elif tool_name == "search_thread_context":
        compact_payload = {"snippets": payload.get("snippets", [])[:8]}
    elif tool_name == "geocode_place" and not value_refs:
        compact_payload = {
            "matches": payload.get("matches", [])[:5],
            "collectionRef": payload.get("collectionRef"),
            "collectionRefs": payload.get("collectionRefs", []),
            "provider": payload.get("provider"),
        }
    try:
        import json
        return json.dumps(compact_payload, ensure_ascii=False, default=str)
    except Exception:
        return str(compact_payload)


_MAX_OBSERVATION_CHARS = 32000


def _collect_thread_layer_keys(store: Any, thread_id: str | None) -> set[str]:
    """收集当前线程所有 run 产生的 artifact keys，用于图层隔离。"""
    if not thread_id:
        return set()
    keys: set[str] = set()
    for run in store.list_runs_for_thread(thread_id):
        for artifact in run.state.artifacts:
            keys.add(artifact.artifact_id)
            if artifact.name:
                keys.add(artifact.name)
    return keys


def _extract_summary_from_json(text: str) -> str | None:
    """从 raw JSON 字符串中提取 summary 字段。用于过滤模型输出的原始 JSON。

    处理三种情况：
    1. 纯 JSON: {"summary":"..."}
    2. 流式合并丢失开头花括号: "summary":"..."
    3. 自然语言后附带 JSON: ...文本…{"summary":"..."}
    """
    trimmed = text.strip()
    if '"summary"' not in trimmed:
        return None
    import json as _json

    def _try_parse(candidate: str) -> str | None:
        try:
            parsed = _json.loads(candidate)
            s = parsed.get("summary")
            return s.strip() if isinstance(s, str) and s.strip() else None
        except Exception:
            return None

    # 1) 纯 JSON
    if trimmed.startswith("{"):
        result = _try_parse(trimmed)
        if result:
            return result
    # 2) 流式合并丢失开头 {
    if trimmed.startswith('"summary"'):
        result = _try_parse(f'{{{trimmed}}}')
        if result:
            return result
    # 3) 自然语言后附带 JSON 块
    brace_idx = trimmed.find('{"summary"')
    if brace_idx >= 0:
        result = _try_parse(trimmed[brace_idx:])
        if result:
            return result
    return None


def _truncate_observation(text: str, max_chars: int = _MAX_OBSERVATION_CHARS) -> str:
    """截断过长工具输出：保留前半 + 后四分之一，中间标注省略量。"""
    if len(text) <= max_chars:
        return text
    first_half = max_chars // 2
    last_quarter = max_chars // 4
    omitted = len(text) - first_half - last_quarter
    return f"{text[:first_half]}\n[... {omitted} 个字符已省略 ...]\n{text[-last_quarter:]}"


class GeoAgentRuntime:
    # GeoAgentRuntime
    #
    # 统一负责：
    # 1. 生成细粒度运行状态（todo / subagent / approvals / tools）。
    # 2. 顺序执行 GIS 工具并持续写回事件与状态。
    # 3. 在审批通过后继续完成发布动作。
    #
    # 运行时统一维护同一套 supervisor loop。
    # 不同 provider 只影响"如何决定下一步"，不应该拆成两套状态模型。
    def __init__(self, *, store: Any, tool_registry: ToolRegistry, model_registry: Any):
        self.store = store
        self.tool_registry = tool_registry
        self.model_registry = model_registry
        # 每次 run 独立创建 store/checkpointer，避免并发 run 共享可变状态

    async def run(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        session_id: str,
        query: str,
        latest_uploaded_layer_key: str | None,
        provider: str,
        model_name: str | None,
        context_factory,
        clarification_option_id: str | None = None,
    ) -> None:
        # 主运行入口。
        #
        # 正式主路径只允许 OpenAI Agents SDK 接管决策。
        #
        # 诊断 helper 保留为离线测试入口，不再在用户请求里自动接管；
        # 如果模型 provider 或外部服务不可用，应明确失败并写回事实状态，
        # 而不是用另一套规则计划伪装成一次成功的 Agent 运行。
        runtime = context_factory(
            run_id=run_id,
            thread_id=thread_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )
        try:
            await self._run_with_oai_agents(
                run_id=run_id,
                thread_id=thread_id,
                query=query,
                provider=provider,
                model_name=model_name,
                runtime=runtime,
                clarification_option_id=clarification_option_id,
            )
        except asyncio.CancelledError:
            self.store.update_run_state(run_id, status="cancelled", final_response=AgentFinalResponse(
                summary="分析已取消。",
                limitations=["任务被系统终止。"],
                next_actions=["重新发起分析"],
            ))
            self.store.complete_run(run_id, self.store.get_run(run_id).state)
            raise
        except Exception as exc:
            formatted_error = _format_agent_error(exc)
            final_response = AgentFinalResponse(
                summary="抱歉，这次分析没能完成。",
                limitations=[formatted_error],
                next_actions=[],
            )
            self.store.update_run_state(run_id, errors=[formatted_error], final_response=final_response)
            final_state = self.store.get_run(run_id).state
            self.store.complete_run(run_id, final_state)
            self._append_event(
                run_id,
                thread_id,
                EventType.RUN_FAILED,
                "分析流程执行失败。",
                payload={"errors": [formatted_error], "finalResponse": final_response.model_dump(mode="json")},
            )

    async def resolve_approval(
        self,
        *,
        run_id: str,
        approval_id: str,
        approved: bool,
        context_factory,
        latest_uploaded_layer_key: str | None,
    ):
        # 审批恢复入口。
        #
        # 发布动作被视为 SDK 硬中断边界。
        #
        # 新运行只能从 Agents SDK RunState 恢复；旧的手写审批记录不能再绕过
        # SDK needs_approval 去补执行工具。
        run = self.store.get_run(run_id)
        state = run.state
        approvals = list(state.approvals)
        target = next((item for item in approvals if item.approval_id == approval_id), None)
        if target is None:
            raise ValueError(f"未找到审批请求：{approval_id}")
        if target.status != "pending":
            return run

        if not target.payload.get("sdkRunState"):
            raise ValueError("审批记录缺少 SDK RunState，不能使用平台手写发布路径；请重新发起需要发布的任务。")

        return await self._resolve_sdk_approval(
            run=run,
            target=target,
            approved=approved,
            context_factory=context_factory,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )

    def _record_loop(
        self,
        run_id: str,
        thread_id: str | None,
        *,
        iteration: int,
        phase: str,
        title: str,
        description: str,
        status: str = "running",
        agent_id: str | None = None,
        tool_name: str | None = None,
        step_id: str | None = None,
        suppress_event: bool = False,
    ) -> LoopTraceEntry:
        # loop trace 既写 state 也写事件。
        #
        # state 负责快照恢复，event 负责实时流和历史回放；
        # 两边共用同一份 LoopTraceEntry，避免前后端看到两套 loop 叙事。
        #
        # suppress_event=True 时只写 state 不发射事件，调用方负责在
        # 合适的时机（如附在 TOOL_STARTED/TOOL_COMPLETED payload 中）自行发射。
        state = self.store.get_run(run_id).state
        trace = list(state.loop_trace)
        entry = LoopTraceEntry(
            iteration=iteration,
            phase=phase,
            title=title,
            description=description,
            status=status,
            timestamp=now_utc(),
            agent_id=agent_id,
            tool_name=tool_name,
            step_id=step_id,
        )
        trace.append(entry)
        trace = trace[-self._get_runtime_config().loop_trace_limit :]
        updated_run = self.store.update_run_state(
            run_id,
            loop_iteration=iteration,
            loop_phase=phase,
            loop_trace=trace,
        )
        if not suppress_event:
            self._append_event(
                run_id,
                thread_id,
                EventType.LOOP_UPDATED,
                description,
                payload=entry.model_dump(mode="json"),
            )
        return entry

    def _supports_live_supervisor(self, provider: str) -> bool:
        return self.model_registry.supports_live_supervisor(provider)

    def _append_event(self, run_id: str, thread_id: str | None, event_type: EventType, message: str, *, payload: dict[str, Any] | None = None) -> None:
        # 统一封装事件对象，保证所有运行路径生成的字段风格一致。
        self.store.append_event(
            run_id,
            RunEvent(
                event_id=make_id("evt"),
                run_id=run_id,
                thread_id=thread_id,
                type=event_type,
                message=message,
                timestamp=now_utc(),
                payload=payload or {},
            ),
        )

    def _get_runtime_config(self):
        return self.store.get_runtime_config()

    def _provider_display_name(self, provider: str) -> str:
        try:
            return self.model_registry.get(provider).display_name
        except Exception:
            return provider

    def _build_effective_intent(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        query: str,
        latest_uploaded_layer_key: str | None,
        clarification_option_id: str | None = None,
    ) -> tuple[UserIntent, str | None]:
        # 运行时意图解析入口。
        #
        # 默认按当前 query 直接解析；只有前端显式提交 optionId 时，
        # 才把本轮视为上一轮澄清的结构化选择。
        # 普通文本由 Agent SDK 自己结合上下文判断，不再靠 label 模糊匹配。
        continuation = self._match_clarification_continuation(
            run_id=run_id,
            thread_id=thread_id,
            query=query,
            clarification_option_id=clarification_option_id,
        )
        if continuation is None:
            return parse_user_intent(query, latest_uploaded_layer_key=latest_uploaded_layer_key), None

        parent_intent = continuation["parent_intent"]
        selected_label = continuation["selected_label"]
        selected_candidate = continuation.get("selected_candidate")
        uncertainty_flags = [flag for flag in parent_intent.uncertainty_flags if flag != "ambiguous_place"]
        uncertainty_flags.append("clarification_resolved")
        continued_fields: dict[str, Any] = {
            "clarification_required": False,
            "clarification_question": None,
            "clarification_options": [],
            "uncertainty_flags": list(dict.fromkeys(uncertainty_flags)),
        }
        if parent_intent.place_query:
            continued_fields["place_query"] = selected_label
        continued_intent = parent_intent.model_copy(update=continued_fields)
        if isinstance(selected_candidate, PlaceSearchCandidate):
            previous_resolution = continuation.get("parent_place_resolution")
            provider = previous_resolution.provider if isinstance(previous_resolution, PlaceResolution) else self._get_runtime_config().geosearch.provider
            self.store.update_run_state(
                run_id,
                clarification=ClarificationState(
                    clarification_id=f"clarification_{continuation['parent_run_id']}",
                    kind=str(continuation.get("selected_kind") or "place"),
                    question=parent_intent.clarification_question or "请选择一个候选项。",
                    options=parent_intent.clarification_options,
                    selected_option_id=continuation.get("selected_option_id"),
                ),
                place_resolution=PlaceResolution(
                    status="resolved",
                    query=selected_label,
                    provider=provider,
                    selected=selected_candidate,
                    candidates=[selected_candidate],
                ),
            )
        note = f"已接收澄清结果，并继续沿用上一轮任务目标：{continuation['parent_query']}"
        return continued_intent, note

    def _match_clarification_continuation(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        query: str,
        clarification_option_id: str | None = None,
    ) -> dict[str, Any] | None:
        # 澄清续跑识别
        #
        # 只在同一 thread 的上一轮确实停在 clarification_needed，
        # 且当前输入能匹配候选项时才触发，避免把普通追问误判成地点选择。
        if not thread_id:
            return None

        runs = self.store.list_runs_for_thread(thread_id)
        previous_run = next((item for item in runs if item.id != run_id), None)
        if previous_run is None:
            return None

        previous_intent = previous_run.state.parsed_intent
        if previous_run.status != "clarification_needed" or previous_intent is None or not previous_intent.clarification_required:
            return None

        selected_option = self._match_clarification_option(
            query,
            previous_intent.clarification_options,
            clarification_option_id=clarification_option_id,
        )
        selected_label = selected_option.label if selected_option else None
        if not selected_label:
            return None
        selected_candidate = None
        if selected_option and selected_option.kind == "place" and selected_option.payload:
            try:
                selected_candidate = PlaceSearchCandidate.model_validate(selected_option.payload)
            except Exception:
                selected_candidate = None
        if selected_candidate is None:
            selected_candidate = self._match_place_candidate_for_clarification(
                selected_label,
                previous_run.state.place_resolution.candidates if previous_run.state.place_resolution else [],
            )

        return {
            "parent_run_id": previous_run.id,
            "parent_query": previous_run.user_query,
            "parent_intent": previous_intent,
            "parent_place_resolution": previous_run.state.place_resolution,
            "selected_label": selected_label,
            "selected_option_id": selected_option.option_id if selected_option else None,
            "selected_kind": selected_option.kind if selected_option else None,
            "selected_candidate": selected_candidate,
        }

    def _match_clarification_option(
        self,
        query: str,
        options: list[ClarificationOption],
        *,
        clarification_option_id: str | None = None,
    ) -> ClarificationOption | None:
        if clarification_option_id:
            exact_option = next((item for item in options if item.option_id == clarification_option_id), None)
            if exact_option is not None:
                return exact_option
        return None

    def _match_place_candidate_for_clarification(
        self,
        selected_label: str,
        candidates: list[PlaceSearchCandidate],
    ) -> PlaceSearchCandidate | None:
        # 候选对象匹配
        #
        # 澄清按钮代表上一轮候选对象本身，不是一个需要再次搜索的新 query。
        # 因此命中候选后要继承它的坐标、provider 和 display name，避免同名地点重新歧义。
        normalized_label = _normalize_clarification_label(selected_label)
        if not normalized_label:
            return None
        for candidate in candidates:
            labels = [
                candidate.display_name or "",
                candidate.label,
            ]
            if any(_normalize_clarification_label(label) == normalized_label for label in labels):
                return candidate
        fuzzy = [
            candidate
            for candidate in candidates
            if normalized_label in _normalize_clarification_label(candidate.display_name or candidate.label)
            or _normalize_clarification_label(candidate.display_name or candidate.label) in normalized_label
        ]
        unique = []
        seen = set()
        for candidate in fuzzy:
            key = candidate.display_name or candidate.label
            if key in seen:
                continue
            seen.add(key)
            unique.append(candidate)
        return unique[0] if len(unique) == 1 else None

    async def _run_with_oai_agents(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        query: str,
        provider: str,
        model_name: str | None,
        runtime: ToolRuntime,
        clarification_option_id: str | None = None,
    ) -> None:
        """基于 OAI Agents SDK 的主运行路径。"""
        if Agent is None or FunctionTool is None or Runner is None:
            raise RuntimeError("OpenAI Agents SDK 未安装，请先安装 openai-agents 依赖后再启动分析。")

        runtime_config = self._get_runtime_config()
        intent, continuation_note = self._build_effective_intent(
            run_id=run_id, thread_id=thread_id, query=query,
            latest_uploaded_layer_key=runtime.context.latest_uploaded_layer_key,
            clarification_option_id=clarification_option_id,
        )
        self.store.update_run_state(run_id, parsed_intent=intent, loop_phase=LOOP_PHASES["observe"])
        self._append_event(run_id, thread_id, EventType.INTENT_PARSED, "已解析任务意图。", payload=intent.model_dump(mode="json"))
        self._record_loop(run_id, thread_id, iteration=1, phase=LOOP_PHASES["observe"], title="读取当前会话信息", description=continuation_note or "已装入当前问题、最近结果和会话上下文。")

        context_manager = AgentContextManager(store=self.store, config=runtime_config.context)
        context_packet = context_manager.build_live_packet(run_id=run_id, thread_id=thread_id)
        plan = ExecutionPlan(goal="oai_supervisor_decision", steps=[])
        catalog_layers = runtime.store.layer_repository.list_active_layers()
        thread_layer_keys = _collect_thread_layer_keys(self.store, thread_id)
        available_layers = [item.layer_key for item in catalog_layers if item.layer_key in thread_layer_keys or item.source_type == 'managed']
        self.store.update_run_state(
            run_id, parsed_intent=intent, execution_plan=plan, warnings=[], errors=[],
            selected_data_sources=_collect_selected_data_sources(plan), plan_repair_attempts=0,
            text_only_delivery=plan.goal in {"text_only_delivery", "missing_data_sources"},
            context_references=context_packet.references,
            context_resolution=ContextResolution(status="observed", query=query, candidates=context_packet.references),
            sub_agents=[], loop_phase=LOOP_PHASES["observe"],
        )
        self._append_event(run_id, thread_id, EventType.PLAN_READY, "已交给 Agent 决策。", payload=plan.model_dump(mode="json"))
        self._record_loop(run_id, thread_id, iteration=1, phase=LOOP_PHASES["decide"], title="判断下一步动作", description=f"{self._provider_display_name(provider)} 正在分析并决定下一步。")

        supervisor = self._build_oai_supervisor(
            provider=provider,
            model_name=model_name,
            run_id=run_id,
            thread_id=thread_id,
            query=query,
            intent=intent,
            plan=plan,
            available_layers=available_layers,
            runtime=runtime,
            context_packet=context_packet,
        )
        run_config = self._build_oai_run_config(run_id=run_id, thread_id=thread_id)

        # SDK 执行边界
        #
        # 允许把 guardrail/格式错误交还 Agent 做有限自修；到达上限仍然失败，
        # 不能把不合格的中间状态包装成成功结果。
        current_state = self.store.get_run(run_id).state
        final_summary = ""
        final_response: AgentFinalResponse | None = None
        validation_error: RuntimeError | None = None
        repair_limit = max(0, runtime_config.planning.max_plan_repair_rounds)
        for repair_attempt in range(repair_limit + 1):
            repair_input = query if repair_attempt == 0 else context_manager.build_repair_observation(
                query=query,
                validation_error=validation_error,
                run_state=self.store.get_run(run_id).state,
                packet=context_packet,
            )
            try:
                streaming = Runner.run_streamed(supervisor, repair_input, max_turns=50, run_config=run_config)
                sdk_caps = self.model_registry.agents_sdk_capabilities(provider, model_name)
                final_summary = await self._consume_oai_stream(
                    streaming,
                    run_id=run_id,
                    thread_id=thread_id,
                    output_contract=sdk_caps.final_output_contract,
                )
                if streaming.interruptions:
                    self._persist_sdk_approval_interruptions(
                        run_id=run_id,
                        thread_id=thread_id,
                        streaming=streaming,
                        warnings=self.store.get_run(run_id).state.warnings,
                    )
                    return
            except Exception as exc:
                guardrail_error = self._extract_output_guardrail_error(exc)
                if guardrail_error is None:
                    self._record_loop(
                        run_id,
                        thread_id,
                        iteration=max(self.store.get_run(run_id).state.loop_iteration, 1),
                        phase=LOOP_PHASES["failed"],
                        title="Agent SDK 运行失败",
                        description=f"Agent SDK 运行失败：{exc}",
                        status="failed",
                    )
                    raise RuntimeError(f"Agent SDK 运行失败：{exc}") from exc
                validation_error = RuntimeError(guardrail_error)
                state_snapshot = self.store.get_run(run_id).state
                warnings = list(state_snapshot.warnings)
                if guardrail_error not in warnings:
                    warnings.append(guardrail_error)
                if repair_attempt >= repair_limit:
                    self.store.update_run_state(run_id, plan_repair_attempts=repair_attempt + 1, warnings=warnings)
                    self._record_loop(
                        run_id,
                        thread_id,
                        iteration=max(self.store.get_run(run_id).state.loop_iteration, 1),
                        phase=LOOP_PHASES["failed"],
                        title="Agent 结果边界失败",
                        description=f"Agent 结果边界校验失败且已达修正上限：{guardrail_error}",
                        status="failed",
                    )
                    raise RuntimeError(f"Agent 结果边界校验失败且已达修正上限：{guardrail_error}") from exc
                self.store.update_run_state(run_id, plan_repair_attempts=repair_attempt + 1, warnings=warnings)
                self._record_loop(run_id, thread_id, iteration=max(self.store.get_run(run_id).state.loop_iteration, 1), phase=LOOP_PHASES["observe_result"], title="结果边界未通过，正在修正", description=f"结果校验未通过：{guardrail_error}", status="running")
                continue

            current_state = self.store.get_run(run_id).state
            if self._is_text_delivery_allowed(intent, current_state, final_summary):
                current_state = self.store.update_run_state(run_id, text_only_delivery=True).state
            try:
                self._ensure_live_result_is_actionable(current_state, intent, final_summary)
                if any(item.status == "pending" for item in current_state.approvals):
                    final_response = AgentFinalResponse(summary="分析结果已生成，需要你确认是否发布到地图服务。", limitations=current_state.warnings, next_actions=["确认发布", "先在地图上看看", "下载 GeoJSON"])
                elif current_state.clarification and current_state.clarification.selected_option_id is None:
                    final_response = AgentFinalResponse(summary=current_state.clarification.question, limitations=[], next_actions=[option.label for option in current_state.clarification.options] or ["补充说明"])
                else:
                    final_response = self._coerce_sdk_final_response(
                        getattr(streaming, "final_output", None),
                        current_state,
                        streamed_text=final_summary,
                        allow_plain_text=self._allows_plain_text_final_response(provider, model_name),
                    )
                    if final_response is None:
                        raise RuntimeError("OpenAI Agents SDK 没有产出合格的结构化最终答复。")
                validation_error = None
                break
            except RuntimeError as exc:
                validation_error = exc
                state_snapshot = self.store.get_run(run_id).state
                warnings = list(state_snapshot.warnings)
                warning_text = str(exc)
                if warning_text not in warnings:
                    warnings.append(warning_text)
                if repair_attempt >= repair_limit:
                    self.store.update_run_state(run_id, plan_repair_attempts=repair_attempt + 1, warnings=warnings)
                    self._record_loop(
                        run_id,
                        thread_id,
                        iteration=max(self.store.get_run(run_id).state.loop_iteration, 1),
                        phase=LOOP_PHASES["failed"],
                        title="Agent 结果校验失败",
                        description=f"Agent SDK 结果校验失败且已达修正上限：{exc}",
                        status="failed",
                    )
                    raise RuntimeError(f"Agent SDK 结果校验失败且已达修正上限：{exc}") from exc
                self.store.update_run_state(run_id, plan_repair_attempts=repair_attempt + 1, warnings=warnings)
                self._record_loop(run_id, thread_id, iteration=max(self.store.get_run(run_id).state.loop_iteration, 1), phase=LOOP_PHASES["observe_result"], title="结果边界未通过，正在修正", description=f"校验未通过：{exc}", status="running")

        # 最终响应与发布审批
        if final_response is None:
            raise RuntimeError("OpenAI Agents SDK 没有产出合格的最终答复。")

        self.store.update_run_state(run_id, final_response=final_response)
        final_state = self.store.get_run(run_id).state
        completed_run = self.store.complete_run(run_id, final_state)
        event_type = EventType.CLARIFICATION_REQUIRED if completed_run.status == "clarification_needed" else EventType.RUN_COMPLETED
        self._append_event(
            run_id,
            thread_id,
            event_type,
            final_response.summary,
            payload={
                "finalResponse": final_response.model_dump(mode="json"),
                "clarification": completed_run.state.clarification.model_dump(mode="json") if completed_run.state.clarification else None,
                "status": completed_run.status,
            },
        )

    def _build_oai_supervisor(
        self,
        *,
        provider: str,
        model_name: str | None,
        run_id: str,
        thread_id: str | None,
        query: str,
        intent: UserIntent,
        plan: ExecutionPlan,
        available_layers: list[str],
        runtime: ToolRuntime,
        context_packet: LiveContextPacket,
    ):
        # SDK supervisor 装配。
        #
        # 这里只把平台工具、业务 prompt 和状态投影接进 SDK；
        # turn loop、handoff、工具审批和 tracing 均交给 Agents SDK 原语负责。
        if Agent is None:
            raise RuntimeError("OpenAI Agents SDK 未安装，请先安装 openai-agents 依赖后再启动分析。")
        model = self._build_oai_model(provider, model_name)
        if model is None:
            raise RuntimeError(f"provider '{provider}' 当前仅支持 openai_compatible live supervisor 主路径。")
        subagent_model = self._build_oai_subagent_model(provider)
        runtime_config = self._get_runtime_config()

        sdk_capabilities = self.model_registry.agents_sdk_capabilities(provider, model_name)
        output_contract = sdk_capabilities.final_output_contract
        supervisor_base = self._build_live_supervisor_prompt(
            query=query,
            intent=intent,
            plan=plan,
            available_layers=available_layers,
            output_contract=output_contract,
        )
        instructions = f"{supervisor_base}\n\n{context_packet.prompt_context}" if context_packet.prompt_context else supervisor_base
        all_tools = [self._build_oai_tool(defn.name, runtime, run_id, thread_id) for defn in self.tool_registry.list_definitions()]

        oai_subagents: list[Any] = []
        for item in runtime_config.sub_agents:
            sub_tools = [tool for tool in all_tools if tool.name in set(item.tools)]
            oai_subagents.append(Agent(
                name=item.agent_id,
                handoff_description=item.summary,
                instructions=self._build_live_subagent_prompt(item),
                tools=sub_tools,
                model=subagent_model or model,
            ))

        agent_kwargs: dict[str, Any] = {
            "name": runtime_config.supervisor.name,
            "instructions": instructions,
            "tools": all_tools,
            "handoffs": oai_subagents,
            "model": model,
            "output_guardrails": [self._build_oai_result_guardrail(run_id=run_id, intent=intent)],
        }
        model_settings = self._build_oai_model_settings(output_contract)
        if model_settings is not None:
            agent_kwargs["model_settings"] = model_settings
        if output_contract == "sdk_structured":
            agent_kwargs["output_type"] = AgentFinalResponse
        return Agent(**agent_kwargs)

    def _build_oai_result_guardrail(self, *, run_id: str, intent: UserIntent):
        # 结果硬边界交给 SDK guardrail 承接。
        #
        # guardrail 只判断“是否能交付”，不生成补救结果；失败会让 SDK run 抛错，
        # 外层 repair loop 再把事实反馈给同一个 Agent 继续修正。
        if output_guardrail is None or GuardrailFunctionOutput is None:
            raise RuntimeError("OpenAI Agents SDK guardrail 组件不可用。")

        @output_guardrail(name="gis_result_boundary")
        async def gis_result_boundary(_ctx: Any, _agent: Any, output: Any):
            state = self.store.get_run(run_id).state
            final_summary = self._extract_sdk_final_summary(output)
            try:
                self._ensure_live_result_is_actionable(state, intent, final_summary)
            except RuntimeError as exc:
                return GuardrailFunctionOutput(output_info={"error": str(exc)}, tripwire_triggered=True)
            return GuardrailFunctionOutput(output_info={"status": "ok"}, tripwire_triggered=False)

        return gis_result_boundary

    @staticmethod
    def _extract_output_guardrail_error(exc: Exception) -> str | None:
        # SDK guardrail tripwire 只代表结果边界未通过。
        #
        # 这里提取 guardrail 函数写入的业务原因，避免把 SDK 默认异常文案暴露给用户。
        if OutputGuardrailTripwireTriggered is None or not isinstance(exc, OutputGuardrailTripwireTriggered):
            return None
        result = getattr(exc, "guardrail_result", None)
        output = getattr(result, "output", None)
        info = getattr(output, "output_info", None)
        if isinstance(info, dict):
            error = info.get("error") or info.get("message")
            if error:
                return str(error)
        if info:
            return str(info)
        return "结果边界校验未通过。"

    @staticmethod
    def _extract_sdk_final_summary(output: Any) -> str:
        if isinstance(output, AgentFinalResponse):
            return output.summary
        if isinstance(output, dict):
            return str(output.get("summary") or output.get("content") or "")
        if isinstance(output, str):
            parsed = GeoAgentRuntime._decode_final_response_json(output)
            if parsed is not None:
                return str(parsed.get("summary") or "")
            return output
        return str(output or "")

    def _coerce_sdk_final_response(self, output: Any, state: AgentStateModel, *, streamed_text: str = "", allow_plain_text: bool = False) -> AgentFinalResponse | None:
        if isinstance(output, AgentFinalResponse):
            final_response = output
        elif isinstance(output, dict):
            try:
                final_response = AgentFinalResponse.model_validate(output)
            except Exception:
                return None
        elif isinstance(output, str) or streamed_text:
            raw_text = (output if isinstance(output, str) and output.strip() else streamed_text).strip()
            parsed = self._decode_final_response_json(raw_text)
            if parsed is None and streamed_text and streamed_text != output:
                parsed = self._decode_final_response_json(streamed_text)
            if parsed is None:
                if not allow_plain_text or not self._can_use_plain_sdk_text_as_final_response(raw_text, state):
                    return None
                final_response = AgentFinalResponse(summary=raw_text, limitations=state.warnings, next_actions=[])
            else:
                try:
                    final_response = AgentFinalResponse.model_validate(parsed)
                except Exception:
                    return None
        else:
            return None
        if _is_mechanical_final_summary(final_response.summary):
            return None
        return AgentFinalResponse(
            summary=self._correct_artifact_count_claims(final_response.summary.strip(), state),
            limitations=final_response.limitations[:3],
            next_actions=final_response.next_actions[:3],
        )

    @staticmethod
    def _can_use_plain_sdk_text_as_final_response(text: str, state: AgentStateModel) -> bool:
        # SDK 文本输出投影边界。
        #
        # 仅当运行状态已经证明这次交付是合法的文本问答，或已有真实工具/产物/审批事实时，
        # 才把 provider 的自然语言输出映射成 finalResponse；空泛模板仍然拒绝。
        if not text or _is_mechanical_final_summary(text):
            return False
        return bool(
            state.text_only_delivery
            or state.artifacts
            or state.approvals
            or state.place_resolution
            or state.tool_results
        )

    @staticmethod
    def _decode_final_response_json(text: str) -> dict[str, Any] | None:
        # JSON 最终输出边界。
        #
        # 只接受完整 JSON 对象，或唯一 fenced JSON block。
        # 多个代码块、自然语言里的零散花括号都不解析，避免把格式错误当成功。
        for candidate in GeoAgentRuntime._final_response_json_candidates(text):
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
        return None

    @staticmethod
    def _final_response_json_candidates(text: str) -> list[str]:
        raw = text.strip()
        if not raw:
            return []
        candidates = [raw]
        fenced_blocks = GeoAgentRuntime._extract_fenced_json_blocks(raw)
        if len(fenced_blocks) == 1:
            candidates.append(fenced_blocks[0])
        return list(dict.fromkeys(item.strip() for item in candidates if item.strip()))

    @staticmethod
    def _extract_fenced_json_blocks(text: str) -> list[str]:
        # fenced JSON 提取不靠贪婪正则。
        #
        # 只接受 ``` 或 ```json 开头的代码块；调用方会要求唯一 block。
        blocks: list[str] = []
        lines = text.splitlines()
        in_block = False
        buffer: list[str] = []
        for line in lines:
            marker = line.strip()
            if not in_block and marker in {"```", "```json", "```JSON"}:
                in_block = True
                buffer = []
                continue
            if in_block and marker == "```":
                blocks.append("\n".join(buffer).strip())
                in_block = False
                buffer = []
                continue
            if in_block:
                buffer.append(line)
        return [item for item in blocks if item]

    def _build_oai_run_config(self, *, run_id: str, thread_id: str | None):
        if RunConfig is None:
            return None
        return RunConfig(
            workflow_name="Geo Agent Runtime",
            group_id=thread_id or run_id,
            trace_metadata={"runId": run_id, "threadId": thread_id},
            tool_error_formatter=self._format_sdk_tool_error,
        )

    @staticmethod
    def _format_sdk_tool_error(args: Any) -> str | None:
        if getattr(args, "kind", None) == "approval_rejected":
            return "该操作需要审批，用户已拒绝，工具没有执行。"
        return None

    def _persist_sdk_approval_interruptions(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        streaming: Any,
        warnings: list[str],
    ) -> None:
        # SDK 审批中断持久化。
        #
        # RunState 是 SDK 的恢复事实源；平台 ApprovalRequest 只负责 UI 展示和
        # 把用户的 approve/reject 决策映射回 SDK state。
        sdk_state_json = streaming.to_state().to_json()
        state = self.store.get_run(run_id).state
        artifact = state.artifacts[-1] if state.artifacts else None
        resolved_approvals = [item for item in state.approvals if item.status != "pending"]
        approvals: list[ApprovalRequest] = []
        for index, interruption in enumerate(streaming.interruptions):
            tool_name = getattr(interruption, "tool_name", None) or "unknown_tool"
            raw_item = self._dump_sdk_item(getattr(interruption, "raw_item", None))
            approval = ApprovalRequest(
                approval_id=make_id("approval"),
                action=tool_name,
                title=f"确认执行：{tool_name}",
                description=f"Agent 请求执行需要审批的工具 {tool_name}。确认后会从 SDK 暂停点继续运行。",
                status="pending",
                artifact_id=artifact.artifact_id if artifact else None,
                payload={
                    "sdkRunState": sdk_state_json,
                    "sdkInterruptionIndex": index,
                    "toolName": tool_name,
                    "rawItem": raw_item,
                },
                created_at=now_utc(),
            )
            approvals.append(approval)

        final_response = AgentFinalResponse(
            summary="分析结果已生成，需要你确认后才能执行敏感操作。",
            limitations=warnings,
            next_actions=["确认执行", "先查看地图结果", "取消敏感操作"],
        )
        self.store.update_run_state(run_id, approvals=[*resolved_approvals, *approvals], final_response=final_response)
        self._record_loop(
            run_id,
            thread_id,
            iteration=max(state.loop_iteration, 1),
            phase=LOOP_PHASES["approval"],
            title="等待 SDK 审批",
            description="Agents SDK 已暂停在需要人工确认的工具调用前。",
            status="blocked",
            agent_id="geo_agent_supervisor",
            tool_name=approvals[0].action if approvals else None,
        )
        final_state = self.store.get_run(run_id).state
        self.store.complete_run(run_id, final_state)
        self._append_event(
            run_id,
            thread_id,
            EventType.APPROVAL_REQUIRED,
            final_response.summary,
            payload={
                "approvals": [item.model_dump(mode="json") for item in approvals],
                "finalResponse": final_response.model_dump(mode="json"),
            },
        )

    @staticmethod
    def _dump_sdk_item(item: Any) -> Any:
        if item is None:
            return None
        if hasattr(item, "model_dump"):
            return item.model_dump(mode="json")
        if isinstance(item, (dict, list, str, int, float, bool)):
            return item
        return str(item)

    async def _resolve_sdk_approval(
        self,
        *,
        run: Any,
        target: ApprovalRequest,
        approved: bool,
        context_factory,
        latest_uploaded_layer_key: str | None,
    ):
        # SDK 审批恢复。
        #
        # 真正的暂停点保存在 RunState；这里只恢复同一个 supervisor、
        # 调用 approve/reject，然后把 SDK 继续运行产生的结果重新投影回平台状态。
        if RunState is None or Runner is None:
            raise RuntimeError("OpenAI Agents SDK RunState 不可用，无法恢复审批中的运行。")

        state = run.state
        resolved = target.model_copy(update={"status": "approved" if approved else "rejected", "resolved_at": now_utc()})
        approvals = [item if item.approval_id != target.approval_id else resolved for item in state.approvals]
        self.store.update_run_state(run.id, approvals=approvals, status="running")

        runtime = context_factory(
            run_id=run.id,
            thread_id=run.thread_id,
            session_id=run.session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )
        intent = state.parsed_intent or parse_user_intent(state.user_query, latest_uploaded_layer_key=latest_uploaded_layer_key)
        plan = state.execution_plan or ExecutionPlan(goal="oai_supervisor_decision", steps=[])
        catalog_layers = runtime.store.layer_repository.list_active_layers()
        thread_layer_keys = _collect_thread_layer_keys(self.store, run.thread_id)
        available_layers = [item.layer_key for item in catalog_layers if item.layer_key in thread_layer_keys or item.source_type == "managed"]
        supervisor = self._build_oai_supervisor(
            provider=run.model_provider or self.model_registry.default_provider,
            model_name=run.model_name,
            run_id=run.id,
            thread_id=run.thread_id,
            query=run.user_query,
            intent=intent,
            plan=plan,
            available_layers=available_layers,
            runtime=runtime,
        )
        sdk_state_json = target.payload.get("sdkRunState")
        if not isinstance(sdk_state_json, dict):
            raise ValueError("审批记录缺少可恢复的 SDK RunState。")
        sdk_state = await RunState.from_json(supervisor, sdk_state_json, context_override={})
        interruptions = sdk_state.get_interruptions()
        interruption_index = int(target.payload.get("sdkInterruptionIndex") or 0)
        if interruption_index < 0 or interruption_index >= len(interruptions):
            raise ValueError("审批记录里的 SDK interruption index 已失效。")
        approval_item = interruptions[interruption_index]
        if approved:
            sdk_state.approve(approval_item)
        else:
            sdk_state.reject(approval_item, rejection_message="用户拒绝执行这个敏感操作。")

        final_summary = ""
        try:
            streaming = Runner.run_streamed(
                supervisor,
                sdk_state,
                max_turns=50,
                run_config=self._build_oai_run_config(run_id=run.id, thread_id=run.thread_id),
            )
            final_summary = await self._consume_oai_stream(
                streaming,
                run_id=run.id,
                thread_id=run.thread_id,
                output_contract=self.model_registry.agents_sdk_capabilities(
                    run.model_provider or self.model_registry.default_provider, run.model_name
                ).final_output_contract,
            )
            if streaming.interruptions:
                self._persist_sdk_approval_interruptions(
                    run_id=run.id,
                    thread_id=run.thread_id,
                    streaming=streaming,
                    warnings=self.store.get_run(run.id).state.warnings,
                )
                return self.store.get_run(run.id)

            current_state = self.store.get_run(run.id).state
            if self._is_text_delivery_allowed(intent, current_state, final_summary):
                current_state = self.store.update_run_state(run.id, text_only_delivery=True).state
            self._ensure_live_result_is_actionable(current_state, intent, final_summary)
            final_response = self._coerce_sdk_final_response(
                getattr(streaming, "final_output", None),
                current_state,
                streamed_text=final_summary,
                allow_plain_text=self._allows_plain_text_final_response(run.model_provider or self.model_registry.default_provider, run.model_name),
            )
            if final_response is None:
                raise RuntimeError("OpenAI Agents SDK 没有产出合格的结构化最终答复。")
            self.store.update_run_state(run.id, final_response=final_response)
            final_state = self.store.get_run(run.id).state
            self.store.complete_run(run.id, final_state)
            self._append_event(
                run.id,
                run.thread_id,
                EventType.RUN_COMPLETED,
                final_response.summary,
                payload={"finalResponse": final_response.model_dump(mode="json"), "approval": resolved.model_dump(mode="json")},
            )
            return self.store.get_run(run.id)
        except Exception as exc:
            formatted_error = _format_agent_error(exc, tool=target.action, step_id=target.approval_id)
            final_response = AgentFinalResponse(
                summary="审批后的继续执行失败。",
                limitations=[*state.warnings, formatted_error],
                next_actions=[],
            )
            self.store.update_run_state(run.id, approvals=approvals, errors=[*state.errors, formatted_error], final_response=final_response)
            final_state = self.store.get_run(run.id).state
            self.store.complete_run(run.id, final_state)
            self._append_event(
                run.id,
                run.thread_id,
                EventType.RUN_FAILED,
                final_response.summary,
                payload={"errors": [formatted_error], "finalResponse": final_response.model_dump(mode="json"), "summaryHint": final_summary},
            )
            return self.store.get_run(run.id)

    async def _consume_oai_stream(self, streaming: Any, *, run_id: str, thread_id: str | None, output_contract: str) -> str:
        """消费 OAI SDK 流式事件。

        无论 output_contract 如何声明，一律在流末端尝试 _extract_summary_from_json。
        流式过程中：
        - json_object / sdk_structured: 缓存不发送（确定是 JSON）
        - plain_text: 正常流式发送；一旦检测到 JSON 开头则切换为缓存模式
        """
        final_summary = ""
        iter_thinking = ""
        thinking_started_at: str | None = None
        _last_thinking_emit = 0.0
        _last_message_emit = 0.0
        _buffer = output_contract in ("json_object", "sdk_structured")
        async for event in streaming.stream_events():
            if RawResponsesStreamEvent is not None and isinstance(event, RawResponsesStreamEvent):
                data = event.data
                delta = getattr(data, "delta", None) or ""
                if delta and isinstance(delta, str):
                    data_type = type(data).__name__
                    if "Reasoning" in data_type:
                        if thinking_started_at is None:
                            thinking_started_at = now_utc()
                        iter_thinking += delta
                        _now = _time.monotonic()
                        if _now - _last_thinking_emit >= 0.12:
                            self._append_event(run_id, thread_id, EventType.THINKING_DELTA, iter_thinking, payload={"_done": False, "_startedAt": thinking_started_at})
                            _last_thinking_emit = _now
                    elif "Text" in data_type:
                        if iter_thinking:
                            self._append_event(run_id, thread_id, EventType.THINKING_DELTA, iter_thinking, payload={"_done": True, "_startedAt": thinking_started_at or now_utc()})
                            iter_thinking = ""
                            thinking_started_at = None
                            _last_thinking_emit = 0.0
                        final_summary += delta
                        if not _buffer:
                            stripped = final_summary.strip()
                            # 检测到 JSON 开头 → 切换为缓存模式，避免流式发送原始 JSON
                            if stripped.startswith("{"):
                                _buffer = True
                            else:
                                _now = _time.monotonic()
                                if _now - _last_message_emit >= 0.04:
                                    self._append_event(run_id, thread_id, EventType.MESSAGE_DELTA, stripped, payload={})
                                    _last_message_emit = _now
                    await asyncio.sleep(0)
        if iter_thinking:
            self._append_event(run_id, thread_id, EventType.THINKING_DELTA, iter_thinking, payload={"_done": True, "_startedAt": thinking_started_at or now_utc()})
        streamed = final_summary.strip()
        # 统一在流末端尝试从 JSON 中提取 summary，处理所有 provider 可能的 JSON 输出
        clean = _extract_summary_from_json(streamed)
        if clean:
            self._append_event(run_id, thread_id, EventType.MESSAGE_DELTA, clean, payload={"_done": True})
            return clean
        if not _buffer:
            # plain_text 且未检测到 JSON：文本已流式发送，无需重复
            final_output = self._extract_sdk_final_summary(streaming.final_output)
            return streamed or final_output
        # 缓存模式但 JSON 解析失败，发送原始文本
        if streamed:
            self._append_event(run_id, thread_id, EventType.MESSAGE_DELTA, streamed, payload={"_done": True})
        final_output = self._extract_sdk_final_summary(streaming.final_output)
        return streamed or final_output

    # ToolExecutionResult → ToolCall 共享字段。
    # 新增共享字段时只需加到这个 frozenset，不必改 _attach_tool_result_metadata 逻辑。
    _TOOL_METADATA_FIELDS: frozenset[str] = frozenset({
        "result_id", "source", "confidence", "used_query",
        "provenance", "crs", "geometry_type", "feature_count", "value_refs",
    })

    @classmethod
    def _attach_tool_result_metadata(cls, call: ToolCall, result: Any) -> ToolCall:
        # 工具 provenance 投影。
        #
        # ToolExecutionResult 是工具层事实，ToolCall 是运行态事实；
        # 这里把来源、CRS、几何类型、要素数量等审计字段同步到 run snapshot。
        updates: dict[str, Any] = {}
        for field in cls._TOOL_METADATA_FIELDS:
            value = getattr(result, field, None)
            if value is not None:
                updates[field] = value
            elif field in ("provenance", "crs"):
                updates[field] = {}
        if not updates:
            return call
        return call.model_copy(update=updates)

    def _sync_state_from_tool_result(self, *, run_id: str, query_kwargs: dict[str, Any], tool_name: str, result: Any, current_state: AgentStateModel | None = None, write_to_store: bool = True) -> dict[str, Any] | None:
        # 工具结果反向投影。
        #
        # Agent 仍然是决策主体，但地理编码、上下文候选这类工具的结构化事实
        # 需要写回 AgentState，供前端恢复、Debug 诊断和下一轮上下文工具读取。
        #
        # current_state 可由调用方传入以避免内部 get_run；write_to_store=False
        # 时返回 field dict 由调用方自行合并到批次写入。
        payload = getattr(result, "payload", {}) or {}
        updates: dict[str, Any] = {}
        state_for_context = current_state or self.store.get_run(run_id).state
        if tool_name == "geocode_place":
            raw_matches = payload.get("matches", []) if isinstance(payload, dict) else []
            candidates = [_to_place_candidate(item) for item in raw_matches if isinstance(item, dict)]
            status = "resolved" if len(candidates) == 1 else "ambiguous" if candidates else "not_found"
            updates["place_resolution"] = PlaceResolution(
                status=status,
                query=str(query_kwargs.get("query") or payload.get("query") or ""),
                provider=str(payload.get("provider") or self._get_runtime_config().geosearch.provider),
                selected=candidates[0] if len(candidates) == 1 else None,
                candidates=candidates,
            )
        elif tool_name == "list_context_references":
            references: list[ContextReference] = []
            for item in payload.get("references", []):
                try:
                    references.append(ContextReference.model_validate(item))
                except Exception:
                    continue
            updates["context_references"] = references
            updates["context_resolution"] = ContextResolution(status="observed", candidates=references)
        elif tool_name == "request_clarification":
            options: list[ClarificationOption] = []
            for index, item in enumerate(payload.get("options", []), start=1):
                if not isinstance(item, dict):
                    continue
                try:
                    options.append(
                        ClarificationOption(
                            option_id=str(item.get("optionId") or item.get("option_id") or f"option:{index}"),
                            label=str(item.get("label") or item.get("title") or f"选项 {index}"),
                            description=str(item.get("description") or item.get("label") or ""),
                            kind=str(item.get("kind") or payload.get("reason") or "generic"),
                            reason=str(payload.get("reason") or "generic"),
                            payload=dict(item.get("payload") or item),
                        )
                    )
                except Exception:
                    continue
            current_intent = state_for_context.parsed_intent
            if current_intent is not None:
                updates["parsed_intent"] = current_intent.model_copy(
                    update={
                        "clarification_required": True,
                        "clarification_question": str(payload.get("question") or result.message),
                        "clarification_options": options,
                    }
                )
            updates["clarification"] = ClarificationState(
                clarification_id=make_id("clarification"),
                kind=str(payload.get("reason") or "generic"),
                reason=str(payload.get("reason") or "generic"),
                question=str(payload.get("question") or result.message),
                options=options,
                allow_free_text=bool(payload.get("allowFreeText", True)),
            )
        selected_context = self._match_context_reference_from_args(state_for_context.context_references, query_kwargs)
        if selected_context is not None:
            updates["context_resolution"] = ContextResolution(
                status="resolved",
                selected_reference_id=selected_context.reference_id,
                selected_kind=selected_context.kind,
                source_run_id=selected_context.source_run_id,
                reason=f"tool_arg:{tool_name}",
                candidates=state_for_context.context_references,
            )
        if not updates:
            return None
        if write_to_store:
            self.store.update_run_state(run_id, **updates)
            return None
        return updates

    @staticmethod
    def _match_context_reference_from_args(references: list[ContextReference], args: dict[str, Any]) -> ContextReference | None:
        values: set[str] = set()

        def visit(value: Any) -> None:
            if isinstance(value, str):
                values.add(value)
            elif isinstance(value, dict):
                for nested in value.values():
                    visit(nested)
            elif isinstance(value, list):
                for nested in value:
                    visit(nested)

        visit(args)
        for reference in references:
            candidates = {
                reference.reference_id,
                reference.artifact_id or "",
                reference.collection_ref or "",
                reference.layer_key or "",
            }
            if values.intersection(item for item in candidates if item):
                return reference
        return None

    def _build_oai_tool(self, tool_name: str, runtime: ToolRuntime, run_id: str, thread_id: str | None):
        """构建 OAI SDK function_tool，内部复用现有的工具执行与状态同步逻辑。"""
        definition = self.tool_registry.get_definition(tool_name)
        tool_description = definition.metadata.description or definition.metadata.label

        async def _invoke(**kwargs: Any) -> str:
            # =========================================================================
            # 批次写入策略：
            #   执行前：1 次 state write（sub_agents + loop_trace + tool_results）
            #   执行后：1 次 state write（tool_results + artifacts + loop_trace + 工具特定字段）
            #   错误路径：1 次 state write（tool_results + errors + loop_trace）
            #   事件独立于状态写入：从计算好的数据发射，不从 DB 反读。
            # =========================================================================

            # --- 读取初始状态（整个 _invoke 仅此一次 get_run） ---
            state = self.store.get_run(run_id).state
            owner_definition = self._find_sub_agent_definition(tool_name=tool_name)
            owner: SubAgentState | None = next((item for item in state.sub_agents if owner_definition and item.agent_id == owner_definition.agent_id), None)
            iteration = max(state.loop_iteration + 1, 1)

            # --- 内存中计算所有执行前状态变更 ---
            sub_agents = list(state.sub_agents)
            is_new_owner = False
            if owner_definition is not None and owner is None:
                owner = SubAgentState(
                    agent_id=owner_definition.agent_id,
                    name=owner_definition.name,
                    role=owner_definition.role,
                    status="idle",
                    summary=owner_definition.summary,
                    tools=list(owner_definition.tools),
                )
                sub_agents.append(owner)
                is_new_owner = True

            # 执行前 loop trace 条目
            loop_trace = list(state.loop_trace)
            loop_limit = self._get_runtime_config().loop_trace_limit
            act_entry = LoopTraceEntry(
                iteration=iteration,
                phase=LOOP_PHASES["act"],
                title=f"调用工具 {tool_name}",
                description=f"准备执行工具 {tool_name}。",
                status="running",
                timestamp=now_utc(),
                agent_id=owner.agent_id if owner is not None else None,
                tool_name=tool_name,
                step_id=tool_name,
            )
            loop_trace.append(act_entry)
            loop_trace = loop_trace[-loop_limit:]

            # 子智能体标记运行中
            if owner is not None:
                sub_agents = self._mark_sub_agent(
                    sub_agents, owner.agent_id,
                    status="running", current_step_id=tool_name,
                    latest_message=f"正在执行 {tool_name}",
                )

            # 创建 ToolCall 并记入工具列表
            call = ToolCall(
                step_id=f"oai_{tool_name}_{make_id('step')}",
                tool=tool_name, args=kwargs,
                status="running", message=f"正在执行 {tool_name}",
                started_at=now_utc(),
            )
            tool_results = list(state.tool_results)
            tool_results.append(call)

            # === 执行前批次写入（1 次替代原来的 4 次 update_run_state） ===
            updated_run = self.store.update_run_state(
                run_id,
                sub_agents=sub_agents,
                loop_iteration=iteration,
                loop_phase=LOOP_PHASES["act"],
                loop_trace=loop_trace,
                tool_results=tool_results,
            )
            state = updated_run.state

            # --- 发射执行前事件 ---
            if is_new_owner:
                self._append_event(run_id, thread_id, EventType.SUBAGENT_CREATED, f"已委派子智能体：{owner.role}", payload=owner.model_dump(mode="json"))
            self._append_event(run_id, thread_id, EventType.LOOP_UPDATED, act_entry.description, payload=act_entry.model_dump(mode="json"))
            if owner is not None:
                self._append_event(run_id, thread_id, EventType.SUBAGENT_UPDATED, f"{owner.role} 正在执行 {tool_name}", payload=self._find_sub_agent(sub_agents, owner.agent_id).model_dump(mode="json"))
            self._append_event(run_id, thread_id, EventType.TOOL_STARTED, f"开始调用工具：{tool_name}", payload={"tool": tool_name, "args": kwargs, "loopPhase": LOOP_PHASES["act"], "loopIteration": iteration})

            # --- 执行工具 ---
            try:
                result = await self.tool_registry.execute(tool_name, kwargs, runtime)
            except Exception as exc:
                # === 错误路径：内存计算 + 1 次批次写入 ===
                formatted_error = _format_agent_error(exc, tool=tool_name, step_id=tool_name)
                tool_results[-1] = tool_results[-1].model_copy(update={"status": "failed", "message": formatted_error, "completed_at": now_utc()})

                fail_trace = list(state.loop_trace)
                fail_entry = LoopTraceEntry(
                    iteration=iteration,
                    phase=LOOP_PHASES["failed"],
                    title=f"{tool_name} 执行失败",
                    description=formatted_error,
                    status="failed",
                    timestamp=now_utc(),
                    agent_id=owner.agent_id if owner is not None else None,
                    tool_name=tool_name,
                    step_id=tool_name,
                )
                fail_trace.append(fail_entry)
                fail_trace = fail_trace[-loop_limit:]

                error_updates: dict[str, Any] = {
                    "tool_results": tool_results,
                    "errors": [*state.errors, formatted_error],
                    "failed_tool": tool_name,
                    "loop_iteration": iteration,
                    "loop_phase": LOOP_PHASES["failed"],
                    "loop_trace": fail_trace,
                }
                if owner is not None:
                    error_updates["sub_agents"] = self._mark_sub_agent(
                        list(state.sub_agents), owner.agent_id,
                        status="failed", current_step_id=tool_name,
                        latest_message=formatted_error,
                    )
                self.store.update_run_state(run_id, **error_updates)
                self._append_event(run_id, thread_id, EventType.LOOP_UPDATED, formatted_error, payload=fail_entry.model_dump(mode="json"))
                if owner is not None:
                    self._append_event(run_id, thread_id, EventType.SUBAGENT_UPDATED, f"{owner.role} 执行 {tool_name} 失败", payload=self._find_sub_agent(error_updates["sub_agents"], owner.agent_id).model_dump(mode="json"))
                raise RuntimeError(formatted_error) from exc

            # --- 执行后：内存计算所有状态变更 ---
            tool_results[-1] = tool_results[-1].model_copy(update={"status": "completed", "message": result.message, "completed_at": now_utc()})
            tool_results[-1] = self._attach_tool_result_metadata(tool_results[-1], result)

            artifacts = list(state.artifacts)
            has_new_artifact = False
            if result.artifact is not None and not any(item.artifact_id == result.artifact.artifact_id for item in artifacts):
                artifacts.append(result.artifact)
                has_new_artifact = True

            tool_value_refs_by_id = {ref.ref_id: ref for ref in state.tool_value_refs}
            for ref_id, ref in getattr(runtime.state, "value_map", {}).items():
                tool_value_refs_by_id[ref_id] = ref
            for ref in getattr(result, "value_refs", []) or []:
                tool_value_refs_by_id[ref.ref_id] = ref

            # 执行后 loop trace 条目
            post_trace = list(state.loop_trace)
            observe_entry = LoopTraceEntry(
                iteration=iteration,
                phase=LOOP_PHASES["observe_result"],
                title=f"吸收 {tool_name} 结果",
                description=result.message,
                status="completed",
                timestamp=now_utc(),
                agent_id=owner.agent_id if owner is not None else None,
                tool_name=tool_name,
                step_id=tool_name,
            )
            post_trace.append(observe_entry)
            post_trace = post_trace[-loop_limit:]

            # 构建批次写入字段
            state_updates: dict[str, Any] = {
                "tool_results": tool_results,
                "artifacts": artifacts,
                "tool_value_refs": list(tool_value_refs_by_id.values()),
                "loop_iteration": iteration,
                "loop_phase": LOOP_PHASES["observe_result"],
                "loop_trace": post_trace,
            }
            if owner is not None:
                state_updates["sub_agents"] = self._mark_sub_agent(
                    list(state.sub_agents), owner.agent_id,
                    status="completed", current_step_id=None,
                    latest_message=result.message,
                )

            # 工具特定状态（write_to_store=False → 返回 dict 供合并）
            tool_updates = self._sync_state_from_tool_result(
                run_id=run_id, query_kwargs=kwargs,
                tool_name=tool_name, result=result,
                current_state=state, write_to_store=False,
            )
            if tool_updates:
                state_updates.update(tool_updates)

            # === 执行后批次写入（1 次替代原来的 3-4 次 update_run_state） ===
            self.store.update_run_state(run_id, **state_updates)

            # --- 发射执行后事件 ---
            if has_new_artifact:
                self._append_event(run_id, thread_id, EventType.ARTIFACT_CREATED, f"已生成图层：{result.artifact.name}", payload=result.artifact.model_dump(mode="json"))
            if owner is not None:
                updated_sub_agents = state_updates.get("sub_agents") or state.sub_agents
                self._append_event(run_id, thread_id, EventType.SUBAGENT_UPDATED, f"{owner.role} 已完成 {tool_name}", payload=self._find_sub_agent(updated_sub_agents, owner.agent_id).model_dump(mode="json"))
            self._append_event(run_id, thread_id, EventType.TOOL_COMPLETED, result.message, payload={"tool": tool_name, "args": kwargs, "artifactId": result.artifact.artifact_id if result.artifact is not None else None, "result": result.payload, "valueRefs": serialize_value_refs_for_model(getattr(result, "value_refs", []) or []), "loopPhase": LOOP_PHASES["observe_result"], "loopIteration": iteration})
            self._append_event(run_id, thread_id, EventType.LOOP_UPDATED, result.message, payload=observe_entry.model_dump(mode="json"))
            observation = _format_tool_observation(tool_name=tool_name, result=result)
            return _truncate_observation(observation)

        # 用 Pydantic model 的 JSON Schema 作为工具参数定义。
        #
        # 目录/上下文类工具没有入参模型，OpenAI Agents 仍然需要 object schema；
        # 这里显式给出空参数对象，避免无参工具在注册阶段触发 None.model_json_schema。
        params_schema = (
            definition.args_model.model_json_schema()
            if definition.args_model is not None
            else {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        )

        async def _tool_handler(_ctx: Any, json_str: str) -> str:
            return await _invoke(**json.loads(json_str))

        return FunctionTool(
            name=tool_name,
            description=tool_description,
            params_json_schema=params_schema,
            on_invoke_tool=_tool_handler,
            strict_json_schema=False,
            needs_approval=tool_name in set(self._get_runtime_config().supervisor.approval_interrupt_tools),
            timeout_seconds=self._SDK_TOOL_TIMEOUT_SECONDS,
            timeout_behavior="raise_exception",
        )

    _LLM_TIMEOUT_SECONDS = 120
    _SDK_TOOL_TIMEOUT_SECONDS = 120

    def _supports_sdk_response_format(self, provider: str, model_name: str | None = None) -> bool:
        # SDK structured output 能力边界由 model adapter 声明。
        #
        # graph.py 不再靠 URL 字符串猜 provider；运行时只消费 registry 给出的事实。
        return self.model_registry.supports_agents_sdk_structured_output(provider, model_name)

    def _supports_json_object_response_format(self, provider: str, model_name: str | None = None) -> bool:
        return self.model_registry.supports_agents_sdk_json_object_output(provider, model_name)

    def _allows_plain_text_final_response(self, provider: str, model_name: str | None = None) -> bool:
        caps = self.model_registry.agents_sdk_capabilities(provider, model_name)
        return caps.final_output_contract == "plain_text"

    @staticmethod
    def _build_json_object_model_settings():
        # DeepSeek JSON Output 契约。
        #
        # Agents SDK 的 output_type 会发送 json_schema；DeepSeek 当前支持的是
        # json_object。这里通过 SDK ModelSettings.extra_body 显式启用 provider
        # 支持的 response_format，而不是在失败后猜测补救。
        if ModelSettings is None:
            return None
        return ModelSettings(
            parallel_tool_calls=False,
            extra_body={"response_format": {"type": "json_object"}},
        )

    @staticmethod
    def _build_oai_model_settings(output_contract: str):
        # SDK 模型调用统一设置。
        #
        # 工具循环仍由 Agents SDK 执行，但平台状态写回是按单工具调用顺序投影的；
        # 禁用并行工具调用可以避免多个工具同时改写同一个 run snapshot。
        if ModelSettings is None:
            return None
        if output_contract == "json_object":
            return GeoAgentRuntime._build_json_object_model_settings()
        return ModelSettings(parallel_tool_calls=False)


    def _resolve_oai_live_adapter(self, provider: str):
        # SDK 主路径 provider 解析。
        #
        # 配置缺失、provider 不支持和模型缺失要在平台边界直接报清楚，
        # 不把这些问题延迟到 SDK HTTP 请求阶段。
        try:
            adapter = self.model_registry.resolve_provider(provider)
        except Exception as exc:
            raise RuntimeError(str(exc)) from exc
        if adapter.provider != "openai_compatible":
            raise RuntimeError(f"provider '{adapter.provider}' 当前不能接入 OpenAI Agents SDK live supervisor；请选择 openai_compatible。")
        if not getattr(adapter, "base_url", None):
            raise RuntimeError("openai_compatible provider 缺少 base_url，无法启动 OpenAI Agents SDK live supervisor。")
        if not getattr(adapter, "api_key", None):
            raise RuntimeError("openai_compatible provider 缺少 api_key，无法启动 OpenAI Agents SDK live supervisor。")
        return adapter

    def _build_oai_model(self, provider: str, model_name: str | None) -> OpenAIChatCompletionsModel | None:
        """为 OpenAI-compatible provider 构建 OAI SDK 模型实例。"""
        if OpenAIChatCompletionsModel is None or AsyncOpenAI is None:
            return None
        adapter = self._resolve_oai_live_adapter(provider)
        resolved_model_name = model_name or getattr(adapter, "default_model", None)
        if not resolved_model_name:
            raise RuntimeError("openai_compatible provider 缺少模型名，无法启动 OpenAI Agents SDK live supervisor。")
        client = AsyncOpenAI(
            base_url=adapter.base_url,
            api_key=adapter.api_key,
            timeout=self._LLM_TIMEOUT_SECONDS,
            max_retries=1,
        )
        model_class = _StrictToolHistoryChatCompletionsModel or OpenAIChatCompletionsModel
        return model_class(model=resolved_model_name, openai_client=client)

    def _build_oai_subagent_model(self, provider: str) -> OpenAIChatCompletionsModel | None:
        """为子智能体构建模型，使用配置的子智能体模型名。"""
        if OpenAIChatCompletionsModel is None or AsyncOpenAI is None:
            return None
        adapter = self._resolve_oai_live_adapter(provider)
        subagent_model_name = getattr(adapter, "subagent_model_name", None) or getattr(adapter, "default_model", None)
        if not subagent_model_name:
            return None
        client = AsyncOpenAI(
            base_url=adapter.base_url,
            api_key=adapter.api_key,
            timeout=self._LLM_TIMEOUT_SECONDS,
            max_retries=1,
        )
        model_class = _StrictToolHistoryChatCompletionsModel or OpenAIChatCompletionsModel
        return model_class(model=subagent_model_name, openai_client=client)

    def _build_live_supervisor_prompt(self, *, query: str, intent: UserIntent, plan: ExecutionPlan, available_layers: list[str], output_contract: str) -> str:
        # live supervisor prompt 只负责角色、约束和当前任务边界，
        # 不在这里重复塞整套状态快照，避免 prompt 与上下文文件职责重叠。
        runtime_config = self._get_runtime_config()
        lines = [runtime_config.supervisor.system_prompt.strip()]
        lines.extend(
            [
                "",
                "## 你的工作方式",
                "- 所有空间信息必须通过工具获取，不要凭记忆直接背书。工具调用失败就直接告诉用户出了问题，不要编造结果、不要虚构「之前的对话」、不要假装有数据。",
                "- 调用工具前，用一句话解释为什么需要这一步。比如「先查一下澳门的坐标，后面才能做范围分析」→ 然后调 geocode_place。不要沉默调工具。",
                "- 工具返回后，用一句话总结拿到了什么、下一步做什么。「坐标拿到了，现在查周边医院」→ 然后调 search_external_pois。",
                "- 简单问题（查地点、问定义）直接回答。复杂问题按上面方式逐步推进。",
                '- 遇到指代词（「这个地点」「刚才那个结果」），先去上下文里找它对应的真实对象。',
                "- 以下情况主动确认，别替用户做主：地点有多个候选、用户意图模糊、操作代价大（如发布、删除）、查询条件不明确。用 request_clarification 生成选项让用户选。",
                "- 优先自己动手调工具，需要协作时才分派给子智能体。",
                "- layer_key 不确定就 list_available_layers 看一眼，别自己编。",
                "- 空间工具的参数只引用真实的引用 ID，不凭空构造。",
                "- 工具返回 valueRefs 时，后续工具必须直接传 valueRef（如 coordinate_ref、threshold_ref、variable_ref、bbox_ref、time_index_ref），不要把坐标、阈值或统计数值抄出来再传。",
                "- 地图跳转/定位类任务必须调用 geocode_place 写回真实 place_resolution；不能只在最终文本里说坐标。",
                "- 始终用中文，像和懂 GIS 的同事聊天，不是写技术文档。",
                "",
                "## 当前问题",
                query,
                "",
                "## 解析出的意图",
                f"- 区域: {intent.area or '未指定'}",
                f"- 地点锚点: {intent.place_query or '未指定'}",
                f"- 锚点类型: {intent.anchor_type or 'unknown'}",
                f"- 任务类型: {intent.task_type or '未识别'}",
                f"- 数据需求: {', '.join(intent.data_requirements) if intent.data_requirements else '未指定'}",
                f"- 已解析图层引用: {', '.join(intent.target_layers) if intent.target_layers else '未指定'}",
                f"- 距离约束: {int(intent.distance_m) if intent.distance_m else '无'}",
                "",
                "## 当前可用 layer_key",
            ]
        )
        if output_contract == "sdk_structured":
            lines.extend(
                [
                    "",
                    "## 最终输出格式",
                    "- 最终交付必须使用 SDK 配置的结构化输出格式，字段为 summary、limitations、nextActions；不要在最终输出里返回 Markdown 代码块。",
                ]
            )
        elif output_contract == "json_object":
            lines.extend(
                [
                    "",
                    "## 最终输出格式",
                    "- 当前 provider 使用 Chat Completions JSON mode；Agents SDK 仍负责工具、handoff、审批和 guardrail。",
                    '- 最终交付必须只输出一个 JSON 对象，不要写 Markdown，不要写代码块，不要在 JSON 前后添加说明。',
                    '- JSON 字段固定为：{"summary":"中文结论","limitations":[],"nextActions":[]}',
                    "- limitations 和 nextActions 必须是字符串数组；没有限制或下一步建议时使用空数组。",
                ]
            )
        else:
            lines.extend(
                [
                    "",
                    "## 最终输出格式",
                    "- 当前 provider 没有声明可用 response_format；最终答复可以是中文自然语言。",
                    "- 空间分析仍必须先通过真实工具、artifact 或审批状态证明，不能只靠文本交付。",
                ]
            )
        lines.extend(f"- {item}" for item in available_layers[:20])
        if plan.steps:
            lines.extend(["", "## 推荐执行顺序"])
            for index, step in enumerate(plan.steps, start=1):
                lines.append(f"- 第 {index} 步: 调用 {step.tool}，参数={step.args}，目的={step.reason}")
        else:
            lines.extend(
                [
                    "",
                    "## 执行决策",
                    "- 没有预设执行步骤时，根据工具列表、地点解析结果、数据源目录和当前上下文，由你自主决定最佳路径。",
                    "- 可以文本回答、地点定位、POI 汇总、生成 GeoJSON 成果或向用户澄清；不要引用不存在的图层。",
                ]
            )
        return "\n".join(item for item in lines if item is not None).strip()

    def _build_live_subagent_prompt(self, subagent_config) -> str:
        # 子智能体 prompt 来源于 runtime config，避免代码和数据库出现两套定义。
        lines = [
            (subagent_config.system_prompt or subagent_config.summary).strip(),
            "",
            "## 协作约定",
            "- 使用分配给你的专属工具完成任务，不自行构造图层名或执行步骤。",
            "- 需要加载图层时，直接使用 supervisor 已确认的 layer_key，不要猜测或拼接。",
            "- 完成后用中文简洁汇报，让 supervisor 能快速理解你的输出。",
        ]
        return "\n".join(lines).strip()

    def _ensure_live_result_is_actionable(self, state: AgentStateModel, intent: UserIntent, final_summary: str) -> None:
        # live 路径必须直接产出真实结果。
        #
        # 这里不再把"没有真正做事"解释成可自动恢复的正常分支，而是直接作为主路径失败处理。
        if state.errors:
            raise RuntimeError("实时智能体执行过程中已经出现错误，无法继续交付。")

        if state.clarification and state.clarification.selected_option_id is None:
            if state.artifacts or state.tool_results or state.place_resolution:
                return
            raise RuntimeError("实时智能体只发出了澄清问题而没有产出任何实质结果。")

        if state.text_only_delivery:
            if state.final_response or final_summary.strip() or state.place_resolution:
                return
            raise RuntimeError("实时智能体没有产出可交付的文本结果。")

        if intent.task_type == "map_navigation":
            if state.place_resolution:
                return
            raise RuntimeError("地图跳转任务没有产出真实地点解析结果，必须先调用 geocode_place。")

        if intent.task_type in {"orientation"}:
            return

        if intent.task_type == "geocode_lookup":
            if state.place_resolution:
                return
            if state.artifacts or any(item.tool == "publish_result_geojson" for item in state.tool_results):
                return
            if final_summary.strip() and not _is_mechanical_final_summary(final_summary):
                return
            raise RuntimeError("实时智能体没有产出地点解析结果。")

        if state.artifacts or state.approvals:
            return

        normalized = final_summary.strip()
        if normalized and not normalized.endswith("分析已完成。"):
            raise RuntimeError("实时智能体没有产出可交付结果，只返回了过程说明文本。")
        raise RuntimeError("实时智能体没有产出可交付结果。")

    def _is_text_delivery_allowed(self, intent: UserIntent, state: AgentStateModel, final_summary: str) -> bool:
        # 文本交付边界。
        #
        # "北京在哪"这类地点问答不一定需要生成 artifact；只要 Agent 给出了
        # 非模板化中文回答，就属于合法交付。空间计算和发布类任务仍必须经过工具、
        # artifact 或审批状态证明，不能靠一句话伪装成功。
        if state.errors or state.artifacts or state.approvals:
            return False
        if intent.publish_requested or intent.distance_m is not None or intent.data_requirements or intent.target_layers:
            return False
        if intent.task_type not in {"geocode_lookup", "orientation"}:
            return False
        return bool(final_summary.strip()) and not _is_mechanical_final_summary(final_summary)

    @staticmethod
    def _correct_artifact_count_claims(summary: str, state: AgentStateModel) -> str:
        # 防止模型把"结果图层数量"误说成"地点/对象数量"。
        #
        # 真正的命中数量来自最终 artifact metadata.feature_count；
        # 如果模型恰好把 artifact 数量当成对象数量，这里按事实源做一次窄口径修正。
        if not state.artifacts:
            return summary
        latest_count = state.artifacts[-1].metadata.get("feature_count")
        if not isinstance(latest_count, int):
            return summary
        artifact_count = len(state.artifacts)
        if artifact_count == latest_count:
            return summary
        wrong_phrases = [
            f"找到{artifact_count}个",
            f"找到 {artifact_count} 个",
            f"找到了{artifact_count}个",
            f"找到了 {artifact_count} 个",
        ]
        if not any(phrase in summary for phrase in wrong_phrases):
            return summary
        corrected = summary
        for phrase in wrong_phrases:
            corrected = corrected.replace(phrase, f"找到 {latest_count} 个")
        return corrected

    def _find_sub_agent_definition(self, *, agent_id: str | None = None, tool_name: str | None = None):
        for item in self._get_runtime_config().sub_agents:
            if agent_id and item.agent_id == agent_id:
                return item
            if tool_name and tool_name in item.tools:
                return item
        return None

    def _find_sub_agent(self, sub_agents: list[SubAgentState], agent_id: str) -> SubAgentState:
        for item in sub_agents:
            if item.agent_id == agent_id:
                return item
        definition = self._find_sub_agent_definition(agent_id=agent_id)
        if definition is not None:
            return SubAgentState(
                agent_id=definition.agent_id,
                name=definition.name,
                role=definition.role,
                summary=definition.summary,
                tools=list(definition.tools),
            )
        default_definition = next(iter(self._get_runtime_config().sub_agents), None)
        if default_definition is not None:
            return SubAgentState(
                agent_id=default_definition.agent_id,
                name=default_definition.name,
                role=default_definition.role,
                summary=default_definition.summary,
                tools=list(default_definition.tools),
            )
        raise KeyError(agent_id)

    def _mark_sub_agent(
        self,
        sub_agents: list[SubAgentState],
        agent_id: str,
        *,
        status: str,
        current_step_id: str | None,
        latest_message: str | None,
    ) -> list[SubAgentState]:
        # 子智能体状态更新保持纯函数化，避免在循环里原地修改旧对象。
        updated: list[SubAgentState] = []
        for item in sub_agents:
            if item.agent_id != agent_id:
                updated.append(item)
                continue
            updated.append(
                item.model_copy(
                    update={
                        "status": status,
                        "current_step_id": current_step_id,
                        "latest_message": latest_message,
                    }
                )
            )
        return updated

def _to_place_candidate(payload: dict[str, Any]) -> PlaceSearchCandidate:
    return PlaceSearchCandidate(
        label=str(payload.get("label") or payload.get("display_name") or "未知地点"),
        display_name=str(payload.get("display_name")) if payload.get("display_name") else None,
        country=str(payload.get("country")) if payload.get("country") else None,
        latitude=float(payload["latitude"]) if payload.get("latitude") is not None else None,
        longitude=float(payload["longitude"]) if payload.get("longitude") is not None else None,
        boundingbox=list(payload.get("boundingbox")) if isinstance(payload.get("boundingbox"), list) else None,
        source=str(payload.get("source")) if payload.get("source") else None,
    )


def _collect_selected_data_sources(plan: ExecutionPlan) -> list[str]:
    sources: list[str] = []
    for step in plan.steps:
        if step.tool == "load_layer" and step.args.get("layer_key"):
            sources.append(f"catalog:{step.args['layer_key']}")
        if step.tool == "search_external_pois" and step.args.get("category"):
            sources.append(f"external_poi:{step.args['category']}")
        if step.tool == "load_boundary" and step.args.get("name"):
            sources.append(f"boundary:{step.args['name']}")
        if step.tool == "geocode_place" and step.args.get("query"):
            sources.append(f"geosearch:{step.args['query']}")
    return list(dict.fromkeys(str(item) for item in sources))
