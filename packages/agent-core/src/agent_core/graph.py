# +-------------------------------------------------------------------------
#
#   地理智能平台 - Deep-style Agent 运行时
#
#   文件:       graph.py
#
#   日期:       2026年04月16日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 实现主智能体运行时、loop、子智能体调度、状态写回和审批续跑。

from __future__ import annotations
import asyncio
from typing import Any

from deepagents import FilesystemPermission, SubAgent, create_deep_agent
from deepagents.backends import StateBackend
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
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
from tool_registry import ToolRegistry, ToolRuntime

from .parser import build_execution_plan, parse_user_intent, verify_execution_plan
from .supervisor_config import LOOP_PHASES, build_default_runtime_config


# 统一格式化运行时错误
#
# 将工具名、step id 和异常类型压成稳定字符串，
# 便于 state / event / final response 复用同一份错误表达。
def _format_agent_error(exc: Exception, *, tool: str | None = None, step_id: str | None = None) -> str:
    prefix = "工具执行出错"
    if step_id or tool:
        prefix = f"工具执行出错（步骤 {step_id or 'unknown'}，工具 {tool or 'unknown'}）"
    return f"{prefix}: {exc.__class__.__name__}: {exc}"


# 模型消息内容归一化
#
# deepagents / LangChain 返回的 message.content 可能是字符串，
# 也可能是 text block 列表、带 extras 的结构化对象，甚至是自定义消息实例。
# 这里统一把它压成最终可展示的纯文本，避免把原始结构直接存进 final summary。
def _normalize_message_content(content: Any) -> str:
    if content is None:
        return ""

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts = [_normalize_message_content(item) for item in content]
        return "\n".join(part for part in parts if part).strip()

    if isinstance(content, dict):
        content_type = str(content.get("type") or "").strip().lower()
        if content_type == "text":
            return _normalize_message_content(content.get("text"))
        if "content" in content:
            return _normalize_message_content(content.get("content"))
        if "text" in content:
            return _normalize_message_content(content.get("text"))
        if "message" in content:
            return _normalize_message_content(content.get("message"))
        return ""

    nested_text = getattr(content, "text", None)
    if nested_text is not None:
        return _normalize_message_content(nested_text)

    nested_content = getattr(content, "content", None)
    if nested_content is not None and nested_content is not content:
        return _normalize_message_content(nested_content)

    return "[无法解析的模型输出]"


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
# 最终答复默认优先交给模型生成，但如果模型只吐出极短、极空泛的模板句，
# 这里会把它视作无效结果，退回我们准备好的稳定中文兜底。
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
        # 正式主路径只允许 live DeepAgents 接管决策。
        #
        # deterministic loop 保留为离线诊断/测试 helper，不再在用户请求里自动兜底；
        # 如果模型 provider 或外部服务不可用，应明确失败并写回事实状态，
        # 而不是用另一套规则计划伪装成一次成功的 Agent 运行。
        runtime = context_factory(
            run_id=run_id,
            thread_id=thread_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )
        effective_intent, _ = self._build_effective_intent(
            run_id=run_id,
            thread_id=thread_id,
            query=query,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
            clarification_option_id=clarification_option_id,
        )
        try:
            await self._run_with_deepagents(
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
                next_actions=["检查一下任务参数是否正确", "确认图层和服务是否正常", "调整后再试一次"],
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
        # 发布动作被视为硬中断边界：只有显式批准后才继续 act，
        # 拒绝则直接以可交付的最终结果收束运行。
        run = self.store.get_run(run_id)
        state = run.state
        approvals = list(state.approvals)
        target = next((item for item in approvals if item.approval_id == approval_id), None)
        if target is None:
            raise ValueError(f"未找到审批请求：{approval_id}")
        if target.status != "pending":
            return run

        resolved = target.model_copy(update={"status": "approved" if approved else "rejected", "resolved_at": now_utc()})
        approvals = [item if item.approval_id != approval_id else resolved for item in approvals]

        if not approved:
            final_response = AgentFinalResponse(
                summary="分析结果已保留，发布已取消。",
                limitations=state.warnings,
                next_actions=["在地图上查看结果", "需要时再发布"],
            )
            self.store.update_run_state(run_id, approvals=approvals, final_response=final_response)
            self._record_loop(
                run_id,
                run.thread_id,
                iteration=max(state.loop_iteration, 1),
                phase=LOOP_PHASES["deliver"],
                title="审批已拒绝",
                description="发布已被用户拒绝，分析结果已保留。",
                status="completed",
                agent_id="publisher",
                tool_name="publish_to_qgis_project",
            )
            final_state = self.store.get_run(run_id).state
            self.store.complete_run(run_id, final_state)
            self._append_event(
                run_id,
                run.thread_id,
                EventType.RUN_COMPLETED,
                final_response.summary,
                payload={"finalResponse": final_response.model_dump(mode="json"), "approval": resolved.model_dump(mode="json")},
            )
            return self.store.get_run(run_id)

        runtime = context_factory(
            run_id=run.id,
            thread_id=run.thread_id,
            session_id=run.session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )
        artifact = state.artifacts[-1] if state.artifacts else None
        if artifact is None:
            raise ValueError("当前运行没有可发布的结果对象。")

        publish_error: str | None = None
        try:
            result = await self.tool_registry.execute(
                "publish_to_qgis_project",
                {"artifact_id": artifact.artifact_id, "project_key": str(target.payload.get("projectKey") or self._get_runtime_config().default_publish_project_key)},
                runtime,
            )
            if result.warnings:
                publish_error = "发布完成但存在告警：" + "；".join(result.warnings)
        except Exception as exc:
            publish_error = f"发布失败：{exc.__class__.__name__}: {exc}"

        if publish_error is not None:
            final_response = AgentFinalResponse(
                summary="分析已完成，但发布到 QGIS Server 时遇到问题。",
                limitations=[*state.warnings, publish_error],
                next_actions=["重试发布", "查看地图结果", "下载 GeoJSON"],
            )
            self.store.update_run_state(run_id, approvals=approvals, final_response=final_response, errors=[*state.errors, publish_error])
            self._record_loop(
                run_id,
                run.thread_id,
                iteration=max(state.loop_iteration, 1),
                phase=LOOP_PHASES["failed"],
                title="发布失败",
                description=publish_error,
                status="failed",
                agent_id="publisher",
                tool_name="publish_to_qgis_project",
            )
            final_state = self.store.get_run(run_id).state
            self.store.complete_run(run_id, final_state)
            self._append_event(
                run_id,
                run.thread_id,
                EventType.RUN_COMPLETED,
                final_response.summary,
                payload={
                    "finalResponse": final_response.model_dump(mode="json"),
                    "approval": resolved.model_dump(mode="json"),
                    "publishError": publish_error,
                },
            )
            return self.store.get_run(run_id)

        final_response = AgentFinalResponse(
            summary="分析与发布已完成。",
            limitations=state.warnings,
            next_actions=["打开在线服务", "继续查看地图", "下载 GeoJSON"],
        )
        self.store.update_run_state(run_id, approvals=approvals, final_response=final_response)
        self._record_loop(
            run_id,
            run.thread_id,
            iteration=max(state.loop_iteration, 1),
            phase=LOOP_PHASES["deliver"],
            title="审批通过并完成发布",
            description="用户已批准，分析结果已发布到 QGIS Server，可通过在线服务访问。",
            status="completed",
            agent_id="publisher",
            tool_name="publish_to_qgis_project",
        )
        final_state = self.store.get_run(run_id).state
        self.store.complete_run(run_id, final_state)
        self._append_event(
            run_id,
            run.thread_id,
            EventType.RUN_COMPLETED,
            final_response.summary,
            payload={
                "finalResponse": final_response.model_dump(mode="json"),
                "approval": resolved.model_dump(mode="json"),
                "published": result.payload,
            },
        )
        return self.store.get_run(run_id)

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
    ) -> None:
        # loop trace 既写 state 也写事件。
        #
        # state 负责快照恢复，event 负责实时流和历史回放；
        # 两边共用同一份 LoopTraceEntry，避免前后端看到两套 loop 叙事。
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
        self.store.update_run_state(
            run_id,
            loop_iteration=iteration,
            loop_phase=phase,
            loop_trace=trace,
        )
        self._append_event(
            run_id,
            thread_id,
            EventType.LOOP_UPDATED,
            description,
            payload=entry.model_dump(mode="json"),
        )

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
        # 普通文本由 DeepAgents 自己结合上下文判断，不再靠 label 模糊匹配。
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

    def _enqueue_publish_approval(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        iteration: int,
        warnings: list[str],
        latest_artifact_id: str,
    ) -> AgentFinalResponse:
        # 发布审批节点只生成一次 pending 记录。
        #
        # 后续刷新页面或再次读取 run 时，都应该复用同一个 approval_id，
        # 否则前端无法稳定恢复审批块。
        current_state = self.store.get_run(run_id).state
        approvals = list(current_state.approvals)
        pending = next((item for item in approvals if item.status == "pending"), None)
        if pending is None:
            pending = ApprovalRequest(
                approval_id=make_id("approval"),
                action="publish",
                title="发布分析结果",
                description="分析结果已生成，等待你确认后发布到 QGIS Server。",
                artifact_id=latest_artifact_id,
                payload={"projectKey": self._get_runtime_config().default_publish_project_key},
                created_at=now_utc(),
            )
            approvals.append(pending)
            self._append_event(
                run_id,
                thread_id,
                EventType.APPROVAL_REQUIRED,
                pending.description,
                payload=pending.model_dump(mode="json"),
            )

        final_response = AgentFinalResponse(
            summary="分析已完成，正在等待发布审批。",
            limitations=list(warnings),
            next_actions=["批准发布", "拒绝发布", "先查看地图结果"],
        )
        self.store.update_run_state(run_id, approvals=approvals, final_response=final_response)
        self._record_loop(
            run_id,
            thread_id,
            iteration=max(iteration, 1),
            phase=LOOP_PHASES["approval"],
            title="等待审批",
            description=pending.description,
            status="blocked",
            agent_id="publisher",
            tool_name="publish_to_qgis_project",
        )
        return final_response

    async def _run_with_deepagents(
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
        # live deepagents 主路径。
        #
        # deepagents 负责上下文管理与 supervisor 决策，
        # 但最终的 run state、events、artifacts 仍然要回写到平台 store，
        # 这样 v1/v2 API、调试页和历史恢复才能共享同一事实源。
        model = self._build_langchain_model(provider, model_name)
        if model is None:
            raise RuntimeError(f"provider '{provider}' 当前无法构建 deepagents 模型实例")

        subagent_model = _build_subagent_model(self.model_registry, provider)

        runtime_config = self._get_runtime_config()
        intent, continuation_note = self._build_effective_intent(
            run_id=run_id,
            thread_id=thread_id,
            query=query,
            latest_uploaded_layer_key=runtime.context.latest_uploaded_layer_key,
            clarification_option_id=clarification_option_id,
        )
        # 默认用 run_id 隔离每次运行的 LangGraph 状态；仅在澄清延续时共享 thread 状态
        deepagents_thread_id = thread_id if continuation_note else run_id
        self.store.update_run_state(run_id, parsed_intent=intent, loop_phase=LOOP_PHASES["observe"])
        self._append_event(run_id, thread_id, EventType.INTENT_PARSED, "已解析任务意图。", payload=intent.model_dump(mode="json"))
        self._record_loop(
            run_id,
            thread_id,
            iteration=1,
            phase=LOOP_PHASES["observe"],
            title="读取当前会话信息",
            description=continuation_note or "已装入当前问题、最近结果和会话上下文。",
        )
        context_references = await self._load_context_reference_candidates(runtime)
        plan = ExecutionPlan(goal="deepagents_supervisor_decision", steps=[])
        plan_warnings: list[str] = []
        plan_errors: list[str] = []
        repair_attempts = 0
        catalog_layers = runtime.store.layer_repository.list_active_layers()
        available_layers = [item.layer_key for item in catalog_layers]
        self.store.update_run_state(
            run_id,
            parsed_intent=intent,
            execution_plan=plan,
            warnings=plan_warnings,
            errors=plan_errors,
            selected_data_sources=_collect_selected_data_sources(plan),
            plan_repair_attempts=repair_attempts,
            text_only_delivery=plan.goal in {"text_only_delivery", "missing_data_sources"},
            context_references=context_references,
            context_resolution=ContextResolution(status="observed", query=query, candidates=context_references),
            sub_agents=[],
            loop_phase=LOOP_PHASES["observe"],
        )
        self._append_event(run_id, thread_id, EventType.PLAN_READY, "已交给 Agent 决策。", payload=plan.model_dump(mode="json"))
        self._record_loop(
            run_id,
            thread_id,
            iteration=1,
            phase=LOOP_PHASES["decide"],
            title="判断下一步动作",
            description=f"{provider} 正在决定是否直接处理、调用工具或委派子智能体。",
        )

        tools = [self._build_deepagents_tool(definition.name, runtime, run_id, thread_id) for definition in self.tool_registry.list_definitions()]
        interrupt_on = {tool_name: True for tool_name in runtime_config.supervisor.approval_interrupt_tools}
        subagent_tools = {item.agent_id: {tool.name: tool for tool in tools if tool.name in set(item.tools)} for item in runtime_config.sub_agents}
        backend = StateBackend()
        files = self._build_deepagents_context_files(
            run_id=run_id,
            thread_id=thread_id,
            query=query,
            runtime=runtime,
        )
        agent = create_deep_agent(
            model=model,
            tools=tools,
            backend=backend,
            store=InMemoryStore(),
            checkpointer=InMemorySaver(),
            memory=runtime_config.context.memory_file_paths,
            permissions=[
                FilesystemPermission(operations=["read", "write"], paths=runtime_config.context.memory_file_paths, mode="allow"),
                FilesystemPermission(operations=["read", "write"], paths=["/**"], mode="deny"),
            ],
            interrupt_on=interrupt_on,
            subagents=[
                SubAgent(
                    name=item.agent_id,
                    description=item.summary,
                    system_prompt=self._build_live_subagent_prompt(item),
                    tools=list(subagent_tools.get(item.agent_id, {}).values()),
                    interrupt_on={tool_name: True for tool_name in item.tools if tool_name in interrupt_on},
                    model=subagent_model,
                )
                for item in runtime_config.sub_agents
            ],
            system_prompt=self._build_live_supervisor_prompt(query=query, intent=intent, plan=plan, available_layers=available_layers),
            name=runtime_config.supervisor.name,
        )
        current_state = self.store.get_run(run_id).state
        final_summary = "分析已完成。"
        validation_error: RuntimeError | None = None
        repair_limit = max(0, runtime_config.planning.max_plan_repair_rounds)
        for repair_attempt in range(repair_limit + 1):
            agent_input = query if repair_attempt == 0 else self._build_live_repair_observation(query, validation_error)
            result = await agent.ainvoke(
                {"messages": [{"role": "user", "content": agent_input}], "files": files},
                config={"configurable": {"thread_id": deepagents_thread_id}},
            )
            messages = result.get("messages", [])
            final_summary = "分析已完成。"
            if messages:
                final_message = messages[-1]
                final_summary = _normalize_message_content(getattr(final_message, "content", None)) or final_summary
            current_state = self.store.get_run(run_id).state
            if self._is_text_delivery_allowed(intent, current_state, final_summary):
                current_state = self.store.update_run_state(run_id, text_only_delivery=True).state
            try:
                self._ensure_live_result_is_actionable(current_state, intent, final_summary)
                validation_error = None
                break
            except RuntimeError as exc:
                validation_error = exc
                if repair_attempt >= repair_limit:
                    raise
                next_attempt = repair_attempt + 1
                self.store.update_run_state(run_id, plan_repair_attempts=next_attempt)
                self._record_loop(
                    run_id,
                    thread_id,
                    iteration=max(self.store.get_run(run_id).state.loop_iteration, 1),
                    phase=LOOP_PHASES["observe_result"],
                    title="校验结果并要求修正",
                    description=f"运行时校验未通过，已把原因交还给 Agent 重新处理：{exc}",
                    status="running",
                )
        final_response: AgentFinalResponse | None = None
        if intent.publish_requested and current_state.artifacts and not any(item.status == "pending" for item in current_state.approvals):
            final_response = self._enqueue_publish_approval(
                run_id=run_id,
                thread_id=thread_id,
                iteration=max(current_state.loop_iteration, 1),
                warnings=current_state.warnings,
                latest_artifact_id=current_state.artifacts[-1].artifact_id,
            )
            current_state = self.store.get_run(run_id).state
        if final_response is not None:
            pass
        elif any(item.status == "pending" for item in current_state.approvals):
            final_response = AgentFinalResponse(
                summary="分析结果已生成，需要你确认是否发布到地图服务。",
                limitations=current_state.warnings,
                next_actions=["确认发布", "先在地图上看看", "下载 GeoJSON"],
            )
        elif current_state.clarification and current_state.clarification.selected_option_id is None:
            final_response = AgentFinalResponse(
                summary=current_state.clarification.question,
                limitations=[],
                next_actions=[option.label for option in current_state.clarification.options] or ["补充说明"],
            )
        else:
            final_response = await self._build_user_facing_final_response(
                run_id=run_id,
                intent=intent,
                state=current_state,
                summary_hint=final_summary,
            )
        self.store.update_run_state(run_id, final_response=final_response)
        self._record_loop(
            run_id,
            thread_id,
            iteration=max(self.store.get_run(run_id).state.loop_iteration, 1),
            phase=LOOP_PHASES["deliver"],
            title="整理最终结果",
            description="分析已完成，最终结果已整理到对话中。",
            status="completed",
        )
        final_state = self.store.get_run(run_id).state
        self.store.complete_run(run_id, final_state)
        self._append_event(
            run_id,
            thread_id,
            EventType.RUN_COMPLETED,
            final_response.summary,
            payload={"finalResponse": final_response.model_dump(mode="json"), "mode": "deepagents"},
        )

    def _build_deepagents_context_files(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        query: str,
        runtime: ToolRuntime,
    ) -> dict[str, dict[str, str]]:
        # 把运行上下文显式整理成 deepagents 可消费的"上下文文件"。
        #
        # 这样比把约束零散塞进 prompt 更稳定，也能减少模型凭空发明 layer key。
        runtime_config = self._get_runtime_config()
        current_run = self.store.get_run(run_id)
        history_runs = self._list_thread_history(thread_id, limit=runtime_config.context.history_run_limit + 1)
        recent_runs = [item for item in history_runs if item.id != run_id]
        recent_events = self.store.list_events(run_id, limit=runtime_config.context.event_window)
        tool_calls = current_run.state.tool_results[-runtime_config.context.tool_call_window :]
        artifacts = current_run.state.artifacts[-runtime_config.context.artifact_window :]
        warnings = (current_run.state.warnings + current_run.state.errors)[-runtime_config.context.warning_window :]

        memory_documents = {
            "/AGENTS.md": self._format_thread_memory_summary(
                thread_id=thread_id,
                query=query,
                runtime=runtime,
                current_run=current_run,
                recent_runs=recent_runs,
                warnings=warnings,
            ),
            "/THREAD_CONTEXT.md": self._format_thread_context_history(
                current_run=current_run,
                recent_runs=recent_runs,
                recent_events=recent_events,
                tool_calls=tool_calls,
                artifacts=artifacts,
            ),
        }
        return {
            path: {"content": memory_documents.get(path, memory_documents["/THREAD_CONTEXT.md"]), "encoding": "utf-8"}
            for path in runtime_config.context.memory_file_paths
        }

    async def _load_context_reference_candidates(self, runtime: ToolRuntime) -> list[ContextReference]:
        # 上下文候选预载。
        #
        # 这里不做语义绑定，只调用只读上下文工具把当前 thread 的可引用事实列出来，
        # 供 DeepAgents 后续显式选择。选择结果仍必须经过工具参数和 reference 校验。
        if not self.tool_registry.has("list_context_references"):
            return []
        result = await self.tool_registry.execute("list_context_references", {}, runtime)
        references = []
        for item in result.payload.get("references", []):
            try:
                references.append(ContextReference.model_validate(item))
            except Exception:
                continue
        return references

    def _list_thread_history(self, thread_id: str | None, *, limit: int | None = None) -> list[Any]:
        if not thread_id:
            return []
        return self.store.list_runs_for_thread(thread_id, limit=limit)

    def _format_thread_memory_summary(
        self,
        *,
        thread_id: str,
        query: str,
        runtime: ToolRuntime,
        current_run: Any,
        recent_runs: list[Any],
        warnings: list[str],
    ) -> str:
        # 线程摘要只保留下一轮决策真正需要的上下文，避免历史噪音淹没当前任务。
        parts = [
            "# 线程上下文",
            f"- 线程 ID: {thread_id}",
            f"- 当前运行 ID: {current_run.id}",
            f"- 当前问题: {query}",
            f"- 最近上传图层: {runtime.context.latest_uploaded_layer_key or '无'}",
            f"- 当前运行状态: {current_run.status}",
        ]
        if current_run.state.final_response:
            parts.append(f"- 当前摘要: {current_run.state.final_response.summary}")
        if current_run.state.place_resolution:
            resolution = current_run.state.place_resolution
            parts.append(f"- 地点解析状态: {resolution.status}")
            if resolution.query:
                parts.append(f"- 地点查询词: {resolution.query}")
            if resolution.selected:
                parts.append(f"- 已选地点: {resolution.selected.display_name or resolution.selected.label}")
        if warnings:
            parts.append("- 当前告警:")
            parts.extend(f"  - {item}" for item in warnings)
        if recent_runs:
            parts.append("- 最近线程历史:")
            for item in recent_runs:
                summary = item.state.final_response.summary if item.state.final_response else item.user_query
                parts.append(f"  - [{item.status}] {item.user_query} -> {summary}")
                if item.state.place_resolution and item.state.place_resolution.selected:
                    selected = item.state.place_resolution.selected
                    parts.append(f"    已确认地点: {selected.display_name or selected.label}")
                if item.state.artifacts:
                    artifact_names = "、".join(artifact.name for artifact in item.state.artifacts[-3:])
                    parts.append(f"    可复用结果: {artifact_names}")
                if item.state.clarification and item.state.clarification.selected_option_id:
                    parts.append(f"    已选择澄清项: {item.state.clarification.selected_option_id}")
        available_layers = runtime.store.layer_repository.list_active_layers()
        if available_layers:
            parts.append("- 当前可用图层 key:")
            parts.extend(f"  - {item.layer_key}: {item.name} [{item.category}]" for item in available_layers[:12])
        parts.extend(
            [
                "",
                "## 使用约束",
                "- 优先复用线程中已有的结果和图层，确认不够用再调用工具。",
                "- 如果历史里已有同名结果或曾失败的步骤，先向用户说明差异再行动。",
                "- load_layer 只使用上面列出的原样 layer_key，或先 list_available_layers 获取最新目录。",
                "- 所有给用户的总结、澄清和交付说明都用中文。",
            ]
        )
        return "\n".join(parts)

    def _format_thread_context_history(
        self,
        *,
        current_run: Any,
        recent_runs: list[Any],
        recent_events: list[RunEvent],
        tool_calls: list[ToolCall],
        artifacts: list[Any],
    ) -> str:
        # 历史明细用于辅助模型理解最近几轮来龙去脉，和 memory summary 互补。
        parts = [
            "# 当前运行细节",
            f"- 运行 ID: {current_run.id}",
            f"- 状态: {current_run.status}",
            "",
            "## 最近工具调用",
        ]
        if tool_calls:
            parts.extend(f"- [{item.status}] {item.tool}: {item.message}" for item in tool_calls)
        else:
            parts.append("- 当前还没有工具调用记录。")

        parts.extend(["", "## 最近结果产物"])
        if artifacts:
            parts.extend(f"- {item.name} ({item.artifact_id})" for item in artifacts)
        else:
            parts.append("- 当前还没有产物。")

        parts.extend(["", "## 最近运行事件"])
        if recent_events:
            parts.extend(f"- {event.type}: {event.message}" for event in recent_events)
        else:
            parts.append("- 当前还没有事件流。")

        if recent_runs:
            parts.extend(["", "## 历史运行补充"])
            for item in recent_runs:
                parts.append(f"- [{item.status}] {item.user_query}")
                if item.state.final_response:
                    parts.append(f"  总结: {item.state.final_response.summary}")
                if item.state.place_resolution:
                    resolution = item.state.place_resolution
                    selected = resolution.selected.display_name or resolution.selected.label if resolution.selected is not None else "未选择"
                    parts.append(f"  地点: {resolution.status} / {resolution.query or '无'} / {selected}")
                if item.state.clarification:
                    clarification = item.state.clarification
                    parts.append(f"  澄清: {clarification.question} / 已选 {clarification.selected_option_id or '未选'}")
                if item.state.tool_results:
                    latest_tools = "；".join(f"{tool.tool}:{tool.status}" for tool in item.state.tool_results[-4:])
                    parts.append(f"  工具: {latest_tools}")
                if item.state.artifacts:
                    latest_artifacts = "；".join(f"{artifact.name}({artifact.artifact_id})" for artifact in item.state.artifacts[-4:])
                    parts.append(f"  产物: {latest_artifacts}")

        return "\n".join(parts)

    @staticmethod
    def _attach_tool_result_metadata(call: ToolCall, result: Any) -> ToolCall:
        # 工具 provenance 投影。
        #
        # ToolExecutionResult 是工具层事实，ToolCall 是运行态事实；
        # 这里把来源、CRS、几何类型、要素数量等审计字段同步到 run snapshot。
        return call.model_copy(
            update={
                "result_id": getattr(result, "result_id", None),
                "source": getattr(result, "source", None),
                "confidence": getattr(result, "confidence", None),
                "used_query": getattr(result, "used_query", None),
                "provenance": getattr(result, "provenance", {}) or {},
                "crs": getattr(result, "crs", {}) or {},
                "geometry_type": getattr(result, "geometry_type", None),
                "feature_count": getattr(result, "feature_count", None),
            }
        )

    def _sync_state_from_tool_result(self, *, run_id: str, query_kwargs: dict[str, Any], tool_name: str, result: Any) -> None:
        # 工具结果反向投影。
        #
        # Agent 仍然是决策主体，但地理编码、上下文候选这类工具的结构化事实
        # 需要写回 AgentState，供前端恢复、Debug 诊断和下一轮上下文工具读取。
        payload = getattr(result, "payload", {}) or {}
        updates: dict[str, Any] = {}
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
            current_intent = self.store.get_run(run_id).state.parsed_intent
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
        selected_context = self._match_context_reference_from_args(self.store.get_run(run_id).state.context_references, query_kwargs)
        if selected_context is not None:
            updates["context_resolution"] = ContextResolution(
                status="resolved",
                selected_reference_id=selected_context.reference_id,
                selected_kind=selected_context.kind,
                source_run_id=selected_context.source_run_id,
                reason=f"tool_arg:{tool_name}",
                candidates=self.store.get_run(run_id).state.context_references,
            )
        if updates:
            self.store.update_run_state(run_id, **updates)

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

    def _build_deepagents_tool(self, tool_name: str, runtime: ToolRuntime, run_id: str, thread_id: str | None):
        # deepagents tool 包装层。
        #
        # 这里负责把 deepagents 的工具调用翻译回平台事件与状态，
        # 保证 live 路径和确定性路径的可观测语义一致。
        definition = self.tool_registry.get_definition(tool_name)
        args_model = definition.args_model

        async def _invoke(**kwargs):
            state = self.store.get_run(run_id).state
            owner_definition = self._find_sub_agent_definition(tool_name=tool_name)
            owner = next((item for item in state.sub_agents if owner_definition and item.agent_id == owner_definition.agent_id), None)
            sub_agents = list(state.sub_agents)
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
                self.store.update_run_state(run_id, sub_agents=sub_agents)
                self._append_event(
                    run_id,
                    thread_id,
                    EventType.SUBAGENT_CREATED,
                    f"已调用子智能体：{owner.role}",
                    payload=owner.model_dump(mode="json"),
                )
                state = self.store.get_run(run_id).state
            iteration = max(state.loop_iteration + 1, 1)
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["act"],
                title=f"调用工具 {tool_name}",
                description=f"准备执行工具 {tool_name}。",
                status="running",
                agent_id=owner.agent_id if owner is not None else None,
                tool_name=tool_name,
                step_id=tool_name,
            )
            if owner is not None:
                sub_agents = self._mark_sub_agent(state.sub_agents, owner.agent_id, status="running", current_step_id=tool_name, latest_message=f"正在执行 {tool_name}")
                self.store.update_run_state(run_id, sub_agents=sub_agents)
                self._append_event(run_id, thread_id, EventType.SUBAGENT_UPDATED, f"{owner.role} 正在执行 {tool_name}", payload=self._find_sub_agent(sub_agents, owner.agent_id).model_dump(mode="json"))

            tool_results = list(state.tool_results)
            call = ToolCall(step_id=f"live_{tool_name}_{make_id('step')}", tool=tool_name, args=kwargs, status="running", message=f"正在执行 {tool_name}", started_at=now_utc())
            tool_results.append(call)
            self.store.update_run_state(run_id, tool_results=tool_results)
            self._append_event(run_id, thread_id, EventType.TOOL_STARTED, f"开始调用工具：{tool_name}", payload={"tool": tool_name, "args": kwargs})
            try:
                result = await self.tool_registry.execute(tool_name, kwargs, runtime)
            except Exception as exc:
                formatted_error = _format_agent_error(exc, tool=tool_name, step_id=tool_name)
                tool_results[-1] = tool_results[-1].model_copy(update={"status": "failed", "message": formatted_error, "completed_at": now_utc()})
                if owner is not None:
                    sub_agents = self._mark_sub_agent(self.store.get_run(run_id).state.sub_agents, owner.agent_id, status="failed", current_step_id=tool_name, latest_message=formatted_error)
                    self.store.update_run_state(run_id, tool_results=tool_results, sub_agents=sub_agents)
                else:
                    self.store.update_run_state(run_id, tool_results=tool_results)
                self._record_loop(
                    run_id,
                    thread_id,
                    iteration=iteration,
                    phase=LOOP_PHASES["failed"],
                    title=f"{tool_name} 执行失败",
                    description=formatted_error,
                    status="failed",
                    agent_id=owner.agent_id if owner is not None else None,
                    tool_name=tool_name,
                    step_id=tool_name,
                )
                if isinstance(exc, (ValueError, KeyError)):
                    raise RuntimeError(f"工具校验失败：{formatted_error}") from exc
                raise
            tool_results[-1] = tool_results[-1].model_copy(update={"status": "completed", "message": result.message, "completed_at": now_utc()})
            tool_results[-1] = self._attach_tool_result_metadata(tool_results[-1], result)

            artifacts = list(self.store.get_run(run_id).state.artifacts)
            if result.artifact is not None and not any(item.artifact_id == result.artifact.artifact_id for item in artifacts):
                artifacts.append(result.artifact)
                self._append_event(run_id, thread_id, EventType.ARTIFACT_CREATED, f"已生成图层：{result.artifact.name}", payload=result.artifact.model_dump(mode="json"))

            if owner is not None:
                sub_agents = self._mark_sub_agent(self.store.get_run(run_id).state.sub_agents, owner.agent_id, status="completed", current_step_id=None, latest_message=result.message)
                self.store.update_run_state(run_id, tool_results=tool_results, artifacts=artifacts, sub_agents=sub_agents)
                self._append_event(run_id, thread_id, EventType.SUBAGENT_UPDATED, f"{owner.role} 已完成 {tool_name}", payload=self._find_sub_agent(sub_agents, owner.agent_id).model_dump(mode="json"))
            else:
                self.store.update_run_state(run_id, tool_results=tool_results, artifacts=artifacts)
            self._append_event(
                run_id,
                thread_id,
                EventType.TOOL_COMPLETED,
                result.message,
                payload={
                    "tool": tool_name,
                    "args": kwargs,
                    "artifactId": result.artifact.artifact_id if result.artifact is not None else None,
                    "result": result.payload,
                },
            )
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["observe_result"],
                title=f"吸收 {tool_name} 结果",
                description=result.message,
                status="completed",
                agent_id=owner.agent_id if owner is not None else None,
                tool_name=tool_name,
                step_id=tool_name,
            )
            self._sync_state_from_tool_result(run_id=run_id, query_kwargs=kwargs, tool_name=tool_name, result=result)
            return self._format_tool_observation(tool_name=tool_name, result=result)

        description = definition.metadata.description or definition.metadata.label
        return StructuredTool.from_function(
            coroutine=_invoke,
            name=tool_name,
            description=description,
            args_schema=args_model,
        )

    @staticmethod
    def _format_tool_observation(*, tool_name: str, result: Any) -> str:
        # 给 Agent 的工具观察结果。
        #
        # 工具 payload 是 Agent 修正计划的主要事实来源，不能只返回一句"已完成"。
        payload = getattr(result, "payload", {}) or {}
        compact_payload = payload
        if tool_name == "list_context_references":
            compact_payload = {"references": payload.get("references", [])[:12]}
        elif tool_name == "search_thread_context":
            compact_payload = {"snippets": payload.get("snippets", [])[:8]}
        elif tool_name == "geocode_place":
            compact_payload = {
                "matches": payload.get("matches", [])[:5],
                "collectionRef": payload.get("collectionRef"),
                "collectionRefs": payload.get("collectionRefs", []),
                "provider": payload.get("provider"),
            }
        try:
            import json

            facts = json.dumps(compact_payload, ensure_ascii=False, default=str)
        except Exception:
            facts = str(compact_payload)
        return f"{result.message}\n结构化结果：{facts}"

    _LLM_TIMEOUT_SECONDS = 120

    def _build_langchain_model(self, provider: str, model_name: str | None):
        adapter = self.model_registry.resolve_provider(provider)
        resolved_model_name = model_name or getattr(adapter, "default_model", None)
        timeout = self._LLM_TIMEOUT_SECONDS
        if adapter.provider == "openai_compatible":
            from .compat_chat import CompatChatOpenAI
            return CompatChatOpenAI(model=resolved_model_name, api_key=adapter.api_key, base_url=adapter.base_url, timeout=timeout, max_retries=1)
        if adapter.provider == "anthropic":
            from langchain_anthropic import ChatAnthropic
            return ChatAnthropic(model=resolved_model_name, api_key=adapter.api_key, base_url=adapter.base_url, timeout=timeout, max_retries=1)
        if adapter.provider == "gemini":
            from langchain_google_genai import ChatGoogleGenerativeAI
            return ChatGoogleGenerativeAI(model=resolved_model_name, google_api_key=adapter.api_key, timeout=timeout)
        if adapter.provider == "ollama":
            from langchain_ollama import ChatOllama
            return ChatOllama(model=resolved_model_name, base_url=adapter.base_url, timeout=timeout)
        return None

    def _build_live_supervisor_prompt(self, *, query: str, intent: UserIntent, plan: ExecutionPlan, available_layers: list[str]) -> str:
        # live supervisor prompt 只负责角色、约束和当前任务边界，
        # 不在这里重复塞整套状态快照，避免 prompt 与上下文文件职责重叠。
        runtime_config = self._get_runtime_config()
        lines = [runtime_config.supervisor.system_prompt.strip()]
        lines.extend(
            [
                "",
                "## 工作约定",
                "- 你是决策核心：意图理解、地点消歧、图层匹配都由你来判断，Runtime 只负责执行和持久化。",
                "- 如果 Runtime 校验返回了错误，把它当作反馈来调整方案，而不是忽略或伪造成功。",
                "- 这是一次需要真实 GIS 能力的分析，记得调用工具去完成它，别停留在纯文字判断。",
                '- 看到「这个地点」「刚才那个结果」这类指代词时，先去 list_context_references 或 search_thread_context 找到它对应的真实对象。',
                "- 当上下文存在多个合理的候选时，主动通过 request_clarification 请用户确认，而不是自己猜测。",
                "- 优先自己直接调用工具完成任务；只有当问题明确需要多个角色协作时才调度子智能体。",
                "- 仔细阅读 /AGENTS.md 和 /THREAD_CONTEXT.md，判断当前是否是上一轮的追问或补充，优先复用已有的地点解析和图层结果。",
                "- 使用 load_layer 时，请用系统列出的精确 layer_key；不确定时先 list_available_layers 看看当前可用的图层。",
                "- 空间分析工具（buffer、distance_query、intersect 等）的参数务必使用真实的 collectionRef、artifactId、alias 或 layer_key。",
                "- 发布动作（publish_to_qgis_project）需要用户确认后才能执行，请在审批中断时耐心等待。",
                "- 和用户说的每一句话都用中文。",
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

    def _build_live_repair_observation(self, query: str, validation_error: RuntimeError | None) -> str:
        # 校验修正观察。
        #
        # 这不是 fallback，而是把 validator 的硬边界反馈给同一个 Agent thread。
        # Agent 仍然负责重新选择工具、澄清或文本交付；代码只说明上一轮为什么不能交付。
        reason = str(validation_error or "运行时校验未通过。")
        return "\n".join(
            [
                f"用户原始问题：{query}",
                f"上一轮交付被校验拦住，原因是：{reason}",
                "请重新处理这轮任务，下面是几点参考：",
                "- 地点问答 → 调用 geocode_place 拿到坐标，或给出自然、不模板化的位置说明。",
                "- 空间分析 → 务必使用真实工具和已有的 referenceId / artifactId / layerKey，产出可验证的结果或向用户提出澄清。",
                '- 不要只回复过程描述或一句「分析已完成」。',
            ]
        )

    def _ensure_live_result_is_actionable(self, state: AgentStateModel, intent: UserIntent, final_summary: str) -> None:
        # live 路径必须直接产出真实结果。
        #
        # 这里不再把"没有真正做事"解释成可自动恢复的正常分支，而是直接作为主路径失败处理。
        if state.errors:
            raise RuntimeError("实时智能体执行过程中已经出现错误，无法继续交付。")

        if state.clarification and state.clarification.selected_option_id is None:
            return

        if state.text_only_delivery:
            if state.final_response or final_summary.strip() or state.place_resolution:
                return
            raise RuntimeError("实时智能体没有产出可交付的文本结果。")

        if intent.publish_requested:
            has_pending_approval = any(item.status == "pending" for item in state.approvals)
            has_publish_execution = any(item.tool == "publish_to_qgis_project" for item in state.tool_results)
            if not has_pending_approval and not has_publish_execution and not state.artifacts:
                raise RuntimeError("实时智能体没有生成可发布结果。")

        if intent.task_type in {"orientation"}:
            return

        if intent.task_type == "geocode_lookup":
            if state.artifacts or any(item.tool == "publish_result_geojson" for item in state.tool_results) or state.place_resolution:
                return
            if self._is_text_delivery_allowed(intent, state, final_summary):
                return
            raise RuntimeError("实时智能体没有导出地点解析结果。")

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

    async def _build_user_facing_final_response(
        self,
        *,
        run_id: str,
        intent: UserIntent,
        state: AgentStateModel,
        summary_hint: str | None = None,
    ) -> AgentFinalResponse:
        # 用户态最终答复优先交给模型生成。
        #
        # 这里仍然保留稳定兜底，但默认尝试根据当前事实源生成更自然的中文答复，
        # 避免首页永远只看到机械的"分析已完成"。
        run = self.store.get_run(run_id)
        provider = run.model_provider or self.model_registry.default_provider
        if summary_hint and not _is_mechanical_final_summary(summary_hint) and not state.artifacts and not state.errors:
            return AgentFinalResponse(
                summary=summary_hint.strip(),
                limitations=list(state.warnings),
                next_actions=["继续补充分析需求", "查看已有结果", "换一个更明确的问题"],
            )

        # 单一模型可用性 gate：合并 provider 解析与配置检查。
        adapter = None
        try:
            if provider:
                adapter = self.model_registry.resolve_provider(provider)
        except Exception:
            pass
        if adapter is None or not adapter.is_configured():
            if provider:
                self._record_final_response_generation_warning(run_id, f"模型不可用: provider={provider}")
            return self._build_fallback_final_response(state=state, intent=intent, summary_hint=summary_hint)

        fallback = self._build_fallback_final_response(state=state, intent=intent, summary_hint=summary_hint)

        selected = state.place_resolution.selected if state.place_resolution else None
        place_label = (
            (selected.display_name or selected.label) if selected else None
        ) or intent.place_query or intent.area or "未明确地点"
        artifact_names = [item.name for item in state.artifacts[-3:]]
        latest_artifact = state.artifacts[-1] if state.artifacts else None
        latest_feature_count = latest_artifact.metadata.get("feature_count") if latest_artifact else None
        prompt = "\n".join(
            [
                "你是一位地理空间分析师，需要把这次任务的结论用中文自然地转达给用户。",
                "请基于下面提供的事实来组织答复，不要引入内部术语（如 thread、run、loop、fallback）。",
                "",
                "答复格式：",
                "summary：1～3 句中文，像人与人对话那样自然，控制在 35～120 字左右。",
                "limitations：最多列 3 条用户真正需要关心的限制，不用写系统内部告警。",
                "nextActions：最多 3 条简短的动作建议，帮助用户知道接下来可以做什么。",
                "",
                "要点：",
                "- 地点定位任务 → 明确说出找到了哪里，以及结果已同步到地图。",
                "- 引导/闲聊问题 → 坦诚说明还没执行真正的空间分析，并给出更具体的提问示例。",
                f"任务类型: {intent.task_type or 'unknown'}",
                f"用户原问题: {state.user_query}",
                f"地点锚点: {place_label}",
                f"结果图层数量: {len(state.artifacts)}",
                f"最终结果要素数量: {latest_feature_count if latest_feature_count is not None else '未知'}",
                f"最近结果名称: {', '.join(artifact_names) if artifact_names else '无'}",
                f"告警: {'；'.join(state.warnings) if state.warnings else '无'}",
                f"错误: {'；'.join(state.errors) if state.errors else '无'}",
                f"已选数据源: {'；'.join(state.selected_data_sources) if state.selected_data_sources else '无'}",
                f"纯文本交付: {'是' if state.text_only_delivery else '否'}",
                f"候选地点数量: {len(state.place_resolution.candidates) if state.place_resolution else 0}",
                f"placeResolution 状态: {state.place_resolution.status if state.place_resolution else 'unresolved'}",
                f"参考摘要: {summary_hint or fallback.summary}",
            ]
        )
        try:
            payload = await adapter.structured(
                prompt,
                schema=AgentFinalResponse.model_json_schema(),
                model=run.model_name,
                temperature=0.2,
            )
            generated = AgentFinalResponse.model_validate(payload)
        except Exception as exc:
            self._record_final_response_generation_warning(run_id, f"模型总结生成失败：{exc.__class__.__name__}: {exc}")
            return self._build_fallback_final_response(state=self.store.get_run(run_id).state, intent=intent, summary_hint=summary_hint)

        if _is_mechanical_final_summary(generated.summary):
            return fallback

        return AgentFinalResponse(
            summary=self._correct_artifact_count_claims(generated.summary.strip(), state),
            limitations=generated.limitations[:3] if generated.limitations else fallback.limitations,
            next_actions=generated.next_actions[:3] if generated.next_actions else fallback.next_actions,
        )

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

    def _record_final_response_generation_warning(self, run_id: str, reason: str) -> None:
        # 最终答复模型失败不是主分析失败，但不能静默吞掉。
        #
        # 用户仍会拿到基于事实源的稳定答复；debug / 历史状态里保留模型总结失败原因。
        run = self.store.get_run(run_id)
        warning = "模型总结暂时不可用，已基于运行结果生成简要答复。"
        warnings = list(run.state.warnings)
        if warning not in warnings:
            warnings.append(warning)
            self.store.update_run_state(run_id, warnings=warnings)
            self._append_event(
                run_id,
                run.thread_id,
                EventType.WARNING_RAISED,
                warning,
                payload={"kind": "final_response_generation", "reason": reason},
            )

    def _build_fallback_final_response(
        self,
        *,
        state: AgentStateModel,
        intent: UserIntent,
        summary_hint: str | None = None,
    ) -> AgentFinalResponse:
        # 模型不可用时的稳定交付兜底。
        #
        # 兜底仍然必须讲人话，不能直接退回没有信息量的"分析已完成"。
        resolution = state.place_resolution
        selected = resolution.selected if resolution else None
        place_label = (
            (selected.display_name or selected.label) if selected else None
        ) or intent.place_query or intent.area

        if intent.task_type == "geocode_lookup":
            summary = (
                f"我已经帮你定位到「{place_label}」，结果也同步到地图上了。你现在可以直接查看位置，或者继续追问它周边的对象和范围分析。"
                if place_label
                else "我已经完成这次地点定位，并把结果同步到地图上了。你现在可以继续围绕这个位置做附近、范围或叠加分析。"
            )
            return AgentFinalResponse(
                summary=summary,
                limitations=list(state.warnings),
                next_actions=["查看地图定位结果", "继续围绕这个地点提问", "下载 GeoJSON"],
            )

        if state.text_only_delivery:
            if intent.data_requirements and not state.selected_data_sources:
                requirement_text = "、".join(intent.data_requirements)
                return AgentFinalResponse(
                    summary=f"我已经理解你的分析目标，但当前 catalog 里还缺少可直接使用的 {requirement_text} 数据源，所以这轮先没有继续构造空间结果。",
                    limitations=[*list(state.warnings), "当前数据源不足以完成这类空间分析。"],
                    next_actions=["导入相关图层到数据源面板", "改成地点检索或 POI 汇总类问题", "补充更明确的数据来源后重试"],
                )
            if place_label:
                return AgentFinalResponse(
                    summary=f"我已经确认这轮问题围绕「{place_label}」展开。当前没有强制生成图层结果，但我们可以继续按你的目标补做周边查询、POI 汇总或空间分析。",
                    limitations=list(state.warnings),
                    next_actions=["继续补充想查的对象类型", "例如：查询 3 公里范围内的医院", "例如：继续查看这个地点周边设施"],
                )
            return AgentFinalResponse(
                summary="这轮我先给你整理了文字结论，还没有强制生成地图图层。你可以继续补充地点、对象类型或空间关系，我会接着往下分析。",
                limitations=list(state.warnings),
                next_actions=["补充地点", "补充对象类型", "继续发起空间分析"],
            )

        if intent.task_type == "orientation":
            return AgentFinalResponse(
                summary="我这次还没有进入真正的空间分析，只是先接住了你的问题。你可以直接告诉我地点、目标对象和空间关系，我就能继续帮你查具体结果。",
                limitations=list(state.warnings),
                next_actions=[
                    "例如：北京在哪",
                    "例如：查询北京 3 公里范围内的医院",
                    "例如：判断我上传的点是否落在柏林行政区内",
                ],
            )

        return self._build_final_response(list(state.artifacts), list(state.warnings), summary_hint=summary_hint)

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

    def _build_final_response(self, artifacts: list[Any], warnings: list[str], *, summary_hint: str | None = None) -> AgentFinalResponse:
        # 最终响应只面向用户交付，不重复暴露内部 loop / tool 细节。
        final_count = 0
        if artifacts:
            final_count = int((artifacts[-1].metadata or {}).get("feature_count", 0) or 0)
        summary = (summary_hint or "").strip() or "分析已完成。"
        if final_count:
            summary = f"分析已完成，共输出 {final_count} 个候选结果。"
        return AgentFinalResponse(
            summary=summary,
            limitations=warnings,
            next_actions=["查看地图图层", "下载 GeoJSON", "按需发布到 QGIS Server"],
        )


def _build_subagent_model(model_registry: Any, provider: str) -> Any | None:
    """为子智能体构建轻量模型，复用主 provider 的连接配置但使用配置的子智能体模型。"""
    try:
        adapter = model_registry.resolve_provider(provider)
    except Exception:
        return None
    if adapter.provider == "openai_compatible":
        from .compat_chat import CompatChatOpenAI
        subagent_model_name = getattr(adapter, "subagent_model_name", None) or getattr(adapter, "default_model", None)
        if not subagent_model_name:
            return None
        return CompatChatOpenAI(model=subagent_model_name, api_key=adapter.api_key, base_url=adapter.base_url, timeout=120, max_retries=1)
    return None


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

