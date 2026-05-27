# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象工具注册测试
#
#   文件:       test_weather_tool_registration.py
#
#   日期:       2026年05月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定气象工具在 registry、工具目录描述和默认 runtime config
# 三个入口都可见，避免功能写完但 Agent/调试页不可调用。

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_core.supervisor_config import build_default_runtime_config
from api_app.tool_catalog import build_registry_tool_descriptors
from tool_registry import ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore, build_default_registry


def test_weather_tools_are_registered_in_registry_and_catalog_descriptors() -> None:
    # 工具注册契约。
    #
    # registry 是 Agent 执行事实源，catalog descriptor 是调试页和工具表单事实源；
    # 两边都要暴露完整气象工具集合。
    registry = build_default_registry()
    expected = {
        "create_stat_chart",
        "list_meteorological_datasets",
        "inspect_meteorological_dataset",
        "interpret_meteorological_dataset",
        "render_meteorological_raster",
        "meteorological_stats",
        "meteorological_threshold_area",
        "meteorological_contours",
        "generate_meteorological_report",
        "create_nowcast_sequence",
        "inspect_nowcast_sequence",
        "analyze_nowcast_precipitation",
        "answer_nowcast_question",
        "generate_nowcast_forecast_text",
        "render_nowcast_raster",
    }

    assert expected.issubset(set(registry.list_tools()))

    descriptors = build_registry_tool_descriptors(registry, {"tools": {}})
    descriptor_by_name = {item.name: item for item in descriptors}

    assert expected.issubset(set(descriptor_by_name))
    assert descriptor_by_name["meteorological_threshold_area"].group == "meteorology"
    assert descriptor_by_name["meteorological_threshold_area"].tool_kind == "registry"

    params = {item.key: item for item in descriptor_by_name["meteorological_threshold_area"].parameters}
    assert params["dataset_id"].required is True
    assert params["threshold"].data_type == "number"
    assert params["threshold"].required is False
    assert params["threshold_ref"].data_type == "string"
    assert params["time_index"].data_type == "number"
    assert params["level_index_ref"].data_type == "string"
    assert params["level_index"].data_type == "number"
    assert params["bbox_ref"].data_type == "string"

    render_params = {item.key: item for item in descriptor_by_name["render_meteorological_raster"].parameters}
    assert render_params["map_candidate_ref"].data_type == "string"
    assert render_params["dataset_id"].required is False

    interpret_params = {item.key: item for item in descriptor_by_name["interpret_meteorological_dataset"].parameters}
    assert interpret_params["dataset_id"].required is False
    assert interpret_params["dataset_ids"].data_type == "json"
    assert interpret_params["variable_refs"].data_type == "json"

    report_params = {item.key: item for item in descriptor_by_name["generate_meteorological_report"].parameters}
    assert report_params["dataset_id"].required is True
    assert report_params["interpretation_ref"].required is True
    assert report_params["interpretation_ref"].data_type == "string"

    chart_params = {item.key: item for item in descriptor_by_name["create_stat_chart"].parameters}
    assert descriptor_by_name["create_stat_chart"].group == "visualization"
    assert chart_params["data"].data_type == "json"
    assert chart_params["width"].data_type == "number"
    assert chart_params["height"].data_type == "number"

    nowcast_params = {item.key: item for item in descriptor_by_name["analyze_nowcast_precipitation"].parameters}
    assert descriptor_by_name["analyze_nowcast_precipitation"].group == "meteorology"
    assert nowcast_params["sequence_ref"].required is True
    assert nowcast_params["coordinate_ref"].data_type == "string"
    assert nowcast_params["bbox_ref"].data_type == "string"


def test_default_runtime_config_contains_weather_subagent() -> None:
    # 子智能体注册契约。
    #
    # live supervisor 的 handoff 配置必须能把气象任务分配到拥有气象工具的子智能体。
    config = build_default_runtime_config()
    weather_agent = next(item for item in config.sub_agents if item.agent_id == "weather_analyst")

    assert "render_meteorological_raster" in weather_agent.tools
    assert "interpret_meteorological_dataset" in weather_agent.tools
    assert "meteorological_stats" in weather_agent.tools
    assert "generate_meteorological_report" in weather_agent.tools
    assert weather_agent.name == "Meteorological Analyst"
    assert weather_agent.role == "气象分析"

    nowcast_agent = next(item for item in config.sub_agents if item.agent_id == "hangzhou_nowcast_analyst")
    assert "create_nowcast_sequence" in nowcast_agent.tools
    assert "analyze_nowcast_precipitation" in nowcast_agent.tools
    assert "answer_nowcast_question" in nowcast_agent.tools
    assert nowcast_agent.role == "短临降水预报"
    assert config.nowcast.default_city_name == "杭州市"


@pytest.mark.asyncio
async def test_meteorological_dataset_listing_is_thread_scoped() -> None:
    # 数据边界回归。
    #
    # Agent 工具只能看到当前 thread 可用的气象数据集，不能把同一 session
    # 下其它线程上传的数据悄悄暴露进 prompt 和工具结果。
    registry = build_default_registry()
    platform_store = _FakeWeatherStore()
    runtime = ToolRuntime(
        context=ToolRuntimeContext(
            run_id="run_test",
            thread_id="thread_current",
            session_id="session_test",
            latest_uploaded_layer_key=None,
        ),
        state=ToolRuntimeState(),
        store=ToolRuntimeStore(
            platform_store=platform_store,
            layer_repository=SimpleNamespace(),
            artifact_export_store=SimpleNamespace(),
            spatial_service=SimpleNamespace(),
            runtime_root=SimpleNamespace(),
            weather_service=SimpleNamespace(),
        ),
    )

    result = await registry.execute("list_meteorological_datasets", {}, runtime)

    assert result.feature_count == 0
    assert platform_store.calls == [{"session_id": "session_test", "thread_id": "thread_current"}]


class _FakeWeatherStore:
    def __init__(self):
        self.calls: list[dict[str, str | None]] = []

    def list_weather_datasets(self, *, session_id: str | None = None, thread_id: str | None = None):
        self.calls.append({"session_id": session_id, "thread_id": thread_id})
        return []
