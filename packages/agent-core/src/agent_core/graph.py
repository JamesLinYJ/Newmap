# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 工作流运行时
#
#   文件:       graph.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from gis_common.ids import make_id, now_utc
from shared_types.schemas import AgentFinalResponse, AgentStateModel, EventType, ExecutionPlan, RunEvent, ToolCall, UserIntent
from tool_registry import ToolRegistry, ToolRuntime

from .parser import (
    build_execution_plan,
    build_execution_plan_with_model,
    parse_user_intent,
    parse_user_intent_with_model,
    verify_execution_plan,
)


# Agent 图执行错误格式化。
def _format_agent_error(exc: Exception, *, tool: str | None = None, step_id: str | None = None) -> str:
    prefix = "分析执行失败"
    if step_id or tool:
        prefix = f"分析执行失败(step={step_id or 'unknown'}, tool={tool or 'unknown'})"
    return f"{prefix}: {exc.__class__.__name__}: {exc}"


class AgentState(TypedDict, total=False):
    session_id: str
    user_query: str
    model_provider: str
    model_name: str | None
    parsed_intent: Any
    execution_plan: Any
    current_step: int
    tool_results: list[dict[str, Any]]
    artifacts: list[dict[str, Any]]
    warnings: list[str]
    errors: list[str]
    failed_step_id: str | None
    failed_tool: str | None
    final_response: dict[str, Any]


class GeoAgentRuntime:
    # GeoAgentRuntime
    #
    # 将意图解析、计划生成、计划校验、工具执行与结果发布组织成一条 langgraph 工作流。
    def __init__(self, *, store: Any, tool_registry: ToolRegistry, model_registry: Any):
        self.store = store
        self.tool_registry = tool_registry
        self.model_registry = model_registry

    async def run(
        self,
        *,
        run_id: str,
        session_id: str,
        query: str,
        latest_uploaded_layer_key: str | None,
        provider: str,
        model_name: str | None,
        context_factory,
    ) -> None:
        context = context_factory(run_id=run_id, session_id=session_id, latest_uploaded_layer_key=latest_uploaded_layer_key)
        graph = self._build_graph(
            run_id=run_id,
            latest_uploaded_layer_key=latest_uploaded_layer_key,
            runtime=context,
            provider=provider,
            model_name=model_name,
        )
        initial_state: AgentState = {
            "session_id": session_id,
            "user_query": query,
            "model_provider": provider,
            "model_name": model_name,
            "current_step": 0,
            "tool_results": [],
            "artifacts": [],
            "warnings": [],
            "errors": [],
        }
        try:
            final_state = await graph.ainvoke(initial_state)
            model = AgentStateModel.model_validate(final_state)
            self.store.complete_run(run_id, model)
        except Exception as exc:
            formatted_error = _format_agent_error(exc)
            final_response = AgentFinalResponse(
                summary="分析执行失败。",
                limitations=[formatted_error],
                next_actions=["检查任务参数", "检查图层与服务状态", "修正后重试"],
            )
            failed_state = AgentStateModel(
                session_id=session_id,
                user_query=query,
                model_provider=provider,
                model_name=model_name,
                current_step=0,
                warnings=[],
                errors=[formatted_error],
                final_response=final_response,
            )
            self.store.append_event(
                run_id,
                RunEvent(
                    event_id=make_id("evt"),
                    run_id=run_id,
                    type=EventType.RUN_FAILED,
                    message="分析流程执行失败。",
                    timestamp=now_utc(),
                    payload={
                        "errors": failed_state.errors,
                        "failedStepId": None,
                        "failedTool": None,
                        "finalResponse": final_response.model_dump(mode="json"),
                    },
                ),
            )
            self.store.complete_run(run_id, failed_state)

    def _build_graph(
        self,
        *,
        run_id: str,
        latest_uploaded_layer_key: str | None,
        runtime: ToolRuntime,
        provider: str,
        model_name: str | None,
    ):
        # 工作流图构建器。
        #
        # 整条图固定分成五段：
        # 1. intent_parser 只回答“用户想做什么”。
        # 2. plan_builder 生成可执行步骤。
        # 3. plan_verifier 校验工具、图层和前提条件。
        # 4. executor 真正执行带副作用的步骤。
        # 5. result_interpreter / publisher 负责收尾总结与可选发布。
        workflow = StateGraph(AgentState)
        adapter = self.model_registry.resolve_provider(provider)

        async def intent_parser_node(state: AgentState) -> AgentState:
            # 意图解析节点
            #
            # 这里只做语义理解，不做任何真正的 GIS 计算或数据修改。
            available_layers = [item.layer_key for item in runtime.store.layer_repository.list_layers()]
            intent = await parse_user_intent_with_model(
                state["user_query"],
                adapter=adapter,
                model_name=model_name,
                latest_uploaded_layer_key=latest_uploaded_layer_key,
                available_layers=available_layers,
            )
            payload = intent.model_dump()
            self.store.append_event(
                run_id,
                RunEvent(
                    event_id=make_id("evt"),
                    run_id=run_id,
                    type=EventType.INTENT_PARSED,
                    message="已解析任务意图。",
                    timestamp=now_utc(),
                    payload=payload,
                ),
            )
            self.store.update_run_state(run_id, parsed_intent=intent)
            return {"parsed_intent": payload, "model_provider": provider, "model_name": model_name}

        async def plan_builder_node(state: AgentState) -> AgentState:
            # 执行计划生成节点
            #
            # 基于已解析意图和可用工具，为后续 verifier / executor 提供结构化步骤表。
            intent = parse_user_intent(state["user_query"], latest_uploaded_layer_key=latest_uploaded_layer_key)
            if state.get("parsed_intent") is not None:
                intent = UserIntent.model_validate(state["parsed_intent"])
            plan = await build_execution_plan_with_model(
                state["user_query"],
                intent=intent,
                adapter=adapter,
                model_name=model_name,
                latest_uploaded_layer_key=latest_uploaded_layer_key,
                available_tools=self.tool_registry.list_tools(),
            )
            self.store.append_event(
                run_id,
                RunEvent(
                    event_id=make_id("evt"),
                    run_id=run_id,
                    type=EventType.PLAN_READY,
                    message="已生成执行计划。",
                    timestamp=now_utc(),
                    payload=plan.model_dump(),
                ),
            )
            self.store.update_run_state(run_id, execution_plan=plan, parsed_intent=intent)
            return {"execution_plan": plan.model_dump(), "parsed_intent": intent.model_dump()}

        async def plan_verifier_node(state: AgentState) -> AgentState:
            # 执行计划校验节点
            #
            # 在真正执行前尽量提前发现：工具缺失、图层不可用、区域语义不完整等问题。
            intent_state = parse_user_intent(state["user_query"], latest_uploaded_layer_key=latest_uploaded_layer_key)
            if state.get("parsed_intent") is not None:
                intent_state = UserIntent.model_validate(state["parsed_intent"])
            plan = build_execution_plan(state["user_query"], parse_user_intent(state["user_query"], latest_uploaded_layer_key), latest_uploaded_layer_key)
            if state.get("execution_plan") is not None:
                plan = ExecutionPlan.model_validate(state["execution_plan"])
            warnings, errors = verify_execution_plan(
                plan,
                self.tool_registry.list_tools(),
                intent_state.area,
                available_layers=[item.layer_key for item in runtime.store.layer_repository.list_layers()],
                latest_uploaded_layer_key=latest_uploaded_layer_key,
            )
            for warning in warnings:
                self.store.append_event(
                    run_id,
                    RunEvent(
                        event_id=make_id("evt"),
                        run_id=run_id,
                        type=EventType.WARNING_RAISED,
                        message=warning,
                        timestamp=now_utc(),
                    ),
                )
            self.store.update_run_state(run_id, warnings=warnings, errors=errors)
            return {"warnings": warnings, "errors": errors}

        async def executor_node(state: AgentState) -> AgentState:
            # 执行节点
            #
            # 这是整条图里副作用最重的节点：
            # 工具调用、artifact 创建、事件落盘和 run.state 更新都发生在这里。
            intent = parse_user_intent(state["user_query"], latest_uploaded_layer_key=latest_uploaded_layer_key)
            if state.get("parsed_intent") is not None:
                intent = UserIntent.model_validate(state["parsed_intent"])
            if intent.clarification_required:
                warning = intent.clarification_question or "当前查询需要进一步澄清。"
                self.store.append_event(
                    run_id,
                    RunEvent(
                        event_id=make_id("evt"),
                        run_id=run_id,
                        type=EventType.WARNING_RAISED,
                        message=warning,
                        timestamp=now_utc(),
                        payload={"options": [option.model_dump() for option in intent.clarification_options]},
                    ),
                )
                updated_warnings = state.get("warnings", []) + [warning]
                self.store.update_run_state(run_id, warnings=updated_warnings)
                return {"warnings": updated_warnings}

            if state.get("errors"):
                return {
                    "current_step": state.get("current_step", 0),
                    "tool_results": state.get("tool_results", []),
                    "artifacts": state.get("artifacts", []),
                    "warnings": state.get("warnings", []),
                    "errors": state.get("errors", []),
                }

            plan = build_execution_plan(state["user_query"], intent, latest_uploaded_layer_key)
            if state.get("execution_plan") is not None:
                plan = ExecutionPlan.model_validate(state["execution_plan"])
            tool_results = [ToolCall.model_validate(item) if not isinstance(item, ToolCall) else item for item in state.get("tool_results", [])]
            artifacts = list(state.get("artifacts", []))
            warnings = list(state.get("warnings", []))

            for index, step in enumerate(plan.steps, start=1):
                # 每个 step 都先发 started 事件，再执行工具，再回写 completed/failed，
                # 这样前端事件流可以稳定还原出完整的执行轨迹。
                self.store.append_event(
                    run_id,
                    RunEvent(
                        event_id=make_id("evt"),
                        run_id=run_id,
                        type=EventType.STEP_STARTED,
                        message=f"开始执行：{step.reason}",
                        timestamp=now_utc(),
                        payload={"step": step.model_dump()},
                    ),
                )
                tool_results.append(
                    ToolCall(
                        step_id=step.id,
                        tool=step.tool,
                        args=step.args,
                        status="running",
                        message=step.reason,
                        started_at=now_utc(),
                    )
                )
                try:
                    result = await self.tool_registry.execute(step.tool, step.args, runtime)
                    tool_results[-1].status = "completed"
                    tool_results[-1].completed_at = now_utc()
                    tool_results[-1].message = result.message
                    if result.artifact is not None:
                        artifacts.append(result.artifact.model_dump())
                        self.store.append_event(
                            run_id,
                            RunEvent(
                                event_id=make_id("evt"),
                                run_id=run_id,
                                type=EventType.ARTIFACT_CREATED,
                                message=f"已生成图层：{result.artifact.name}",
                                timestamp=now_utc(),
                                payload=result.artifact.model_dump(),
                            ),
                        )
                    warnings.extend(result.warnings)
                    self.store.append_event(
                        run_id,
                        RunEvent(
                            event_id=make_id("evt"),
                            run_id=run_id,
                            type=EventType.STEP_COMPLETED,
                            message=result.message,
                            timestamp=now_utc(),
                            payload={"step_id": step.id, "index": index},
                        ),
                    )
                    self.store.update_run_state(
                        run_id,
                        current_step=index,
                        tool_results=[call.model_dump() for call in tool_results],
                        artifacts=artifacts,
                        warnings=warnings,
                    )
                except Exception as exc:
                    formatted_error = _format_agent_error(exc, tool=step.tool, step_id=step.id)
                    tool_results[-1].status = "failed"
                    tool_results[-1].completed_at = now_utc()
                    tool_results[-1].message = formatted_error
                    errors = list(state.get("errors", [])) + [formatted_error]
                    self.store.update_run_state(
                        run_id,
                        current_step=index - 1,
                        tool_results=[call.model_dump() for call in tool_results],
                        artifacts=artifacts,
                        warnings=warnings,
                        errors=errors,
                        failed_step_id=step.id,
                        failed_tool=step.tool,
                    )
                    return {
                        "current_step": index - 1,
                        "tool_results": [call.model_dump() for call in tool_results],
                        "artifacts": artifacts,
                        "warnings": warnings,
                        "errors": errors,
                        "failed_step_id": step.id,
                        "failed_tool": step.tool,
                    }

            return {
                "current_step": len(plan.steps),
                "tool_results": [call.model_dump() for call in tool_results],
                "artifacts": artifacts,
                "warnings": warnings,
            }

        async def result_interpreter_node(state: AgentState) -> AgentState:
            # 结果解释节点
            #
            # 这一层不再做 GIS 运算，而是把运行结果压缩成前端摘要、限制说明和下一步建议。
            intent = parse_user_intent(state["user_query"], latest_uploaded_layer_key=latest_uploaded_layer_key)
            if state.get("parsed_intent") is not None:
                intent = UserIntent.model_validate(state["parsed_intent"])
            if state.get("errors"):
                final_response = AgentFinalResponse(
                    summary="分析执行失败。",
                    limitations=state.get("errors", []) + state.get("warnings", []),
                    next_actions=["检查失败步骤", "修正图层或参数", "重新执行"],
                )
            elif intent.clarification_required:
                final_response = AgentFinalResponse(
                    summary=intent.clarification_question or "请先澄清查询地点。",
                    limitations=["歧义地名无法直接执行分析。"],
                    next_actions=[option.label for option in intent.clarification_options],
                )
            else:
                artifacts = state.get("artifacts", [])
                final_count = 0
                if artifacts:
                    final_count = int(artifacts[-1].get("metadata", {}).get("feature_count", 0) or 0)
                summary = "分析已完成。"
                if final_count:
                    summary = f"分析已完成，共输出 {final_count} 个候选结果。"
                final_response = AgentFinalResponse(
                    summary=summary,
                    limitations=state.get("warnings", []),
                    next_actions=["下载 GeoJSON", "查看地图图层", "按需发布到 QGIS Server"],
                )
            self.store.update_run_state(
                run_id,
                final_response=final_response,
                errors=state.get("errors", []),
                warnings=state.get("warnings", []),
                failed_step_id=state.get("failed_step_id"),
                failed_tool=state.get("failed_tool"),
            )
            return {"final_response": final_response.model_dump()}

        async def publisher_node(state: AgentState) -> AgentState:
            # 结果发布节点
            #
            # 只有当意图明确要求发布，且前面没有失败时，才会尝试把最新 artifact
            # 推到 QGIS Server。否则这里只负责发出最终 run.completed / run.failed 事件。
            publish_payload: dict[str, Any] | None = None
            errors = list(state.get("errors", []))
            artifacts = list(state.get("artifacts", []))
            intent = UserIntent.model_validate(state["parsed_intent"]) if state.get("parsed_intent") else None
            if not errors and intent and intent.publish_requested and artifacts:
                latest_artifact = dict(artifacts[-1])
                latest_artifact_id = latest_artifact.get("artifact_id") or latest_artifact.get("artifactId")
                latest_artifact_name = latest_artifact.get("name")
                latest_collection = self.store.get_artifact_collection(latest_artifact_id)
                try:
                    publish_result = await runtime.store.publisher.publish_artifact(
                        latest_artifact_id,
                        latest_artifact_name,
                        "demo-workspace",
                        collection=latest_collection,
                    )
                    publish_payload = {"artifactId": latest_artifact_id, **publish_result}
                    self.store.update_artifact_metadata(latest_artifact_id, publishResult=publish_payload)
                    latest_metadata = dict(latest_artifact.get("metadata") or {})
                    latest_metadata["publishResult"] = publish_payload
                    latest_artifact["metadata"] = latest_metadata
                    artifacts[-1] = latest_artifact
                except Exception as exc:
                    errors.append(_format_agent_error(exc, tool="publish_to_qgis_project", step_id="publish"))
            event_type = EventType.RUN_FAILED if state.get("errors") else EventType.RUN_COMPLETED
            if errors:
                event_type = EventType.RUN_FAILED
            self.store.append_event(
                run_id,
                RunEvent(
                    event_id=make_id("evt"),
                    run_id=run_id,
                    type=event_type,
                    message="分析流程已结束。" if event_type == EventType.RUN_COMPLETED else "分析流程执行失败。",
                    timestamp=now_utc(),
                    payload={
                        "final_response": state.get("final_response", {}),
                        "errors": errors,
                        "failedStepId": state.get("failed_step_id"),
                        "failedTool": state.get("failed_tool"),
                        "published": publish_payload,
                    },
                ),
            )
            return {**state, "artifacts": artifacts, "errors": errors}

        workflow.add_node("intent_parser", intent_parser_node)
        workflow.add_node("plan_builder", plan_builder_node)
        workflow.add_node("plan_verifier", plan_verifier_node)
        workflow.add_node("executor", executor_node)
        workflow.add_node("result_interpreter", result_interpreter_node)
        workflow.add_node("publisher", publisher_node)
        workflow.set_entry_point("intent_parser")
        workflow.add_edge("intent_parser", "plan_builder")
        workflow.add_edge("plan_builder", "plan_verifier")
        workflow.add_conditional_edges(
            "plan_verifier",
            lambda state: "result_interpreter" if state.get("errors") else "executor",
            {"result_interpreter": "result_interpreter", "executor": "executor"},
        )
        workflow.add_edge("executor", "result_interpreter")
        workflow.add_edge("result_interpreter", "publisher")
        workflow.add_edge("publisher", END)
        return workflow.compile()
