# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent SDK 边界测试
#
#   文件:       test_agent_sdk_boundaries.py
#
#   日期:       2026年05月13日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证 live supervisor 只走真实 SDK 主路径，
# 并防止最终答复重新退回代码拼装的成功交付。

from __future__ import annotations

import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

import agent_core.graph as graph_module
from agent_core import GeoAgentRuntime
from agent_core.supervisor_config import build_default_runtime_config
from model_adapters import ModelAdapterRegistry, RegistrySettings
from gis_common.ids import now_utc
from shared_types.schemas import (
    AgentFinalResponse,
    AgentStateModel,
    AnalysisRunRecord,
    ArtifactRef,
    ClarificationOption,
    ClarificationState,
    PlaceResolution,
    PlaceSearchCandidate,
    ToolCall,
    TodoItem,
    ToolValueRef,
    UserIntent,
)
from tool_registry import (
    ToolMetadata,
    ToolRegistry,
    ToolRuntime,
    ToolRuntimeContext,
    ToolRuntimeState,
)

try:
    from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText
except ModuleNotFoundError:  # pragma: no cover - SDK 缺失环境会跳过相关测试。
    ResponseFunctionToolCall = ResponseOutputMessage = ResponseOutputText = None  # type: ignore[assignment]

try:
    from agents import GuardrailFunctionOutput, OutputGuardrailResult, OutputGuardrailTripwireTriggered
except ModuleNotFoundError:  # pragma: no cover - SDK 缺失环境会跳过相关测试。
    GuardrailFunctionOutput = OutputGuardrailResult = OutputGuardrailTripwireTriggered = None  # type: ignore[assignment]


def _registry_settings(**overrides):
    defaults = {
        "default_model_provider": "openai_compatible",
        "default_model_name": None,
        "openai_base_url": "http://127.0.0.1:9999/v1",
        "openai_api_key": "test-key",
        "openai_model": "test-model",
        "openai_subagent_model": None,
        "anthropic_base_url": "https://api.anthropic.com/v1",
        "anthropic_api_key": "anthropic-key",
        "anthropic_model": "claude-test",
        "anthropic_version": "2023-06-01",
        "gemini_base_url": "https://generativelanguage.googleapis.com/v1beta",
        "gemini_api_key": "gemini-key",
        "gemini_model": "gemini-test",
        "ollama_base_url": "http://127.0.0.1:11434",
        "ollama_model": "llama-test",
    }
    defaults.update(overrides)
    return RegistrySettings(**defaults)


class _MemoryRunStore:
    # 轻量 run store。
    #
    # 这些测试只验证 graph.py 的澄清链状态推导，不需要真实 JSONL / Postgres。
    def __init__(self, runs: list[AnalysisRunRecord]):
        self.runs = {run.id: run for run in runs}

    def list_runs_for_thread(self, thread_id: str):
        return sorted(
            [run for run in self.runs.values() if run.thread_id == thread_id],
            key=lambda item: item.updated_at,
            reverse=True,
        )

    def get_run(self, run_id: str):
        return self.runs[run_id]

    def update_run_state(self, run_id: str, **fields):
        run = self.runs[run_id]
        state = run.state.model_copy(update=fields)
        updated = run.model_copy(update={"state": state, "updated_at": now_utc()})
        self.runs[run_id] = updated
        return updated


def _run_record(
    run_id: str,
    *,
    query: str,
    status: str,
    created_at,
    state: AgentStateModel,
) -> AnalysisRunRecord:
    return AnalysisRunRecord(
        id=run_id,
        thread_id="thread_test",
        session_id="session_test",
        user_query=query,
        status=status,
        created_at=created_at,
        updated_at=created_at,
        state=state,
    )


def test_clarification_continuation_traces_back_to_root_task():
    # 连续澄清不是新任务。
    #
    # 第二次、第三次点击候选时，runtime 必须沿 thread run 链回到最初
    # 的复合任务，否则短临/空间分析会退化成孤立地点查询。
    now = now_utc()
    root_option = ClarificationOption(option_id="place:center", label="市民中心（杭州市人民政府/市民中心主楼）", description="市民中心主楼", kind="place")
    final_option = ClarificationOption(option_id="place:gov", label="杭州市人民政府（市民中心主楼）", description="杭州市人民政府", kind="place")
    root_state = AgentStateModel(
        session_id="session_test",
        thread_id="thread_test",
        user_query="基于 36 个短临 NC 产品生成杭州未来三小时预报，并回答接下来天气和市民中心天气。",
        parsed_intent=UserIntent(task_type="meteorological_analysis", place_query="市民中心", data_requirements=["weather"]),
        clarification=ClarificationState(clarification_id="clarification_root", question="请选择市民中心。", options=[root_option]),
    )
    middle_state = AgentStateModel(
        session_id="session_test",
        thread_id="thread_test",
        user_query=root_option.label,
        parsed_intent=UserIntent(task_type="geocode_lookup", place_query=root_option.label),
        clarification=ClarificationState(clarification_id="clarification_middle", question="请选择更精确的位置。", options=[final_option]),
    )
    current_state = AgentStateModel(session_id="session_test", thread_id="thread_test", user_query=final_option.label)
    store = _MemoryRunStore(
        [
            _run_record("run_root", query=root_state.user_query, status="clarification_needed", created_at=now - timedelta(minutes=2), state=root_state),
            _run_record("run_middle", query=middle_state.user_query, status="clarification_needed", created_at=now - timedelta(minutes=1), state=middle_state),
            _run_record("run_current", query=current_state.user_query, status="running", created_at=now, state=current_state),
        ]
    )
    runtime = GeoAgentRuntime(store=store, tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())

    intent, continuation = runtime._build_effective_intent(
        run_id="run_current",
        thread_id="thread_test",
        query=final_option.label,
        latest_uploaded_layer_key=None,
        clarification_option_id="place:gov",
    )

    assert continuation is not None
    assert continuation["parent_query"] == root_state.user_query
    assert continuation["immediate_parent_query"] == root_option.label
    assert intent.task_type == "meteorological_analysis"
    assert intent.place_query == final_option.label


def test_clarification_continuation_prompt_carries_selected_coordinate_ref():
    # 澄清选项命中上一轮 geocode 候选后，要变成当前 run 的 valueRef。
    #
    # 后续 nowcast 工具只能消费 coordinate_ref，不能让模型把经纬度当文本抄写。
    now = now_utc()
    candidate = PlaceSearchCandidate(
        label="杭州市人民政府（市民中心主楼）",
        display_name="杭州市人民政府（市民中心主楼）",
        latitude=30.246,
        longitude=120.210,
        source="geocode_place",
    )
    option = ClarificationOption(option_id="place:gov", label=candidate.label, description="杭州市人民政府", kind="place")
    previous_state = AgentStateModel(
        session_id="session_test",
        thread_id="thread_test",
        user_query="市民中心天气怎么样？",
        parsed_intent=UserIntent(task_type="meteorological_analysis", place_query="市民中心", data_requirements=["weather"]),
        clarification=ClarificationState(clarification_id="clarification_place", question="请选择市民中心。", options=[option]),
        place_resolution=PlaceResolution(status="ambiguous", query="市民中心", provider="geocode", candidates=[candidate]),
    )
    current_state = AgentStateModel(session_id="session_test", thread_id="thread_test", user_query=option.label)
    store = _MemoryRunStore(
        [
            _run_record("run_previous", query=previous_state.user_query, status="clarification_needed", created_at=now - timedelta(minutes=1), state=previous_state),
            _run_record("run_current", query=current_state.user_query, status="running", created_at=now, state=current_state),
        ]
    )
    runtime = GeoAgentRuntime(store=store, tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    _, continuation = runtime._build_effective_intent(
        run_id="run_current",
        thread_id="thread_test",
        query=option.label,
        latest_uploaded_layer_key=None,
        clarification_option_id="place:gov",
    )
    tool_runtime = ToolRuntime(
        context=ToolRuntimeContext(run_id="run_current", thread_id="thread_test", session_id="session_test", latest_uploaded_layer_key=None),
        state=ToolRuntimeState(),
        store=SimpleNamespace(),
    )

    coordinate_ref = runtime._remember_clarification_coordinate_ref(runtime=tool_runtime, run_id="run_current", continuation=continuation)
    prompt = runtime._build_clarification_continuation_prompt(continuation=continuation, current_query=option.label, coordinate_ref=coordinate_ref)

    assert coordinate_ref is not None
    assert coordinate_ref in tool_runtime.state.value_map
    assert store.get_run("run_current").state.tool_value_refs[0].ref_id == coordinate_ref
    assert "市民中心天气怎么样？" in prompt
    assert f"coordinate_ref: {coordinate_ref}" in prompt
    assert "不要再次 request_clarification" in prompt


def test_clarification_continuation_reuses_option_coordinate_ref_payload():
    # request_clarification 选项可能只携带 coordinate_ref。
    #
    # 续跑时要把上一轮 valueRef 装回当前 runtime 黑板，不能重新地理编码。
    now = now_utc()
    existing_ref = ToolValueRef(
        ref_id="value:coordinate_center",
        kind="coordinate",
        label="杭州市国际会议中心（市民中心地标）",
        value={"lat": 30.246, "lng": 120.210, "label": "杭州市国际会议中心（市民中心地标）"},
        source_tool="geocode_place",
    )
    option = ClarificationOption(
        option_id="center",
        label="杭州市国际会议中心（市民中心地标）",
        description="市民中心地标",
        kind="place",
        payload={"coordinate_ref": existing_ref.ref_id},
    )
    previous_state = AgentStateModel(
        session_id="session_test",
        thread_id="thread_test",
        user_query="市民中心天气怎么样？",
        parsed_intent=UserIntent(task_type="meteorological_analysis", place_query="市民中心", data_requirements=["weather"]),
        clarification=ClarificationState(clarification_id="clarification_place", question="请选择市民中心。", options=[option]),
        tool_value_refs=[existing_ref],
    )
    current_state = AgentStateModel(session_id="session_test", thread_id="thread_test", user_query=option.label)
    store = _MemoryRunStore(
        [
            _run_record("run_previous", query=previous_state.user_query, status="clarification_needed", created_at=now - timedelta(minutes=1), state=previous_state),
            _run_record("run_current", query=current_state.user_query, status="running", created_at=now, state=current_state),
        ]
    )
    runtime = GeoAgentRuntime(store=store, tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    _, continuation = runtime._build_effective_intent(
        run_id="run_current",
        thread_id="thread_test",
        query=option.label,
        latest_uploaded_layer_key=None,
        clarification_option_id="center",
    )
    tool_runtime = ToolRuntime(
        context=ToolRuntimeContext(run_id="run_current", thread_id="thread_test", session_id="session_test", latest_uploaded_layer_key=None),
        state=ToolRuntimeState(),
        store=SimpleNamespace(),
    )

    coordinate_ref = runtime._remember_clarification_coordinate_ref(runtime=tool_runtime, run_id="run_current", continuation=continuation)

    assert coordinate_ref == existing_ref.ref_id
    assert tool_runtime.state.value_map[existing_ref.ref_id].label == existing_ref.label
    assert store.get_run("run_current").state.tool_value_refs[0].ref_id == existing_ref.ref_id


def test_clarification_continuation_reuses_generic_value_ref_payload():
    # request_clarification 的通用 payload 会使用 valueRef。
    #
    # 这是前端选项和工具模型共享的结构化字段；选择后必须恢复为当前 run
    # 可执行的 coordinate_ref，而不是让后续工具遇到未知引用。
    now = now_utc()
    existing_ref = ToolValueRef(
        ref_id="value:coordinate_4:73d9d5db64",
        kind="coordinate",
        label="杭州市人民政府",
        value={"lat": 30.2482935, "lng": 120.2056098, "label": "杭州市人民政府"},
        source_tool="geocode_place",
    )
    option = ClarificationOption(
        option_id="place:gov",
        label="市民中心（杭州市人民政府/市民中心主楼）",
        description="市民中心主楼",
        kind="place",
        payload={"valueRef": existing_ref.ref_id},
    )
    previous_state = AgentStateModel(
        session_id="session_test",
        thread_id="thread_test",
        user_query="生成杭州短临预报并回答市民中心天气。",
        parsed_intent=UserIntent(task_type="meteorological_analysis", place_query="市民中心", data_requirements=["weather"]),
        clarification=ClarificationState(clarification_id="clarification_place", question="请选择市民中心。", options=[option]),
        tool_value_refs=[existing_ref],
    )
    current_state = AgentStateModel(session_id="session_test", thread_id="thread_test", user_query=option.label)
    store = _MemoryRunStore(
        [
            _run_record("run_previous", query=previous_state.user_query, status="clarification_needed", created_at=now - timedelta(minutes=1), state=previous_state),
            _run_record("run_current", query=current_state.user_query, status="running", created_at=now, state=current_state),
        ]
    )
    runtime = GeoAgentRuntime(store=store, tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    _, continuation = runtime._build_effective_intent(
        run_id="run_current",
        thread_id="thread_test",
        query=option.label,
        latest_uploaded_layer_key=None,
        clarification_option_id="place:gov",
    )
    tool_runtime = ToolRuntime(
        context=ToolRuntimeContext(run_id="run_current", thread_id="thread_test", session_id="session_test", latest_uploaded_layer_key=None),
        state=ToolRuntimeState(),
        store=SimpleNamespace(),
    )

    coordinate_ref = runtime._remember_clarification_coordinate_ref(runtime=tool_runtime, run_id="run_current", continuation=continuation)

    assert coordinate_ref == existing_ref.ref_id
    assert existing_ref.ref_id in tool_runtime.state.value_map
    assert store.get_run("run_current").state.tool_value_refs[0].ref_id == existing_ref.ref_id


def test_pending_clarification_final_response_preserves_nowcast_outputs():
    # 等待澄清时也不能吞掉已完成的子智能体事实。
    #
    # nowcast 文本来自 forecast_text valueRef；主响应要先回收这些成果，
    # 再提出剩余需要确认的问题。
    forecast_ref = ToolValueRef(
        ref_id="value:forecast:public",
        kind="forecast_text",
        label="短临预报文字",
        value="预计杭州未来三小时持续小雨，22点前后雨量略有增大。",
    )
    qa_ref = ToolValueRef(
        ref_id="value:forecast:qa",
        kind="forecast_text",
        label="短临问答文本",
        value="未来三小时将持续小雨，整体雨势较弱。",
    )
    state = AgentStateModel(
        session_id="session_test",
        user_query="生成短临预报并回答市民中心天气。",
        clarification=ClarificationState(
            clarification_id="clarification_place",
            question="请确认市民中心具体位置。",
            options=[ClarificationOption(option_id="place:gov", label="杭州市人民政府（市民中心主楼）", description="市民中心主楼", kind="place")],
        ),
        tool_results=[
            ToolCall(step_id="step_text", tool="generate_nowcast_forecast_text", status="completed", message="已生成短临预报文字。", value_refs=[forecast_ref]),
            ToolCall(step_id="step_qa", tool="answer_nowcast_question", status="completed", message="未来三小时将持续小雨。", value_refs=[qa_ref]),
        ],
    )

    final_response = GeoAgentRuntime._build_clarification_final_response(state)

    assert "预计杭州未来三小时持续小雨" in final_response.summary
    assert "未来三小时将持续小雨" in final_response.summary
    assert "还需要你确认：请确认市民中心具体位置。" in final_response.summary
    assert final_response.next_actions == ["杭州市人民政府（市民中心主楼）"]


def test_nowcast_tool_observation_exposes_deliverable_texts():
    # 工具结果像 Claude Code 的 tool_result 一样回灌可交付文本。
    #
    # forecast_text 的真实内容必须进入 observation，让主智能体能自己写最终回答。
    ref = ToolValueRef(
        ref_id="value:forecast:public",
        kind="forecast_text",
        label="短临预报文字",
        value="预计杭州未来三小时持续小雨，22点前后雨量略有增大。",
    )

    observation = graph_module._format_tool_observation(
        tool_name="generate_nowcast_forecast_text",
        result=SimpleNamespace(payload={"forecastTextRef": ref.ref_id}, value_refs=[ref], artifact=None, feature_count=None),
    )
    payload = json.loads(observation)

    assert payload["valueRefs"][0]["refId"] == ref.ref_id
    assert payload["deliverableTexts"][0]["text"] == ref.value


def test_final_response_must_include_delivered_nowcast_value_refs():
    # 最终回答必须交付子智能体已产出的短临文本。
    #
    # 即使 tool call 记录仍停在 running，forecast_text valueRef 已经是
    # 可审计工具事实，主响应不能只写“已生成”；缺失时进入 repair。
    forecast_ref = ToolValueRef(
        ref_id="value:forecast:public",
        kind="forecast_text",
        label="短临预报文字",
        value="预计杭州未来三小时持续小雨，22点前后雨量略有增大。",
    )
    qa_ref = ToolValueRef(
        ref_id="value:forecast:qa",
        kind="forecast_text",
        label="短临问答文本",
        value="市民中心未来三小时不会下雨，您可以放心出门。",
    )
    state = AgentStateModel(
        session_id="session_test",
        user_query="生成杭州短临预报并回答市民中心天气。",
        tool_value_refs=[forecast_ref, qa_ref],
        tool_results=[
            ToolCall(step_id="step_text", tool="generate_nowcast_forecast_text", status="running", message="正在执行 generate_nowcast_forecast_text"),
            ToolCall(step_id="step_qa", tool="answer_nowcast_question", status="running", message="正在执行 answer_nowcast_question"),
        ],
    )
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())

    incomplete = runtime._coerce_sdk_final_response(
        AgentFinalResponse(summary="已完成杭州短临降水分析与预报文字生成。"),
        state,
    )
    complete = runtime._coerce_sdk_final_response(
        AgentFinalResponse(summary=f"{forecast_ref.value}\n{qa_ref.value}"),
        state,
    )

    assert incomplete is None
    assert complete is not None
    assert "预计杭州未来三小时持续小雨" in complete.summary
    assert "市民中心未来三小时不会下雨" in complete.summary


def test_nowcast_plain_text_final_response_projects_only_when_tool_facts_are_included():
    # 短临自然语言交付投影。
    #
    # SDK 已经输出完整中文总结但没形成 output_type 对象时，只有当前 run
    # 已有 forecast_text 工具事实且文本包含这些事实，才能投影为 finalResponse。
    forecast_ref = ToolValueRef(
        ref_id="value:forecast:public",
        kind="forecast_text",
        label="短临预报文字",
        value="预计杭州未来三小时持续小雨，22点前后雨量略有增强。",
    )
    state = AgentStateModel(
        session_id="session_test",
        user_query="生成杭州短临预报。",
        tool_value_refs=[forecast_ref],
    )
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())

    accepted = runtime._coerce_sdk_final_response(
        "预计杭州未来三小时持续小雨，22点前后雨量略有增强。市民外出请携带雨具。",
        state,
    )
    rejected = runtime._coerce_sdk_final_response(
        "已完成杭州短临降水分析。",
        state,
    )

    assert accepted is not None
    assert "22点前后雨量略有增强" in accepted.summary
    assert rejected is None


def test_nowcast_city_and_place_request_requires_place_analysis_and_answer():
    # 短临双问题覆盖边界。
    #
    # 用户同时问“接下来”和“市民中心”时，不能只做区域分析和全市问答。
    state = AgentStateModel(
        session_id="session_test",
        user_query="基于36个短临NC产品生成杭州预报文字，并回答：接下来天气怎么样？市民中心天气怎么样？",
        tool_results=[
            ToolCall(step_id="sequence", tool="create_nowcast_sequence", status="completed", message="已创建短临序列。"),
            ToolCall(step_id="area", tool="analyze_nowcast_precipitation", args={"sequence_ref": "value:sequence", "area_ref": "hangzhou_area"}, status="completed", message="已完成区域短临分析。"),
            ToolCall(step_id="answer", tool="answer_nowcast_question", args={"nowcast_analysis_ref": "value:analysis", "question": "接下来天气怎么样？"}, status="completed", message="未来三小时有小雨。"),
            ToolCall(step_id="text", tool="generate_nowcast_forecast_text", args={"nowcast_analysis_ref": "value:analysis"}, status="completed", message="已生成短临预报文字。"),
        ],
    )

    with pytest.raises(RuntimeError, match="市民中心"):
        GeoAgentRuntime._ensure_nowcast_request_coverage(state)

    covered = state.model_copy(
        update={
            "tool_results": [
                *state.tool_results,
                ToolCall(step_id="geocode", tool="geocode_place", args={"query": "杭州市民中心"}, status="completed", message="已解析地点。"),
                ToolCall(step_id="point", tool="analyze_nowcast_precipitation", args={"sequence_ref": "value:sequence", "area_ref": "hangzhou_area", "coordinate_ref": "value:coordinate_center"}, status="completed", message="已完成地点短临分析。"),
                ToolCall(step_id="place_answer", tool="answer_nowcast_question", args={"nowcast_analysis_ref": "value:point_analysis", "question": "市民中心天气怎么样？"}, status="completed", message="市民中心未来三小时有小雨。"),
            ]
        }
    )
    GeoAgentRuntime._ensure_nowcast_request_coverage(covered)


def test_clarification_interrupt_is_sdk_exception_boundary():
    # request_clarification 中断必须作为 Agents SDK 异常原样穿透。
    #
    # SDK 的工具执行层只包装普通 Exception；继承 AgentsException 后，
    # 运行时可以用明确的 except 分支把它转成等待用户确认。
    agents_exception = pytest.importorskip("agents.exceptions").AgentsException

    assert issubclass(graph_module._ClarificationRequested, agents_exception)


def test_successful_completion_closes_stale_todos():
    # 成功交付边界要收口遗留 Todo。
    #
    # 模型可能完成所有工具后直接输出最终答复，不再调用 todo_write；
    # UI 不应因此停在 pending/running 的旧进度上。
    state = AgentStateModel(
        session_id="session_test",
        user_query="生成短临预报。",
        todos=[
            TodoItem(todo_id="todo_sequence", title="创建短临序列", status="running", activeForm="正在创建短临序列"),
            TodoItem(todo_id="todo_text", title="生成预报文字", status="pending", activeForm="正在生成预报文字"),
        ],
        tool_results=[
            ToolCall(step_id="step_sequence", tool="create_nowcast_sequence", status="completed", message="已创建短临序列，共 36 个时次。"),
            ToolCall(step_id="step_text", tool="generate_nowcast_forecast_text", status="completed", message="已生成短临预报文字。"),
        ],
        final_response=AgentFinalResponse(summary="短临预报已生成。"),
    )

    completed = GeoAgentRuntime._complete_todos_for_success(state)

    assert completed is not None
    assert [item.status for item in completed] == ["completed", "completed"]


def test_live_supervisor_only_supports_openai_compatible_sdk_path():
    # live supervisor 能力只表示当前 OpenAI Agents SDK 主路径可运行，
    # 不能因为其它 provider 配了 chat adapter 就误报支持。
    registry = ModelAdapterRegistry(_registry_settings(default_model_provider="anthropic"))

    assert registry.supports_live_supervisor("openai_compatible") is True
    assert registry.supports_live_supervisor("anthropic") is False
    assert registry.supports_live_supervisor("gemini") is False
    assert registry.supports_live_supervisor("ollama") is False


def test_sdk_final_response_rejects_mechanical_success_text():
    # SDK 结构化输出如果只是机械成功句，要被视作无效；
    # 平台不能再自己拼一段“分析已完成”当作成功交付。
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    state = AgentStateModel(session_id="session_test", user_query="查询巴黎医院")

    assert runtime._coerce_sdk_final_response(AgentFinalResponse(summary="分析已完成。"), state) is None

    accepted = runtime._coerce_sdk_final_response(
        AgentFinalResponse(summary="查到了巴黎相关医院结果，已经同步到地图图层。", limitations=[], next_actions=["查看地图"]),
        state,
    )

    assert accepted is not None
    assert accepted.summary == "查到了巴黎相关医院结果，已经同步到地图图层。"


def test_output_guardrail_tripwire_extracts_business_error():
    # guardrail tripwire 是结果边界失败。
    #
    # 用户可见错误必须来自 guardrail output_info，而不是 SDK 默认异常文案。
    if GuardrailFunctionOutput is None or OutputGuardrailResult is None or OutputGuardrailTripwireTriggered is None:
        pytest.skip("OpenAI Agents SDK is not installed in this environment.")
    guardrail_output = GuardrailFunctionOutput(
        output_info={"error": "实时智能体没有产出可交付结果。"},
        tripwire_triggered=True,
    )
    exc = OutputGuardrailTripwireTriggered(
        OutputGuardrailResult(
            guardrail=object(),
            agent_output="分析已完成。",
            agent=object(),
            output=guardrail_output,
        )
    )

    assert "triggered tripwire" in str(exc)
    assert GeoAgentRuntime._extract_output_guardrail_error(exc) == "实时智能体没有产出可交付结果。"
    assert GeoAgentRuntime._extract_output_guardrail_error(RuntimeError("network down")) is None


def test_deepseek_openai_compatible_uses_json_object_contract():
    # DeepSeek 当前会拒绝 Agents SDK output_type 触发的 json_schema；
    # 运行时仍走 SDK agent loop，但最终交付使用 DeepSeek 支持的 json_object。
    registry = ModelAdapterRegistry(
        _registry_settings(
            openai_base_url="https://api.deepseek.com/v1",
            openai_model="deepseek-v4-pro",
        )
    )
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=registry)

    assert runtime._supports_sdk_response_format("openai_compatible", "deepseek-v4-pro") is False
    assert runtime._supports_json_object_response_format("openai_compatible", "deepseek-v4-pro") is True
    assert registry.agents_sdk_capabilities("openai_compatible", "deepseek-v4-pro").final_output_contract == "json_object"
    assert "agents_sdk_json_object_output" in registry.descriptors()[0].capabilities


def test_openai_endpoint_keeps_sdk_response_format():
    # 真正支持 response_format 的 OpenAI endpoint 继续使用 SDK output_type，
    # 不降低 SDK 原语覆盖面。
    registry = ModelAdapterRegistry(
        _registry_settings(
            openai_base_url="https://api.openai.com/v1",
            openai_model="gpt-4.1-mini",
        )
    )
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=registry)

    assert runtime._supports_sdk_response_format("openai_compatible", "gpt-4.1-mini") is True
    assert runtime._supports_json_object_response_format("openai_compatible", "gpt-4.1-mini") is False
    assert registry.agents_sdk_capabilities("openai_compatible", "gpt-4.1-mini").final_output_contract == "sdk_structured"
    assert "agents_sdk_structured_output" in registry.descriptors()[0].capabilities


def test_openai_structured_output_detection_uses_exact_hostname():
    # OpenAI structured output 能力只认官方 hostname；
    # 不能因为自定义兼容地址里包含 api.openai.com 字样就误开 json_schema。
    registry = ModelAdapterRegistry(
        _registry_settings(
            openai_base_url="https://api.openai.com.example.test/v1",
            openai_model="gpt-4.1-mini",
        )
    )

    assert registry.supports_agents_sdk_structured_output("openai_compatible", "gpt-4.1-mini") is False
    assert registry.agents_sdk_capabilities("openai_compatible", "gpt-4.1-mini").final_output_contract == "plain_text"


def test_live_supervisor_reports_missing_provider_configuration():
    # 配置缺失必须在平台边界直接报错；
    # 不能等到 SDK HTTP 请求阶段才变成模糊连接或鉴权异常。
    if graph_module.OpenAIChatCompletionsModel is None:
        pytest.skip("OpenAI Agents SDK is not installed in this environment.")
    registry = ModelAdapterRegistry(_registry_settings(openai_api_key=None))
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=registry)

    with pytest.raises(RuntimeError, match="尚未配置"):
        runtime._build_oai_model("openai_compatible", None)


def test_live_supervisor_rejects_non_sdk_provider_before_http_call():
    # LangChain/其它 chat adapter 不是当前主路径；
    # provider 不支持 SDK live supervisor 时要直接拒绝。
    if graph_module.OpenAIChatCompletionsModel is None:
        pytest.skip("OpenAI Agents SDK is not installed in this environment.")
    registry = ModelAdapterRegistry(_registry_settings(default_model_provider="anthropic"))
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=registry)

    with pytest.raises(RuntimeError, match="不能接入 OpenAI Agents SDK live supervisor"):
        runtime._build_oai_model("anthropic", None)


def test_deepseek_json_object_model_settings_are_explicit():
    # json_object 通过 SDK ModelSettings.extra_body 显式进入 chat.completions；
    # 这不是失败后的文本猜测。
    settings = GeoAgentRuntime._build_json_object_model_settings()

    assert settings is not None
    assert settings.extra_body == {"response_format": {"type": "json_object"}}
    assert settings.parallel_tool_calls is False


def test_all_sdk_model_settings_disable_parallel_tools():
    # Agents SDK 仍负责工具循环；平台只要求顺序工具调用，
    # 这样 run state、tool result 和 Chat Completions 历史不会并发错位。
    structured_settings = GeoAgentRuntime._build_oai_model_settings("sdk_structured")
    json_settings = GeoAgentRuntime._build_oai_model_settings("json_object")
    plain_settings = GeoAgentRuntime._build_oai_model_settings("plain_text")

    assert structured_settings is not None
    assert json_settings is not None
    assert plain_settings is not None
    assert structured_settings.parallel_tool_calls is False
    assert json_settings.parallel_tool_calls is False
    assert plain_settings.parallel_tool_calls is False
    assert json_settings.extra_body == {"response_format": {"type": "json_object"}}


def test_final_response_repair_disables_tool_choice_only_for_delivery_format_errors():
    # 最终交付修正只写答案。
    #
    # 如果失败原因只是结构化最终答复不合格，下一轮不应再调用上下文搜索
    # 或业务工具；普通业务边界修正仍保留原 agent。
    if graph_module.Agent is None or graph_module.ModelSettings is None:
        pytest.skip("OpenAI Agents SDK is not installed in this environment.")
    supervisor = graph_module.Agent(
        name="test_supervisor",
        tools=[],
        model_settings=graph_module.ModelSettings(parallel_tool_calls=False),
    )

    delivery_repair = GeoAgentRuntime._build_delivery_repair_supervisor(
        supervisor,
        validation_error=RuntimeError("OpenAI Agents SDK 没有产出合格的结构化最终答复。"),
    )
    business_repair = GeoAgentRuntime._build_delivery_repair_supervisor(
        supervisor,
        validation_error=RuntimeError("实时智能体没有产出可交付结果。"),
    )

    assert delivery_repair is not supervisor
    assert delivery_repair.model_settings.tool_choice == "none"
    assert delivery_repair.model_settings.parallel_tool_calls is False
    assert supervisor.model_settings.tool_choice is None
    assert business_repair is supervisor


def test_chat_completions_streaming_tool_output_order_is_normalized():
    # DeepSeek 等严格 Chat Completions provider 要求 assistant.tool_calls 后面紧跟 tool 消息。
    #
    # SDK streaming 可能把同一轮输出排成 function_call -> message；
    # 平台模型包装层必须先修正为 message -> function_call，后续 SDK 回放才能合并成
    # 一个合法的 assistant(content + tool_calls) 消息。
    if ResponseFunctionToolCall is None or ResponseOutputMessage is None or ResponseOutputText is None:
        pytest.skip("OpenAI SDK response item classes are not installed.")
    tool_call = ResponseFunctionToolCall(
        id="fake_response",
        call_id="call_geocode",
        arguments='{"query":"北京"}',
        name="geocode_place",
        type="function_call",
    )
    message = ResponseOutputMessage(
        id="fake_response",
        content=[
            ResponseOutputText(
                text="先查一下北京坐标。",
                type="output_text",
                annotations=[],
                logprobs=[],
            )
        ],
        role="assistant",
        status="completed",
        type="message",
    )

    normalized = graph_module._normalize_chat_completions_tool_output_order([tool_call, message])

    assert normalized == [message, tool_call]


def test_sdk_function_tools_raise_on_timeout_instead_of_returning_fake_result():
    # SDK 工具超时是硬失败边界；
    # 不能把 timeout 包装成“工具结果”继续让模型误判为可用事实。
    if graph_module.FunctionTool is None:
        pytest.skip("OpenAI Agents SDK is not installed in this environment.")

    async def dummy_handler(_args, _runtime):
        return None

    tool_registry = ToolRegistry()
    tool_registry.register(
        "dummy_tool",
        dummy_handler,
        metadata=ToolMetadata("测试工具", "用于验证 SDK tool timeout 边界。", "test"),
    )
    runtime = GeoAgentRuntime(
        store=SimpleNamespace(get_runtime_config=build_default_runtime_config),
        tool_registry=tool_registry,
        model_registry=SimpleNamespace(),
    )

    tool = runtime._build_oai_tool("dummy_tool", SimpleNamespace(), "run_test", None)

    assert tool.timeout_seconds == runtime._SDK_TOOL_TIMEOUT_SECONDS
    assert tool.timeout_behavior == "raise_exception"


def test_live_subagent_prompt_exposes_exact_tool_name_boundary():
    # 子智能体工具边界。
    #
    # 子智能体只能调用 runtime config 明确分配的函数名；不能把中文工具标题
    # 或任务意图翻译成不存在的工具名，否则 SDK 会在未知工具处硬失败。
    config = build_default_runtime_config()
    nowcast_agent = next(item for item in config.sub_agents if item.agent_id == "hangzhou_nowcast_analyst")
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())

    prompt = runtime._build_live_subagent_prompt(nowcast_agent)

    assert "## 专属工具清单" in prompt
    assert "- create_nowcast_sequence" in prompt
    assert "- answer_nowcast_question" in prompt
    assert "函数名必须逐字匹配" in prompt
    assert "不要根据中文标题" in prompt
    assert "进度清单由 supervisor 统一维护" in prompt
    assert "todo_" not in prompt
    assert "todo_write" not in nowcast_agent.tools


def test_text_json_final_response_is_strictly_parsed():
    # json_object contract 必须返回完整 JSON 对象；
    # 普通自然语言不会被截取片段当作结构化成功。
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    state = AgentStateModel(session_id="session_test", user_query="你是谁")

    accepted = runtime._coerce_sdk_final_response(
        '{"summary":"我是地理智能平台里的 Agent，会通过工具完成 GIS 查询和分析。","limitations":[],"nextActions":["继续提问"]}',
        state,
    )

    assert accepted is not None
    assert accepted.summary.startswith("我是地理智能平台里的 Agent")
    assert runtime._coerce_sdk_final_response("我是地理智能平台里的 Agent。", state) is None

    mixed = runtime._coerce_sdk_final_response(
        '我是地理智能平台里的 Agent。\n\n```json\n{"summary":"我是地理智能平台里的 Agent。","limitations":[],"nextActions":[]}\n```',
        state,
    )
    assert mixed is not None
    assert mixed.summary == "我是地理智能平台里的 Agent。"

    ambiguous = runtime._coerce_sdk_final_response(
        '```json\n{"summary":"第一个","limitations":[],"nextActions":[]}\n```\n```json\n{"summary":"第二个","limitations":[],"nextActions":[]}\n```',
        state,
    )
    assert ambiguous is None


def test_plain_sdk_text_is_allowed_only_after_delivery_boundary_passes():
    # 对不支持 response_format 的 provider，普通问答可以使用 SDK 原文交付；
    # 但必须先由状态边界证明这是合法文本交付，不能裸文本冒充空间分析成果。
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    pending_state = AgentStateModel(session_id="session_test", user_query="你是谁")
    delivered_state = AgentStateModel(session_id="session_test", user_query="你是谁", text_only_delivery=True)

    assert runtime._coerce_sdk_final_response("我是地理智能平台里的 Agent。", pending_state) is None

    accepted = runtime._coerce_sdk_final_response("我是地理智能平台里的 Agent。", delivered_state, allow_plain_text=True)

    assert accepted is not None
    assert accepted.summary == "我是地理智能平台里的 Agent。"


def test_map_navigation_requires_real_place_resolution():
    # 地图跳转任务必须有真实地点解析状态。
    #
    # 只返回一段坐标文本不能驱动前端地图视图，也不能作为 Agent 成功边界。
    runtime = GeoAgentRuntime(store=SimpleNamespace(), tool_registry=SimpleNamespace(), model_registry=SimpleNamespace())
    intent = UserIntent(task_type="map_navigation", place_query="北京", anchor_type="poi")
    state = AgentStateModel(session_id="session_test", user_query="跳转到北京")
    artifact_only_state = state.model_copy(
        update={
            "artifacts": [
                ArtifactRef(
                    artifact_id="artifact_boundary",
                    run_id="run_test",
                    artifact_type="geojson",
                    name="北京边界",
                    uri="runtime://artifact_boundary.geojson",
                )
            ]
        }
    )

    with pytest.raises(RuntimeError, match="geocode_place"):
        runtime._ensure_live_result_is_actionable(state, intent, "北京坐标约为 116.4, 39.9。")
    with pytest.raises(RuntimeError, match="geocode_place"):
        runtime._ensure_live_result_is_actionable(artifact_only_state, intent, "已加载北京边界。")

    resolved_state = state.model_copy(
        update={
            "place_resolution": PlaceResolution(
                status="resolved",
                query="北京",
                provider="geocode",
                selected=PlaceSearchCandidate(label="北京", latitude=39.9042, longitude=116.4074),
            )
        }
    )
    runtime._ensure_live_result_is_actionable(resolved_state, intent, "已定位北京。")
