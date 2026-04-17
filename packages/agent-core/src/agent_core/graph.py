# +-------------------------------------------------------------------------
#
#   地理智能平台 - Deep-style Agent 运行时
#
#   文件:       graph.py
#
#   日期:       2026年04月16日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

from __future__ import annotations
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
    EventType,
    ExecutionPlan,
    LoopTraceEntry,
    RunEvent,
    SubAgentState,
    TodoItem,
    ToolCall,
    UserIntent,
)
from tool_registry import ToolRegistry, ToolRuntime

from .parser import build_execution_plan, parse_user_intent, verify_execution_plan
from .supervisor_config import LOOP_PHASES, build_default_runtime_config


def _format_agent_error(exc: Exception, *, tool: str | None = None, step_id: str | None = None) -> str:
    prefix = "分析执行失败"
    if step_id or tool:
        prefix = f"分析执行失败(step={step_id or 'unknown'}, tool={tool or 'unknown'})"
    return f"{prefix}: {exc.__class__.__name__}: {exc}"


class GeoAgentRuntime:
    # GeoAgentRuntime
    #
    # 统一负责：
    # 1. 生成细粒度运行状态（todo / subagent / approvals / tools）。
    # 2. 顺序执行 GIS 工具并持续写回事件与状态。
    # 3. 在审批通过后继续完成发布动作。
    #
    # 运行时统一维护同一套 supervisor loop。
    # 不同 provider 只影响“如何决定下一步”，不应该拆成两套状态模型。
    def __init__(self, *, store: Any, tool_registry: ToolRegistry, model_registry: Any):
        self.store = store
        self.tool_registry = tool_registry
        self.model_registry = model_registry
        self.deepagents_store = InMemoryStore()
        self.deepagents_checkpointer = InMemorySaver()

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
    ) -> None:
        runtime = context_factory(
            run_id=run_id,
            thread_id=thread_id,
            session_id=session_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )
        if self._supports_live_supervisor(provider):
            try:
                await self._run_with_deepagents(
                    run_id=run_id,
                    thread_id=thread_id,
                    query=query,
                    provider=provider,
                    model_name=model_name,
                    runtime=runtime,
                )
                return
            except Exception as exc:
                if self._should_surface_live_fallback_warning(exc):
                    self.store.update_run_state(
                        run_id,
                        warnings=self.store.get_run(run_id).state.warnings + [f"实时分析路径已切换到备用执行：{exc}"],
                    )
        try:
            await self._run_deterministic_supervisor_loop(
                run_id=run_id,
                thread_id=thread_id,
                query=query,
                latest_uploaded_layer_key=latest_uploaded_layer_key,
                runtime=runtime,
            )
        except Exception as exc:
            formatted_error = _format_agent_error(exc)
            final_response = AgentFinalResponse(
                summary="分析执行失败。",
                limitations=[formatted_error],
                next_actions=["检查任务参数", "检查图层与服务状态", "修正后重试"],
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
                summary="分析已完成，发布已被拒绝。",
                limitations=state.warnings,
                next_actions=["查看地图结果", "稍后重新发布"],
            )
            self.store.update_run_state(run_id, approvals=approvals, final_response=final_response)
            self._record_loop(
                run_id,
                run.thread_id,
                iteration=max(state.loop_iteration, 1),
                phase=LOOP_PHASES["deliver"],
                title="审批已拒绝",
                description=final_response.summary,
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

        result = await self.tool_registry.execute(
            "publish_to_qgis_project",
            {"artifact_id": artifact.artifact_id, "project_key": str(target.payload.get("projectKey") or self._get_runtime_config().default_publish_project_key)},
            runtime,
        )

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
            description=final_response.summary,
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

    async def _run_deterministic_supervisor_loop(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        query: str,
        latest_uploaded_layer_key: str | None,
        runtime: ToolRuntime,
    ) -> None:
        intent = parse_user_intent(query, latest_uploaded_layer_key=latest_uploaded_layer_key)
        plan = build_execution_plan(query, intent, latest_uploaded_layer_key=latest_uploaded_layer_key)
        warnings, errors = verify_execution_plan(
            plan,
            self.tool_registry.list_tools(),
            intent.area,
            available_layers=[item.layer_key for item in runtime.store.layer_repository.list_layers()],
            latest_uploaded_layer_key=latest_uploaded_layer_key,
        )
        existing_state = self.store.get_run(run_id).state
        merged_warnings = list(dict.fromkeys(existing_state.warnings + warnings))
        merged_errors = list(dict.fromkeys(existing_state.errors + errors))

        sub_agents = self._build_sub_agents(plan)
        todos = self._build_todos(plan, sub_agents)

        self.store.update_run_state(
            run_id,
            parsed_intent=intent,
            execution_plan=plan,
            warnings=merged_warnings,
            errors=merged_errors,
            todos=todos,
            sub_agents=sub_agents,
            loop_phase=LOOP_PHASES["observe"],
        )
        self._append_event(run_id, thread_id, EventType.INTENT_PARSED, "已解析任务意图。", payload=intent.model_dump(mode="json"))
        self._append_event(run_id, thread_id, EventType.PLAN_READY, "已生成执行计划。", payload=plan.model_dump(mode="json"))
        self._append_event(run_id, thread_id, EventType.TODO_UPDATED, "已生成任务清单。", payload={"todos": [item.model_dump(mode="json") for item in todos]})
        for sub_agent in sub_agents:
            self._append_event(
                run_id,
                thread_id,
                EventType.SUBAGENT_CREATED,
                f"已装配子智能体：{sub_agent.name}",
                payload=sub_agent.model_dump(mode="json"),
            )
        for warning in merged_warnings:
            self._append_event(run_id, thread_id, EventType.WARNING_RAISED, warning)

        iteration = 1
        self._record_loop(
            run_id,
            thread_id,
            iteration=iteration,
            phase=LOOP_PHASES["observe"],
            title="观察当前任务",
            description=f"supervisor 已读取查询、意图和 {len(todos)} 个待办。",
        )

        if intent.clarification_required:
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["decide"],
                title="进入澄清分支",
                description=intent.clarification_question or "当前任务需要用户补充澄清后再继续。",
                status="blocked",
            )
            final_response = AgentFinalResponse(
                summary=intent.clarification_question or "请先澄清查询地点。",
                limitations=["歧义地名无法直接执行分析。"],
                next_actions=[option.label for option in intent.clarification_options],
            )
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["deliver"],
                title="输出澄清请求",
                description=final_response.summary,
                status="completed",
            )
            self.store.update_run_state(run_id, final_response=final_response)
            final_state = self.store.get_run(run_id).state.model_copy(update={"final_response": final_response})
            self.store.complete_run(run_id, final_state)
            self._append_event(
                run_id,
                thread_id,
                EventType.RUN_COMPLETED,
                final_response.summary,
                payload={"finalResponse": final_response.model_dump(mode="json")},
            )
            return

        if errors:
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["failed"],
                title="计划校验失败",
                description="执行计划未通过校验，supervisor 停止进入 act。",
                status="failed",
            )
            final_response = AgentFinalResponse(
                summary="分析执行失败。",
                limitations=errors + warnings,
                next_actions=["检查失败步骤", "修正图层或参数", "重新执行"],
            )
            self.store.update_run_state(run_id, final_response=final_response)
            final_state = self.store.get_run(run_id).state.model_copy(update={"final_response": final_response})
            self.store.complete_run(run_id, final_state)
            self._append_event(
                run_id,
                thread_id,
                EventType.RUN_FAILED,
                "分析流程执行失败。",
                payload={"errors": errors, "finalResponse": final_response.model_dump(mode="json")},
            )
            return

        while True:
            current_state = self.store.get_run(run_id).state
            if not current_state.sub_agents:
                restored_sub_agents = self._build_sub_agents(plan)
                self.store.update_run_state(run_id, sub_agents=restored_sub_agents)
                current_state = self.store.get_run(run_id).state
            pending_todos = [item for item in current_state.todos if item.status == "pending"]
            if not pending_todos:
                break

            next_todo = pending_todos[0]
            step = next((candidate for candidate in plan.steps if candidate.id == next_todo.step_id), None)
            if step is None:
                break

            owner = self._pick_sub_agent(current_state.sub_agents, step.tool)

            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["decide"],
                title=f"选择下一步：{step.tool}",
                description=f"本轮决定由 {owner.name} 执行 {step.reason}",
                agent_id=owner.agent_id,
                tool_name=step.tool,
                step_id=step.id,
            )

            tool_results = list(current_state.tool_results)
            artifacts = list(current_state.artifacts)
            todos = self._mark_todo(current_state.todos, step.id, "running")
            sub_agents = self._mark_sub_agent(
                current_state.sub_agents,
                owner.agent_id,
                status="running",
                current_step_id=step.id,
                latest_message=step.reason,
            )
            call = ToolCall(
                step_id=step.id,
                tool=step.tool,
                args=step.args,
                status="running",
                message=step.reason,
                started_at=now_utc(),
            )
            tool_results.append(call)
            self.store.update_run_state(
                run_id,
                current_step=max(plan.steps.index(step), 0),
                todos=todos,
                sub_agents=sub_agents,
                tool_results=tool_results,
                artifacts=artifacts,
            )
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["act"],
                title=f"{owner.name} 开始执行",
                description=f"调用工具 {step.tool}，准备处理步骤 {step.id}。",
                agent_id=owner.agent_id,
                tool_name=step.tool,
                step_id=step.id,
            )
            self._append_event(
                run_id,
                thread_id,
                EventType.SUBAGENT_UPDATED,
                f"{owner.name} 开始处理 {step.reason}",
                payload=self._find_sub_agent(sub_agents, owner.agent_id).model_dump(mode="json"),
            )
            self._append_event(run_id, thread_id, EventType.TODO_UPDATED, f"任务开始：{step.reason}", payload={"todos": [item.model_dump(mode="json") for item in todos]})
            self._append_event(run_id, thread_id, EventType.STEP_STARTED, f"开始执行：{step.reason}", payload={"step": step.model_dump(mode="json")})
            self._append_event(run_id, thread_id, EventType.TOOL_STARTED, f"开始调用工具：{step.tool}", payload={"stepId": step.id, "tool": step.tool, "args": step.args})

            try:
                result = await self.tool_registry.execute(step.tool, step.args, runtime)
            except Exception as exc:
                formatted_error = _format_agent_error(exc, tool=step.tool, step_id=step.id)
                tool_results[-1] = tool_results[-1].model_copy(update={"status": "failed", "message": formatted_error, "completed_at": now_utc()})
                todos = self._mark_todo(todos, step.id, "failed")
                sub_agents = self._mark_sub_agent(sub_agents, owner.agent_id, status="failed", current_step_id=step.id, latest_message=formatted_error)
                errors = list(self.store.get_run(run_id).state.errors) + [formatted_error]
                final_response = AgentFinalResponse(
                    summary="分析执行失败。",
                    limitations=errors + self.store.get_run(run_id).state.warnings,
                    next_actions=["检查失败步骤", "修正图层或参数", "重新执行"],
                )
                self.store.update_run_state(
                    run_id,
                    current_step=max(plan.steps.index(step), 0),
                    todos=todos,
                    sub_agents=sub_agents,
                    tool_results=tool_results,
                    artifacts=artifacts,
                    errors=errors,
                    failed_step_id=step.id,
                    failed_tool=step.tool,
                    final_response=final_response,
                )
                self._record_loop(
                    run_id,
                    thread_id,
                    iteration=iteration,
                    phase=LOOP_PHASES["failed"],
                    title=f"{step.tool} 执行失败",
                    description=formatted_error,
                    status="failed",
                    agent_id=owner.agent_id,
                    tool_name=step.tool,
                    step_id=step.id,
                )
                final_state = self.store.get_run(run_id).state
                self.store.complete_run(run_id, final_state)
                self._append_event(
                    run_id,
                    thread_id,
                    EventType.RUN_FAILED,
                    "分析流程执行失败。",
                    payload={"errors": errors, "failedStepId": step.id, "failedTool": step.tool},
                )
                return

            tool_results[-1] = tool_results[-1].model_copy(update={"status": "completed", "message": result.message, "completed_at": now_utc()})
            if result.artifact is not None and not any(item.artifact_id == result.artifact.artifact_id for item in artifacts):
                artifacts.append(result.artifact)
                self._append_event(
                    run_id,
                    thread_id,
                    EventType.ARTIFACT_CREATED,
                    f"已生成图层：{result.artifact.name}",
                    payload=result.artifact.model_dump(mode="json"),
                )
            todos = self._mark_todo(todos, step.id, "completed")
            owner_completed = not any(item.step_id in owner.step_ids and item.status in {"pending", "running"} for item in todos)
            sub_agents = self._mark_sub_agent(
                sub_agents,
                owner.agent_id,
                status="completed" if owner_completed else "running",
                current_step_id=None if owner_completed else step.id,
                latest_message=result.message,
            )
            merged_warnings = list(dict.fromkeys(self.store.get_run(run_id).state.warnings + result.warnings))
            self.store.update_run_state(
                run_id,
                current_step=plan.steps.index(step) + 1,
                todos=todos,
                sub_agents=sub_agents,
                tool_results=tool_results,
                artifacts=artifacts,
                warnings=merged_warnings,
            )
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["observe_result"],
                title=f"吸收 {step.tool} 结果",
                description=result.message,
                status="completed",
                agent_id=owner.agent_id,
                tool_name=step.tool,
                step_id=step.id,
            )
            self._append_event(run_id, thread_id, EventType.TOOL_COMPLETED, result.message, payload={"stepId": step.id, "tool": step.tool})
            self._append_event(run_id, thread_id, EventType.STEP_COMPLETED, result.message, payload={"stepId": step.id, "index": plan.steps.index(step) + 1})
            self._append_event(run_id, thread_id, EventType.TODO_UPDATED, f"任务完成：{step.reason}", payload={"todos": [item.model_dump(mode="json") for item in todos]})
            self._append_event(
                run_id,
                thread_id,
                EventType.SUBAGENT_UPDATED,
                f"{owner.name} 已完成当前步骤。",
                payload=self._find_sub_agent(sub_agents, owner.agent_id).model_dump(mode="json"),
            )
            iteration += 1
            self._record_loop(
                run_id,
                thread_id,
                iteration=iteration,
                phase=LOOP_PHASES["observe"],
                title="重新观察运行状态",
                description=f"当前已完成 {len([item for item in todos if item.status == 'completed'])}/{len(todos)} 个待办。",
            )

        final_state = self.store.get_run(run_id).state
        final_response = self._build_final_response(list(final_state.artifacts), list(final_state.warnings))
        if intent.publish_requested and final_state.artifacts:
            final_response = self._enqueue_publish_approval(
                run_id=run_id,
                thread_id=thread_id,
                iteration=max(iteration, 1),
                warnings=list(final_state.warnings),
                latest_artifact_id=final_state.artifacts[-1].artifact_id,
            )
            updated_state = self.store.get_run(run_id).state
            self.store.complete_run(run_id, updated_state)
            self._append_event(
                run_id,
                thread_id,
                EventType.RUN_COMPLETED,
                final_response.summary,
                payload={
                    "finalResponse": final_response.model_dump(mode="json"),
                    "approvals": [item.model_dump(mode="json") for item in updated_state.approvals if item.status == "pending"],
                },
            )
            return

        self.store.update_run_state(run_id, final_response=final_response)
        self._record_loop(
            run_id,
            thread_id,
            iteration=max(iteration, 1),
            phase=LOOP_PHASES["deliver"],
            title="交付最终结果",
            description=final_response.summary,
            status="completed",
        )
        updated_state = self.store.get_run(run_id).state
        self.store.complete_run(run_id, updated_state)
        self._append_event(
            run_id,
            thread_id,
            EventType.RUN_COMPLETED,
            final_response.summary,
            payload={"finalResponse": final_response.model_dump(mode="json")},
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
    ) -> None:
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
        return bool(getattr(self.model_registry, "supports_live_supervisor", lambda _: False)(provider))

    def _append_event(self, run_id: str, thread_id: str | None, event_type: EventType, message: str, *, payload: dict[str, Any] | None = None) -> None:
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
        getter = getattr(self.store, "get_runtime_config", None)
        if callable(getter):
            return getter()
        return build_default_runtime_config()

    def _build_sub_agents(self, plan: ExecutionPlan) -> list[SubAgentState]:
        definitions = self._get_runtime_config().sub_agents
        sub_agents: list[SubAgentState] = []
        for item in definitions:
            step_ids = [step.id for step in plan.steps if step.tool in item.tools]
            if not step_ids:
                continue
            sub_agents.append(
                SubAgentState(
                    agent_id=item.agent_id,
                    name=item.name,
                    role=item.role,
                    status="pending",
                    summary=item.summary,
                    step_ids=step_ids,
                    tools=item.tools,
                )
            )
        return sub_agents

    def _enqueue_publish_approval(
        self,
        *,
        run_id: str,
        thread_id: str | None,
        iteration: int,
        warnings: list[str],
        latest_artifact_id: str,
    ) -> AgentFinalResponse:
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
    ) -> None:
        model = self._build_langchain_model(provider, model_name)
        if model is None:
            raise RuntimeError(f"provider '{provider}' 当前无法构建 deepagents 模型实例")

        runtime_config = self._get_runtime_config()
        deepagents_thread_id = thread_id or run_id
        intent = parse_user_intent(query, latest_uploaded_layer_key=runtime.context.latest_uploaded_layer_key)
        plan = build_execution_plan(query, intent, latest_uploaded_layer_key=runtime.context.latest_uploaded_layer_key)
        available_layers = [item.layer_key for item in runtime.store.layer_repository.list_layers()]
        plan_warnings, plan_errors = verify_execution_plan(
            plan,
            self.tool_registry.list_tools(),
            intent.area,
            available_layers=available_layers,
            latest_uploaded_layer_key=runtime.context.latest_uploaded_layer_key,
        )
        self.store.update_run_state(
            run_id,
            parsed_intent=intent,
            execution_plan=plan,
            warnings=plan_warnings,
            errors=plan_errors,
            sub_agents=[],
            loop_phase=LOOP_PHASES["observe"],
        )
        self._record_loop(
            run_id,
            thread_id,
            iteration=1,
            phase=LOOP_PHASES["observe"],
            title="读取当前会话信息",
            description="已装入当前问题、最近结果和会话上下文。",
        )
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
            thread_id=deepagents_thread_id,
            query=query,
            runtime=runtime,
        )
        agent = create_deep_agent(
            model=model,
            tools=tools,
            backend=backend,
            store=self.deepagents_store,
            checkpointer=self.deepagents_checkpointer,
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
                )
                for item in runtime_config.sub_agents
            ],
            system_prompt=self._build_live_supervisor_prompt(query=query, intent=intent, plan=plan, available_layers=available_layers),
            name=runtime_config.supervisor.name,
        )
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": query}], "files": files},
            config={"configurable": {"thread_id": deepagents_thread_id}},
        )
        messages = result.get("messages", [])
        final_summary = "分析已完成。"
        if messages:
            final_message = messages[-1]
            final_summary = getattr(final_message, "content", None) or final_summary
        current_state = self.store.get_run(run_id).state
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
        if self._should_retry_with_deterministic_loop(current_state, str(final_summary)):
            raise RuntimeError("实时智能体没有产出可交付结果，已切换到确定性执行。")
        if final_response is not None:
            pass
        elif any(item.status == "pending" for item in current_state.approvals):
            final_response = AgentFinalResponse(
                summary="分析结果已生成，等待你确认后发布。",
                limitations=current_state.warnings,
                next_actions=["确认是否发布", "继续查看地图", "下载 GeoJSON"],
            )
        elif current_state.artifacts:
            final_response = self._build_final_response(current_state.artifacts, current_state.warnings)
        else:
            final_response = AgentFinalResponse(
                summary=str(final_summary),
                limitations=current_state.warnings,
                next_actions=["查看地图图层", "下载 GeoJSON", "按需发布到 QGIS Server"],
            )
        self.store.update_run_state(run_id, final_response=final_response)
        self._record_loop(
            run_id,
            thread_id,
            iteration=max(self.store.get_run(run_id).state.loop_iteration, 1),
            phase=LOOP_PHASES["deliver"],
            title="整理最终结果",
            description=final_response.summary,
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
        thread_id: str,
        query: str,
        runtime: ToolRuntime,
    ) -> dict[str, dict[str, str]]:
        runtime_config = self._get_runtime_config()
        current_run = self.store.get_run(run_id)
        history_runs = self._list_thread_history(thread_id)
        recent_runs = [item for item in history_runs if item.id != run_id][: runtime_config.context.history_run_limit]
        recent_events = self.store.list_events(run_id)[-runtime_config.context.event_window :]
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

    def _list_thread_history(self, thread_id: str) -> list[Any]:
        list_runs = getattr(self.store, "list_runs_for_thread", None)
        if callable(list_runs):
            return list_runs(thread_id)
        return []

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
        if warnings:
            parts.append("- 当前告警:")
            parts.extend(f"  - {item}" for item in warnings)
        if recent_runs:
            parts.append("- 最近线程历史:")
            for item in recent_runs:
                summary = item.state.final_response.summary if item.state.final_response else item.user_query
                parts.append(f"  - [{item.status}] {item.user_query} -> {summary}")
        available_layers = runtime.store.layer_repository.list_layers()
        if available_layers:
            parts.append("- 当前可用图层 key:")
            parts.extend(f"  - {item.layer_key}: {item.name}" for item in available_layers[:12])
        parts.extend(
            [
                "",
                "## 使用约束",
                "- 先复用线程里已经生成的结果和图层，再决定是否重新调用工具。",
                "- 如果线程历史里已经有同名结果或已知失败步骤，优先说明差异后再执行。",
                "- 调用 load_layer 时只能使用上面列出的 layer_key 原样值，或先调用 list_available_layers 获取图层目录。",
                "- 所有对用户的总结、澄清和交付说明都使用中文。",
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

        return "\n".join(parts)

    def _build_deepagents_tool(self, tool_name: str, runtime: ToolRuntime, run_id: str, thread_id: str | None):
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
                raise
            tool_results[-1] = tool_results[-1].model_copy(update={"status": "completed", "message": result.message, "completed_at": now_utc()})

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
            return result.message

        description = definition.metadata.description or definition.metadata.label
        return StructuredTool.from_function(
            coroutine=_invoke,
            name=tool_name,
            description=description,
            args_schema=args_model,
        )

    def _build_langchain_model(self, provider: str, model_name: str | None):
        adapter = self.model_registry.resolve_provider(provider)
        resolved_model_name = model_name or getattr(adapter, "default_model", None)
        if adapter.provider == "openai_compatible":
            from langchain_openai import ChatOpenAI

            return ChatOpenAI(model=resolved_model_name, api_key=adapter.api_key, base_url=adapter.base_url)
        if adapter.provider == "anthropic":
            from langchain_anthropic import ChatAnthropic

            return ChatAnthropic(model=resolved_model_name, api_key=adapter.api_key, base_url=adapter.base_url)
        if adapter.provider == "gemini":
            from langchain_google_genai import ChatGoogleGenerativeAI

            return ChatGoogleGenerativeAI(model=resolved_model_name, google_api_key=adapter.api_key)
        if adapter.provider == "ollama":
            from langchain_ollama import ChatOllama

            return ChatOllama(model=resolved_model_name, base_url=adapter.base_url)
        return None

    def _build_live_supervisor_prompt(self, *, query: str, intent: UserIntent, plan: ExecutionPlan, available_layers: list[str]) -> str:
        runtime_config = self._get_runtime_config()
        lines = [runtime_config.supervisor.system_prompt.strip()]
        lines.extend(
            [
                "",
                "## 强制执行规则",
                "- 这是一个需要真实 GIS 工具执行的任务；如果没有调用任何工具，不要直接给出“分析已完成”的结论。",
                "- 优先直接调用工具；只有在当前任务明显需要分角色处理时，才调用子智能体。",
                "- 调用 load_layer 时，只能使用系统提供的精确 layer_key，不要自行拼接区域前缀、后缀或新的图层名。",
                "- 如果 layer_key 不确定，先调用 list_available_layers，再从结果里挑选精确 key。",
                "- 所有用户可见说明都使用中文。",
                "",
                "## 当前问题",
                query,
                "",
                "## 解析出的意图",
                f"- 区域: {intent.area or '未指定'}",
                f"- 任务类型: {intent.task_type or '未识别'}",
                f"- 目标图层: {', '.join(intent.target_layers) if intent.target_layers else '未指定'}",
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
            lines.extend(["", "## 推荐执行顺序", "- 当前没有可执行步骤；如果需要澄清，先向用户提出澄清。"])
        return "\n".join(item for item in lines if item is not None).strip()

    def _build_live_subagent_prompt(self, subagent_config) -> str:
        lines = [
            (subagent_config.system_prompt or subagent_config.summary).strip(),
            "",
            "## 子智能体规则",
            "- 只使用分配给你的工具，不要编造新的 layer_key 或步骤。",
            "- 如果需要加载图层，优先复用 supervisor 已经确认过的精确 layer_key。",
            "- 完成后用中文简要说明结果。",
        ]
        return "\n".join(lines).strip()

    def _should_retry_with_deterministic_loop(self, state: AgentStateModel, final_summary: str) -> bool:
        if state.parsed_intent and state.parsed_intent.publish_requested:
            has_pending_approval = any(item.status == "pending" for item in state.approvals)
            has_publish_execution = any(item.tool == "publish_to_qgis_project" for item in state.tool_results)
            if not has_pending_approval and not has_publish_execution:
                return True

        if state.tool_results or state.artifacts or state.approvals:
            return False

        normalized = final_summary.strip()
        if not normalized:
            return True
        if normalized == "分析已完成。":
            return True
        if "请确认" in normalized or "请选择" in normalized or "还需要" in normalized:
            return False
        return True

    def _should_surface_live_fallback_warning(self, exc: Exception) -> bool:
        message = str(exc)
        if "没有产出可交付结果" in message:
            return False
        return True

    def _pick_sub_agent(self, sub_agents: list[SubAgentState], tool_name: str) -> SubAgentState:
        if not sub_agents:
            fallback_agents = self._build_sub_agents(ExecutionPlan(goal="fallback", steps=[]))
            if fallback_agents:
                return fallback_agents[0]
            raise RuntimeError("当前 runtime config 没有可用的 subagent 定义。")
        for item in sub_agents:
            if tool_name in item.tools:
                return item
        return sub_agents[0]

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
        fallback_definition = self._find_sub_agent_definition(agent_id=agent_id)
        if fallback_definition is not None:
            return SubAgentState(
                agent_id=fallback_definition.agent_id,
                name=fallback_definition.name,
                role=fallback_definition.role,
                summary=fallback_definition.summary,
                tools=list(fallback_definition.tools),
            )
        fallback_agents = self._build_sub_agents(ExecutionPlan(goal="fallback", steps=[]))
        if fallback_agents:
            return fallback_agents[0]
        raise KeyError(agent_id)

    def _build_todos(self, plan: ExecutionPlan, sub_agents: list[SubAgentState]) -> list[TodoItem]:
        owner_by_tool = {tool: agent.agent_id for agent in sub_agents for tool in agent.tools}
        return [
            TodoItem(
                todo_id=f"todo_{step.id}",
                title=step.reason,
                description=f"调用 {step.tool} 完成当前空间步骤。",
                owner_agent_id=owner_by_tool.get(step.tool),
                step_id=step.id,
            )
            for step in plan.steps
        ]

    def _mark_todo(self, todos: list[TodoItem], step_id: str, status: str) -> list[TodoItem]:
        return [item if item.step_id != step_id else item.model_copy(update={"status": status}) for item in todos]

    def _mark_sub_agent(
        self,
        sub_agents: list[SubAgentState],
        agent_id: str,
        *,
        status: str,
        current_step_id: str | None,
        latest_message: str | None,
    ) -> list[SubAgentState]:
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

    def _build_final_response(self, artifacts: list[Any], warnings: list[str]) -> AgentFinalResponse:
        final_count = 0
        if artifacts:
            final_count = int((artifacts[-1].metadata or {}).get("feature_count", 0) or 0)
        summary = "分析已完成。"
        if final_count:
            summary = f"分析已完成，共输出 {final_count} 个候选结果。"
        return AgentFinalResponse(
            summary=summary,
            limitations=warnings,
            next_actions=["查看地图图层", "下载 GeoJSON", "按需发布到 QGIS Server"],
        )
