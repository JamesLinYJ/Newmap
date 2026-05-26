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

from types import SimpleNamespace

import pytest

import agent_core.graph as graph_module
from agent_core import GeoAgentRuntime
from agent_core.supervisor_config import build_default_runtime_config
from model_adapters import ModelAdapterRegistry, RegistrySettings
from shared_types.schemas import AgentFinalResponse, AgentStateModel, ArtifactRef, PlaceResolution, PlaceSearchCandidate, UserIntent
from tool_registry import ToolMetadata, ToolRegistry

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
