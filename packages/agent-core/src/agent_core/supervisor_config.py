# +-------------------------------------------------------------------------
#
#   地理智能平台 - Supervisor 默认配置
#
#   文件:       supervisor_config.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
# 模块职责
#
# 定义运行时默认 supervisor、subagent、UI 与上下文窗口配置，并负责配置归一化合并。
from __future__ import annotations

from typing import Any

from shared_types.schemas import (
    AgentRuntimeConfig,
    RuntimeCatalogConfig,
    RuntimeContextConfig,
    RuntimeGeosearchConfig,
    RuntimePlanningConfig,
    RuntimePoiConfig,
    RuntimeSubAgentConfig,
    RuntimeUiConfig,
    SupervisorRuntimeConfig,
)


LOOP_PHASES = {
    "observe": "observe",
    "decide": "decide",
    "act": "act",
    "observe_result": "observe_result",
    "approval": "approval",
    "deliver": "deliver",
    "failed": "failed",
}


def build_default_runtime_config() -> AgentRuntimeConfig:
    return AgentRuntimeConfig(
        default_publish_project_key="geo-agent-workspace",
        loop_trace_limit=80,
        supervisor=SupervisorRuntimeConfig(
            name="geo_agent_supervisor",
            system_prompt=(
                "你是一个中文地理空间智能助手，擅长理解用户的空间分析需求。"
                "收到问题后，先判断意图，再决定自己直接调用工具还是分派给子智能体协作。"
                "优先使用已经就绪的 GIS 工具，基于真实数据给出答案，不凭空构造结果。"
                "和用户交流时像一位耐心的分析师，用清晰的中文说明你的判断和下一步。"
            ),
            approval_interrupt_tools=["publish_to_qgis_project"],
        ),
        sub_agents=[
            RuntimeSubAgentConfig(
                agent_id="spatial_analyst",
                name="Spatial Analyst",
                role="空间分析",
                summary="负责边界、图层与空间分析。",
                system_prompt=(
                    "你是空间分析子智能体，负责执行具体的 GIS 计算任务。"
                    "你的工具箱里有边界加载、图层加载、缓冲区分析、相交分析、裁剪、点面判断、距离查询和结果导出。"
                    "收到任务后直接动手执行，完成时用简洁的中文说明你做了什么、结果是什么。"
                ),
                tools=[
                    "list_available_layers",
                    "geocode_place",
                    "reverse_geocode",
                    "load_boundary",
                    "load_layer",
                    "search_external_pois",
                    "buffer",
                    "intersect",
                    "clip",
                    "spatial_join",
                    "point_in_polygon",
                    "distance_query",
                    "publish_result_geojson",
                ],
            ),
            RuntimeSubAgentConfig(
                agent_id="qgis_operator",
                name="QGIS Operator",
                role="QGIS 执行",
                summary="负责 QGIS Processing / model 执行。",
                system_prompt="你是 QGIS 执行子智能体，负责运行 QGIS 处理算法和模型。收到调用指令后执行，完成时用中文简短汇报结果。",
                tools=["run_qgis_model", "run_qgis_processing_algorithm"],
            ),
            RuntimeSubAgentConfig(
                agent_id="publisher",
                name="Publisher",
                role="发布交付",
                summary="负责服务发布与交付整理。",
                system_prompt="你是发布交付子智能体，在用户希望把分析结果发布为在线地图服务时介入，将 GeoJSON 成果推送到 QGIS Server。",
                tools=["publish_to_qgis_project"],
            ),
        ],
        ui=RuntimeUiConfig(
            transcript_max_entries=40,
            show_internal_reasoning_labels=True,
            event_grouping_window_ms=1500,
        ),
        catalog=RuntimeCatalogConfig(
            allow_empty_catalog=True,
            admin_enabled=True,
        ),
        planning=RuntimePlanningConfig(
            max_plan_repair_rounds=2,
            allow_text_only_delivery=True,
            external_source_priority=["catalog", "external_poi", "geosearch"],
        ),
        context=RuntimeContextConfig(
            memory_file_paths=["/AGENTS.md", "/THREAD_CONTEXT.md"],
            history_run_limit=4,
            event_window=24,
            tool_call_window=8,
            artifact_window=6,
            warning_window=6,
        ),
        geosearch=RuntimeGeosearchConfig(
            provider="nominatim",
            enabled=True,
            base_url="https://nominatim.openstreetmap.org",
            user_agent="geo-agent-platform/0.1",
            timeout_ms=8000,
            max_candidates=5,
        ),
        external_poi=RuntimePoiConfig(
            provider="overpass",
            enabled=True,
            base_url="https://overpass-api.de/api/interpreter",
            user_agent="geo-agent-platform/0.1",
            timeout_ms=8000,
            max_results=200,
        ),
    )


def normalize_runtime_config(payload: AgentRuntimeConfig | dict[str, Any] | None) -> AgentRuntimeConfig:
    defaults = build_default_runtime_config().model_dump(mode="json", by_alias=True)
    if payload is None:
        return AgentRuntimeConfig.model_validate(defaults)
    raw = payload.model_dump(mode="json", by_alias=True) if isinstance(payload, AgentRuntimeConfig) else dict(payload)
    merged = _merge_runtime_config(defaults, raw)
    return AgentRuntimeConfig.model_validate(merged)


def _merge_runtime_config(defaults: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = _deep_merge(defaults, {key: value for key, value in override.items() if key != "subAgents"})
    default_sub_agents = {
        str(item.get("agentId")): item
        for item in defaults.get("subAgents", [])
        if isinstance(item, dict) and item.get("agentId")
    }
    override_sub_agents = override.get("subAgents")
    if not isinstance(override_sub_agents, list):
        return merged
    merged_sub_agents: list[dict[str, Any]] = []
    for candidate in override_sub_agents:
        if not isinstance(candidate, dict):
            continue
        agent_id = candidate.get("agentId")
        base = default_sub_agents.pop(str(agent_id), {}) if agent_id else {}
        merged_sub_agents.append(_deep_merge(base, candidate))
    merged_sub_agents.extend(default_sub_agents.values())
    merged["subAgents"] = merged_sub_agents
    return merged


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
            continue
        merged[key] = value
    return merged
