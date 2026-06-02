# +-------------------------------------------------------------------------
#
#   地理智能平台 - Supervisor 默认配置
#
#   文件:       supervisor_config.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------
# 模块职责
#
# 定义运行时默认 supervisor、subagent、UI 与上下文窗口配置，并负责配置归一化合并。
# 支持从 .geoagent/agents/ 动态加载自定义 Agent 定义。
from __future__ import annotations

from logging import getLogger
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

from shared_types.schemas import (
    AgentRuntimeConfig,
    HookConfigEntry,
    PermissionRuleEntry,
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

logger = getLogger(__name__)


LOOP_PHASES = {
    "observe": "observe",
    "decide": "decide",
    "act": "act",
    "observe_result": "observe_result",
    "approval": "approval",
    "deliver": "deliver",
    "failed": "failed",
}


class AgentRuntimeSettings(BaseSettings):
    """Agent 运行时配置。自动从 GEOAGENT_ 前缀的环境变量加载。

    Attributes:
        max_turns: Agent 最大工具调用轮数。
        max_repair_rounds: 最大修复重试轮数。
        auto_memory_enabled: 是否启用自动记忆系统。
        memory_base_dir: 记忆文件存储目录（相对项目根目录）。
        token_budget: 单次运行 Token 预算上限。
    """
    model_config = SettingsConfigDict(env_prefix="GEOAGENT_", env_file=".env")

    max_turns: int = 50
    max_repair_rounds: int = 3
    auto_memory_enabled: bool = True
    memory_base_dir: str = ".geoagent/memory"
    token_budget: int = 200000


def build_default_runtime_config() -> AgentRuntimeConfig:
    return AgentRuntimeConfig(
        loop_trace_limit=80,
        supervisor=SupervisorRuntimeConfig(
            name="geo_agent_supervisor",
            system_prompt=(
                "你是一个中文地理空间智能助手，擅长理解用户的空间分析需求。"
                "收到问题后，先判断意图；气象和短临任务按职责分派给子智能体，其它任务再决定是否自己调用工具。"
                "优先使用已经就绪的 GIS 工具，基于真实数据给出答案，不凭空构造结果。"
                "如果用户提到短临、未来三小时、杭州降雨、市民中心天气或区县雨势，必须交给 hangzhou_nowcast_analyst；"
                "不得用常识或历史上下文直接回答天气。"
                "如果用户提到天气状态、气象、nc、GRIB、GeoTIFF、HDF5、雷达、降雨、温度、风速等气象数据，必须交给 weather_analyst 先查看已上传气象数据集，再选择解读、统计、热力图、阈值区或等值线工具。"
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
                    "你不能写死区县、坐标、变量名或答案模板；所有结论必须来自短临 NC 序列、区划/AOI/地点解析和工具分析 facts。\n"
                    "工作流程：\n"
                    "1. 收到短临问题 → list_meteorological_datasets 确认可用产品。\n"
                    "2. 没有 sequence_ref → create_nowcast_sequence。\n"
                    "3. 地点天气问题 → geocode_place 得 coordinate_ref；多候选必须 request_clarification。\n"
                    "4. 区县/分区预报 → list_available_layers 查 boundary/admin/区划图层 → 传入 analyze_nowcast_precipitation 的 district_layer_key 和 district_name_field。没找到区划图层则用全覆盖范围分析。\n"
                    "5. 必须调用 analyze_nowcast_precipitation 后再调用 answer_nowcast_question。\n"
                    "6. 地图展示只从 nowcast_map_candidate_ref 中选择 → render_nowcast_raster。\n\n"
                    "回答规范：\n"
                    "- 概括性问题（接下来天气怎么样）：先列各区县降雨时间线（什么时候下、下多大、持续多久），再总结整体趋势和移动方向。\n"
                    "- 地点问题（XX天气怎么样）：聚焦该地点的降雨起止时间和雨量变化（X分钟后下X雨→X分钟后雨量变大→X小时后渐停），最后提降雨区移动方向。\n"
                    "- 全区域无雨：简洁告知可放心出门，不逐个列举区县。\n"
                    "- 杜绝空泛表述如\"可能有雨\"或\"请关注最新预报\"，有数据就给出具体时间和量级。"
                ),
                tools=[
                    "list_meteorological_datasets",
                    "list_available_layers",
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
            memory_enabled=True,  # 启用记忆系统，Agent 可在会话间持久化偏好、反馈和项目上下文
            memory_base_dir=".geoagent/memory",  # 记忆文件存储目录（相对项目根目录）
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


def merge_custom_agent_configs(
    sub_agents: list[RuntimeSubAgentConfig] | list[dict[str, Any]],
    project_root: Path | None = None,
    custom_definitions: list[Any] | None = None,
) -> list[RuntimeSubAgentConfig]:
    """将静态 sub_agent 配置与动态加载的自定义 Agent 定义合并。

    从 .geoagent/agents/*.{yml,yaml} 加载自定义 Agent 定义，
    并与静态 sub_agents 配置合并。
    自定义 Agent 的名称若与静态配置的 agent_id 冲突，则覆盖静态配置。

    Args:
        sub_agents: 静态 sub_agents 配置列表。
        project_root: 项目根目录路径（用于加载 .geoagent/agents/）。
        custom_definitions: 直接传入的自定义定义列表（优先级最高）。

    Returns:
        合并后的 RuntimeSubAgentConfig 列表。
    """
    static_list: list[RuntimeSubAgentConfig] = [
        RuntimeSubAgentConfig.model_validate(item) if isinstance(item, dict) else item
        for item in sub_agents
    ]

    customs: list[Any] = []
    if custom_definitions is not None:
        customs.extend(custom_definitions)
    elif project_root is not None:
        try:
            from .agent_definitions import load_agent_definitions
            customs.extend(load_agent_definitions(project_root))
        except Exception as exc:
            logger.warning("加载自定义 Agent 定义失败: %s", exc)

    if not customs:
        return static_list

    # 构建静态 agent_id -> 索引映射
    static_index: dict[str, int] = {}
    for i, agent in enumerate(static_list):
        agent_id = getattr(agent, "agent_id", None)
        if agent_id:
            static_index[agent_id] = i

    merged: list[RuntimeSubAgentConfig] = list(static_list)
    for custom in customs:
        name = getattr(custom, "name", None) or (isinstance(custom, dict) and custom.get("name"))
        description = getattr(custom, "description", None) or (isinstance(custom, dict) and custom.get("description", ""))
        system_prompt = getattr(custom, "system_prompt", None) or (isinstance(custom, dict) and custom.get("system_prompt", ""))
        tools = list(getattr(custom, "tools", None) or (isinstance(custom, dict) and custom.get("tools", [])) or [])
        model = getattr(custom, "model", None) or (isinstance(custom, dict) and custom.get("model", "default"))

        if not name:
            continue

        custom_config = RuntimeSubAgentConfig(
            agent_id=name,
            name=name,
            role=description or name,
            summary=description or name,
            system_prompt=system_prompt or description or name,
            tools=tools,
        )

        if name in static_index:
            merged[static_index[name]] = custom_config
            logger.info("自定义 Agent '%s' 覆盖了静态配置", name)
        else:
            merged.append(custom_config)
            logger.info("自定义 Agent '%s' 已追加到配置", name)

    return merged
