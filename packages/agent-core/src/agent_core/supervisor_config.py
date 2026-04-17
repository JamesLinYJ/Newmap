from __future__ import annotations

from typing import Any

from shared_types.schemas import AgentRuntimeConfig, RuntimeContextConfig, RuntimeSubAgentConfig, RuntimeUiConfig, SupervisorRuntimeConfig


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
                "你是中文 GIS Deep Agent supervisor。"
                "请先理解任务、再拆分待办、必要时调用 task() 委派给合适子智能体。"
                "优先复用已有 GIS 工具，不要编造图层、SQL 或 shell 步骤。"
                "所有最终输出都要用中文。"
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
                    "你是空间分析子智能体。"
                    "优先使用 load_boundary、load_layer、buffer、intersect、clip、point_in_polygon、distance_query、publish_result_geojson 完成任务，并使用中文总结。"
                ),
                tools=[
                    "list_available_layers",
                    "geocode_place",
                    "reverse_geocode",
                    "load_boundary",
                    "load_layer",
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
                system_prompt="你是 QGIS 子智能体。只在需要调用 QGIS 算法或模型时介入，并用中文简要说明执行结果。",
                tools=["run_qgis_model", "run_qgis_processing_algorithm"],
            ),
            RuntimeSubAgentConfig(
                agent_id="publisher",
                name="Publisher",
                role="发布交付",
                summary="负责服务发布与交付整理。",
                system_prompt="你是发布子智能体。只在用户明确要求发布、分享或服务交付时使用 publish_to_qgis_project。",
                tools=["publish_to_qgis_project"],
            ),
        ],
        ui=RuntimeUiConfig(
            transcript_max_entries=40,
            show_internal_reasoning_labels=True,
            event_grouping_window_ms=1500,
        ),
        context=RuntimeContextConfig(
            memory_file_paths=["/AGENTS.md", "/THREAD_CONTEXT.md"],
            history_run_limit=4,
            event_window=24,
            tool_call_window=8,
            artifact_window=6,
            warning_window=6,
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
