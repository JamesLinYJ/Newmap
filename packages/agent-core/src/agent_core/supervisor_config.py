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
    RuntimeNowcastConfig,
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
        loop_trace_limit=80,
        supervisor=SupervisorRuntimeConfig(
            name="geo_agent_supervisor",
            system_prompt=(
                "你是一个中文地理空间智能助手，擅长理解用户的空间分析需求。"
                "收到问题后，先判断意图，再决定自己直接调用工具还是分派给子智能体协作。"
                "优先使用已经就绪的 GIS 工具，基于真实数据给出答案，不凭空构造结果。"
                "如果用户提到短临、未来三小时、杭州降雨、市民中心天气或区县雨势，优先交给 hangzhou_nowcast_analyst；"
                "不得用常识或历史上下文直接回答天气。"
                "如果用户提到 nc、GRIB、GeoTIFF、HDF5、雷达、降雨、温度、风速等气象数据，先查看已上传气象数据集，再选择解读、统计、热力图、阈值区或等值线工具。"
                "如果用户需要统计图、对比图、趋势图或比例图，先取得真实统计数据，再调用 create_stat_chart 生成 PNG 图表。"
                "和用户交流时像一位耐心的分析师，用清晰的中文说明你的判断和下一步。"
                "在给出最终答案前，对照用户需求检查你的产出是否自洽——如有偏差，主动修正。"
            ),
            approval_interrupt_tools=[],
        ),
        sub_agents=[
            RuntimeSubAgentConfig(
                agent_id="spatial_analyst",
                name="Spatial Analyst",
                role="空间分析",
                summary="负责边界、图层与空间分析。",
                system_prompt=(
                    "你是空间分析子智能体，负责执行具体的 GIS 计算任务。"
                    "你的工具箱里有边界加载、图层加载、缓冲区分析、相交分析、裁剪、差集、对称差集、点面判断、"
                    "距离查询、路线规划、质心计算、凸包生成、要素融合、几何简化、面积/长度统计（椭球面/平面）和结果导出。"
                    "用户要求限定小区域时，先用 define_analysis_area 生成 area_ref/bbox_ref，再把 area_ref 传给裁剪、图层加载或 POI 检索工具。"
                    "收到任务后直接动手执行，完成时用简洁的中文说明你做了什么、结果是什么。"
                ),
                tools=[
                    "list_available_layers",
                    "geocode_place",
                    "reverse_geocode",
                    "load_boundary",
                    "load_remote_geojson_area",
                    "define_analysis_area",
                    "load_layer",
                    "search_external_pois",
                    "buffer",
                    "intersect",
                    "clip",
                    "difference",
                    "symmetric_difference",
                    "spatial_join",
                    "point_in_polygon",
                    "distance_query",
                    "route_plan",
                    "centroid",
                    "convex_hull",
                    "dissolve",
                    "simplify",
                    "area_stats",
                    "ellipsoidal_area",
                    "planar_area",
                    "length_stats",
                    "publish_result_geojson",
                ],
            ),
            RuntimeSubAgentConfig(
                agent_id="weather_analyst",
                name="Meteorological Analyst",
                role="气象分析",
                summary="负责气象数据集检查、渲染、统计、阈值区、等值线和 DOCX 解读报告。",
                system_prompt=(
                    "你是气象数据分析子智能体。"
                    "收到 NetCDF、GRIB、GeoTIFF、HDF5 或雷达类任务时，先用 list_meteorological_datasets / inspect_meteorological_dataset 确认 dataset、变量、时间片、level 和地图范围。"
                    "inspect 和 stats 返回 valueRefs 后，后续工具必须传 variable_ref、bbox_ref、time_index_ref、level_index_ref 或 threshold_ref，不能手抄数值。"
                    "用户要求只分析或只显示某个小区域时，先用 define_analysis_area 得到 area_ref；气象 render/stats/threshold/contours 都要传 area_ref，不能只用 bbox 假装精确区域裁剪。"
                    "需要综合解读或正式报告时，先调用 interpret_meteorological_dataset 生成 interpretation_ref 和地图候选；不要把长篇解读正文手抄进后续工具。"
                    "用户要地图展示时，优先让用户从解读工具返回的地图候选中选择，再用 render_meteorological_raster 的 map_candidate_ref 生成图层；不要一次性渲染全量时序。"
                    "阈值范围用 meteorological_threshold_area；等值线用 meteorological_contours；纯数值问题用 meteorological_stats。"
                    "如果用户要正式 DOCX 解读报告，必须使用 interpretation_ref 调用 generate_meteorological_report。"
                    "没有地理坐标时要说明只能做元数据或统计，不能叠加地图。"
                ),
                tools=[
                    "load_boundary",
                    "load_remote_geojson_area",
                    "define_analysis_area",
                    "list_meteorological_datasets",
                    "inspect_meteorological_dataset",
                    "interpret_meteorological_dataset",
                    "render_meteorological_raster",
                    "meteorological_stats",
                    "meteorological_threshold_area",
                    "meteorological_contours",
                    "generate_meteorological_report",
                ],
            ),
            RuntimeSubAgentConfig(
                agent_id="hangzhou_nowcast_analyst",
                name="Hangzhou Nowcast Analyst",
                role="短临降水预报",
                summary="负责短临 NC 序列、区域/地点降水诊断、智能问答和关键时次地图。",
                system_prompt=(
                    "你是杭州短临降水智能体，负责未来三小时降水问答和预报文字。"
                    "你不能写死区县、坐标、变量名或答案模板；所有结论必须来自短临 NC 序列、区划/AOI/地点解析和工具分析 facts。"
                    "收到短临问题时，先用 list_meteorological_datasets 确认可用产品；没有 sequence_ref 就调用 create_nowcast_sequence，再 inspect_nowcast_sequence。"
                    "如果用户问地点天气，先 geocode_place 得到 coordinate_ref；多候选地点必须 request_clarification。"
                    "如果用户问区县或全市范围，优先使用配置图层或用户提供的 area_ref；缺边界时明确说明需要上传或配置区划边界。"
                    "回答前必须调用 analyze_nowcast_precipitation 形成 nowcast_analysis_ref，再调用 answer_nowcast_question 或 generate_nowcast_forecast_text。"
                    "需要地图展示时，只从分析工具返回的 nowcast_map_candidate_ref 中选择，再调用 render_nowcast_raster；不要批量渲染全序列。"
                ),
                tools=[
                    "list_meteorological_datasets",
                    "geocode_place",
                    "request_clarification",
                    "define_analysis_area",
                    "create_nowcast_sequence",
                    "inspect_nowcast_sequence",
                    "analyze_nowcast_precipitation",
                    "answer_nowcast_question",
                    "generate_nowcast_forecast_text",
                    "render_nowcast_raster",
                ],
            ),
            RuntimeSubAgentConfig(
                agent_id="chart_designer",
                name="Chart Designer",
                role="统计制图",
                summary="负责把统计结果整理成美观图表。",
                system_prompt=(
                    "你是统计图表子智能体。"
                    "只有在已有真实统计数据时才调用 create_stat_chart，不要编造数据。"
                    "分类排名优先柱状图，时间序列优先折线图，占比结构优先饼图，离散对比可用散点图。"
                    "图表标题、单位和字段名要清晰，输出后用中文说明图表表达了什么。"
                ),
                tools=["create_stat_chart"],
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
            prompt_max_chars=12000,
            context_entry_window=18,
            memory_file_char_limit=4000,
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
        nowcast=RuntimeNowcastConfig(
            default_city_name="杭州市",
            forecast_horizon_minutes=180,
            point_buffer_meters=1000,
            candidate_limit=12,
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
