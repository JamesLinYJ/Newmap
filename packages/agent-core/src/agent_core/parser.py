# +-------------------------------------------------------------------------
#
#   地理智能平台 - 意图解析与计划构建
#
#   文件:       parser.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 负责把中文 GIS 问题解析成意图、执行计划和校验结果。
# 这一版把“地点锚点”提升成主路径条件，避免缺地点时继续生成伪计划。

from __future__ import annotations

import re
from typing import Any

from model_adapters import BaseModelAdapter
from shared_types.schemas import ClarificationOption, ExecutionPlan, LayerDescriptor, PlanStep, RuntimePlanningConfig, UserIntent


# 数据需求词典
#
# 这里维护的是“任务需要什么类型的数据”，而不是具体 layer_key。
# 最终用哪个 catalog 图层或外部来源，由后续的选源步骤决定。
DATA_REQUIREMENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "hospital": ("医院", "hospital", "clinic"),
    "metro_station": ("地铁", "地铁站", "metro", "subway", "station"),
    "airport": ("机场", "airport", "terminal"),
    "school": ("学校", "school", "college", "university"),
    "park": ("公园", "park"),
    "restaurant": ("餐厅", "饭店", "restaurant"),
    "pharmacy": ("药店", "pharmacy"),
}

DATA_REQUIREMENT_CATALOG_HINTS: dict[str, tuple[str, ...]] = {
    "hospital": ("hospital", "healthcare", "clinic"),
    "metro_station": ("metro_station", "transport", "metro", "subway"),
    "airport": ("airport", "transport"),
    "school": ("school", "education"),
    "park": ("park", "green_space"),
    "restaurant": ("restaurant", "food"),
    "pharmacy": ("pharmacy", "healthcare"),
}

EXTERNAL_POI_SUPPORTED_REQUIREMENTS = {"hospital", "metro_station", "airport", "school", "park", "restaurant", "pharmacy"}

# 行政区名称只保留为已知强信号的快捷路径。
#
# 它不再承担“系统理解地理位置”的主职责，只用来兼容当前 seed 数据覆盖的核心城市。
ADMIN_AREA_ALIASES = {
    "巴黎": "巴黎",
    "paris": "巴黎",
    "柏林": "柏林",
    "berlin": "柏林",
    "上海": "上海市",
    "上海市": "上海市",
    "springfield": "Springfield",
}

MAP_DISPLAY_TOKENS = (
    "地图上",
    "地图里",
    "地图结果",
    "地图展示",
    "显示在地图",
    "放地图",
    "放到地图",
    "上图",
    "展示出来",
    "显示出来",
)
NEARBY_TOKENS = ("附近", "周边", "近一点", "近一些", "靠近")
INSIDE_TOKENS = ("落在", "在里面", "里面", "内部", "区内", "范围内")
LOCATION_LOOKUP_TOKENS = ("在哪", "在哪里", "在哪儿", "位置", "什么地方", "具体位置")
MAP_NAVIGATION_TOKENS = ("跳转到", "定位到", "飞到", "导航到", "转到", "打开地图到")
DISTANCE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*(公里|km|千米|米|m)", re.I)
PLACE_DISTANCE_PATTERNS = (
    re.compile(r"^(?:请|帮我|帮忙|麻烦)?(?:查询|查找|搜索|找|看看|分析)?(?P<place>.+?)(?:\s*\d+(?:\.\d+)?\s*(?:公里|km|千米|米|m)范围内(?:的)?)(?P<target>.+)$", re.I),
    re.compile(r"^(?:请|帮我|帮忙|麻烦)?(?:查询|查找|搜索|找|看看|分析)?(?P<place>.+?)(?:附近|周边)(?:的)?(?P<target>.+)$", re.I),
)
DEFAULT_NEARBY_DISTANCE_M = 1000.0
PRE_RESOLVED_PLACE_ALIAS = "place_anchor"


# 意图解析与执行计划构建
#
# 这里先用规则做稳定底座，再允许模型参与增强和修正。
def parse_user_intent(query: str, latest_uploaded_layer_key: str | None = None) -> UserIntent:
    text = query.strip()
    normalized = text.lower()
    area = _extract_admin_area(normalized)
    data_requirements = _extract_data_requirements(text, normalized)
    target_layers = [latest_uploaded_layer_key or "latest_upload"] if ("上传" in text or "uploaded" in normalized or "我上传" in text) else []
    uncertainty_flags: list[str] = []
    distance_m = _extract_distance_m(text, normalized)
    place_query = _extract_place_query(text, data_requirements, distance_m, area)
    data_requirements = _prune_anchor_embedded_requirements(text, normalized, place_query, data_requirements)
    anchor_type = _infer_anchor_type(text, area=area, place_query=place_query, latest_uploaded_layer_key=latest_uploaded_layer_key)

    if distance_m is None and _looks_like_nearby_query(text, target_layers, place_query):
        distance_m = DEFAULT_NEARBY_DISTANCE_M
        uncertainty_flags.append("implicit_distance")

    publish_requested = (
        any(token in text for token in ("发布", "分享", "公开"))
        or "publish" in normalized
    )

    spatial_constraints: list[str] = []
    task_type = None
    clarification_required = False
    clarification_question = None
    clarification_options: list[ClarificationOption] = []

    if distance_m is not None:
        spatial_constraints.append(f"distance:{int(distance_m)}m")

    if "Springfield" in text and not re.search(r"(Illinois|Missouri|Massachusetts)", text, re.I):
        clarification_required = True
        uncertainty_flags.append("ambiguous_place")
        clarification_question = "检测到歧义地名 Springfield，请先指定具体州。"
        clarification_options = [
            ClarificationOption(option_id="springfield:illinois", label="Springfield, Illinois", description="美国伊利诺伊州 Springfield", kind="place"),
            ClarificationOption(option_id="springfield:missouri", label="Springfield, Missouri", description="美国密苏里州 Springfield", kind="place"),
        ]

    if "落在" in text or "点落区" in text or "within" in normalized or _looks_like_uploaded_point_in_polygon_query(text, area, latest_uploaded_layer_key):
        spatial_constraints.append("point_in_polygon")
        task_type = "point_in_polygon_analysis"
        if latest_uploaded_layer_key and latest_uploaded_layer_key not in target_layers:
            target_layers.append(latest_uploaded_layer_key)
    elif "裁剪" in text or "clip" in normalized:
        spatial_constraints.append("clip")
        task_type = "clip_analysis"
    elif "相交" in text or "intersect" in normalized:
        spatial_constraints.append("intersect")
        task_type = "intersect_analysis"
    elif distance_m is not None and data_requirements and place_query:
        task_type = "place_distance_analysis"
    elif distance_m is not None and len(data_requirements) >= 1 and (area or place_query):
        task_type = "distance_query"
    elif any(word in text for word in ("边界", "行政区")) and area:
        task_type = "boundary_lookup"
    elif _looks_like_map_navigation(text) and (place_query or area) and not data_requirements:
        task_type = "map_navigation"
    elif any(word in text for word in ("解析", "地址", "地点", "坐标", *LOCATION_LOOKUP_TOKENS)) and (place_query or area) and not data_requirements:
        task_type = "geocode_lookup"
    elif data_requirements and (area or place_query):
        task_type = "layer_preview"
    elif data_requirements:
        task_type = "layer_preview"
    else:
        task_type = "orientation"

    # 需要地点锚点的场景，不再允许缺少地点时继续默默生成预览计划。
    needs_anchor = task_type in {"place_distance_analysis", "distance_query"}
    if not clarification_required and needs_anchor and not area and not place_query:
        clarification_required = True
        uncertainty_flags.append("missing_anchor")
        clarification_question = "请先补充要分析的地点、城市或明确的参考对象。"
        clarification_options = [
            ClarificationOption(option_id="sample:haneda_hospital", label="查询东京羽田机场 3 公里范围内的医院", description="围绕明确地点做范围检索", kind="query_template"),
            ClarificationOption(option_id="sample:paris_metro_hospital", label="查询巴黎地铁站 1 公里范围内的医院", description="围绕图层对象做空间分析", kind="query_template"),
        ]

    desired_outputs = ["中文解释", "GeoJSON", "地图图层"]
    return UserIntent(
        area=area,
        place_query=place_query,
        anchor_type=anchor_type,
        task_type=task_type,
        distance_m=distance_m,
        publish_requested=publish_requested,
        data_requirements=data_requirements,
        target_layers=list(dict.fromkeys(target_layers)),
        spatial_constraints=spatial_constraints,
        desired_outputs=desired_outputs,
        uncertainty_flags=uncertainty_flags,
        clarification_required=clarification_required,
        clarification_question=clarification_question,
        clarification_options=clarification_options,
    )


def build_execution_plan(
    query: str,
    intent: UserIntent,
    latest_uploaded_layer_key: str | None = None,
    *,
    place_alias: str | None = None,
    catalog_layers: list[LayerDescriptor] | None = None,
    planning_config: RuntimePlanningConfig | None = None,
) -> ExecutionPlan:
    # 执行计划构建器。
    #
    # 这一版不再把 demo layer key 写死进主路径，而是先把“数据需求”
    # 绑定到真实 catalog 或外部来源，再生成可校验的工具计划。
    if intent.clarification_required:
        return ExecutionPlan(goal="clarification_needed", steps=[])

    planning = planning_config or RuntimePlanningConfig()
    active_catalog = [layer for layer in (catalog_layers or []) if layer.status == "active"]
    selected_sources = _select_data_sources(intent.data_requirements, active_catalog, planning)
    distance_m = int(intent.distance_m or DEFAULT_NEARBY_DISTANCE_M)
    task_type = intent.task_type or "orientation"
    area_name = intent.area
    resolved_place_alias = place_alias or PRE_RESOLVED_PLACE_ALIAS

    if task_type == "place_distance_analysis":
        if not intent.place_query:
            return ExecutionPlan(goal="missing_place", steps=[])
        if not selected_sources:
            return ExecutionPlan(goal="missing_data_sources", steps=[])
        target_source = selected_sources[0]
        steps = _build_source_acquisition_steps(
            source=target_source,
            alias="target_scope",
            anchor_alias=resolved_place_alias,
            distance_m=distance_m,
        )
        steps.append(
            PlanStep(
                id="target_scope_geojson",
                tool="publish_result_geojson",
                args={"input": "target_scope", "alias": "target_scope_geojson"},
                reason="导出地点周边检索结果。",
            )
        )
        return ExecutionPlan(goal="place_distance_analysis", steps=steps)

    if task_type == "point_in_polygon_analysis" and latest_uploaded_layer_key:
        steps = [
            PlanStep(id="boundary", tool="load_boundary", args={"name": intent.area, "alias": "boundary"}, reason="加载目标行政区边界。"),
            PlanStep(
                id="uploaded_points",
                tool="load_layer",
                args={"layer_key": latest_uploaded_layer_key, "alias": "uploaded_points"},
                reason="加载用户上传点图层。",
            ),
            PlanStep(
                id="points_inside_boundary",
                tool="point_in_polygon",
                args={"points": "uploaded_points", "polygon": "boundary", "alias": "points_inside_boundary"},
                reason="判断点是否落在目标边界内。",
            ),
            PlanStep(
                id="points_inside_boundary_geojson",
                tool="publish_result_geojson",
                args={"input": "points_inside_boundary", "alias": "points_inside_boundary_geojson"},
                reason="导出 GeoJSON 结果。",
            ),
        ]
        return ExecutionPlan(goal="point_in_polygon_analysis", steps=steps)

    if task_type == "clip_analysis":
        if not area_name:
            return ExecutionPlan(goal="missing_area", steps=[])
        if not selected_sources:
            return ExecutionPlan(goal="missing_data_sources", steps=[])
        steps = [PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="加载裁剪边界。")]
        steps.extend(
            _build_source_acquisition_steps(
                source=selected_sources[0],
                alias="source_layer",
                area_name=area_name,
                boundary_alias="boundary",
            )
        )
        steps.extend(
            [
            PlanStep(
                id="clipped_output",
                tool="clip",
                args={"a": "source_layer", "b": "boundary", "alias": "clipped_output"},
                reason="执行裁剪分析。",
            ),
            PlanStep(
                id="clipped_output_geojson",
                tool="publish_result_geojson",
                args={"input": "clipped_output", "alias": "clipped_output_geojson"},
                reason="导出裁剪结果。",
            ),
        ])
        return ExecutionPlan(goal="clip_analysis", steps=steps)

    if task_type == "intersect_analysis" and len(selected_sources) >= 2:
        steps: list[PlanStep] = []
        if area_name:
            steps.append(PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="限定相交分析范围。"))
        steps.extend(
            _build_source_acquisition_steps(
                source=selected_sources[0],
                alias="first_layer",
                area_name=area_name,
                boundary_alias="boundary" if area_name else None,
            )
        )
        steps.extend(
            _build_source_acquisition_steps(
                source=selected_sources[1],
                alias="second_layer",
                area_name=area_name,
                boundary_alias="boundary" if area_name else None,
            )
        )
        steps.extend(
            [
            PlanStep(
                id="intersection",
                tool="intersect",
                args={"a": "first_layer", "b": "second_layer", "alias": "intersection"},
                reason="执行相交分析。",
            ),
            PlanStep(
                id="intersection_geojson",
                tool="publish_result_geojson",
                args={"input": "intersection", "alias": "intersection_geojson"},
                reason="导出相交结果。",
            ),
        ])
        return ExecutionPlan(goal="intersect_analysis", steps=steps)

    if task_type == "distance_query":
        if place_alias and intent.place_query and selected_sources:
            steps = _build_source_acquisition_steps(
                source=selected_sources[0],
                alias="target_scope",
                anchor_alias=resolved_place_alias,
                distance_m=distance_m,
            )
            steps.append(
                PlanStep(
                    id="target_scope_geojson",
                    tool="publish_result_geojson",
                    args={"input": "target_scope", "alias": "target_scope_geojson"},
                    reason="导出周边查询结果。",
                )
            )
            return ExecutionPlan(goal="distance_query", steps=steps)

        if area_name and len(selected_sources) >= 2:
            steps = [PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="限定城市或区域范围。")]
            steps.extend(
                _build_source_acquisition_steps(
                    source=selected_sources[0],
                    alias="source_layer",
                    area_name=area_name,
                    boundary_alias="boundary",
                )
            )
            steps.extend(
                _build_source_acquisition_steps(
                    source=selected_sources[1],
                    alias="target_layer",
                    area_name=area_name,
                    boundary_alias="boundary",
                )
            )
            steps.extend(
                [
                    PlanStep(
                        id="source_buffer",
                        tool="buffer",
                        args={"input": "source_layer", "distance_m": distance_m, "alias": "source_buffer"},
                        reason=f"围绕源对象生成 {distance_m} 米缓冲区。",
                    ),
                    PlanStep(
                        id="distance_query_result",
                        tool="intersect",
                        args={"a": "target_layer", "b": "source_buffer", "alias": "distance_query_result"},
                        reason=f"筛选位于 {distance_m} 米范围内的目标要素。",
                    ),
                    PlanStep(
                        id="distance_query_geojson",
                        tool="publish_result_geojson",
                        args={"input": "distance_query_result", "alias": "distance_query_geojson"},
                        reason="导出距离查询结果。",
                    ),
                ]
            )
            return ExecutionPlan(goal="distance_query", steps=steps)
        return ExecutionPlan(goal="missing_data_sources", steps=[])

    if task_type == "boundary_lookup" and area_name:
        steps = [
            PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="获取行政区边界。"),
            PlanStep(id="boundary_geojson", tool="publish_result_geojson", args={"input": "boundary", "alias": "boundary_geojson"}, reason="导出边界 GeoJSON。"),
        ]
        return ExecutionPlan(goal="boundary_lookup", steps=steps)

    if task_type == "geocode_lookup" and (intent.place_query or area_name):
        steps = [
            PlanStep(
                id="geocode_geojson",
                tool="publish_result_geojson",
                args={"input": resolved_place_alias, "alias": "geocode_geojson"},
                reason="导出地点检索结果。",
            ),
        ]
        return ExecutionPlan(goal="geocode_lookup", steps=steps)

    if task_type == "layer_preview" and selected_sources:
        steps: list[PlanStep] = []
        if area_name:
            steps.append(PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="限定预览范围。"))
        steps.extend(
            _build_source_acquisition_steps(
                source=selected_sources[0],
                alias="layer_preview",
                area_name=area_name,
                boundary_alias="boundary" if area_name else None,
                anchor_alias=resolved_place_alias if intent.place_query else None,
                distance_m=distance_m if intent.place_query else None,
            )
        )
        steps.append(
            PlanStep(
                id="layer_preview_geojson",
                tool="publish_result_geojson",
                args={"input": "layer_preview", "alias": "layer_preview_geojson"},
                reason="导出预览结果。",
            )
        )
        return ExecutionPlan(goal="layer_preview", steps=steps)

    if planning.allow_text_only_delivery:
        return ExecutionPlan(goal="text_only_delivery", steps=[])
    return ExecutionPlan(goal="orientation", steps=[PlanStep(id="available_layers", tool="list_available_layers", args={}, reason="提供当前可分析图层作为引导。")])


def _select_data_sources(
    data_requirements: list[str],
    catalog_layers: list[LayerDescriptor],
    planning_config: RuntimePlanningConfig,
) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    priorities = {source: index for index, source in enumerate(planning_config.external_source_priority)}
    for requirement in data_requirements:
        options: list[tuple[int, dict[str, str]]] = []
        catalog_match = _pick_catalog_layer_for_requirement(requirement, catalog_layers)
        if catalog_match is not None:
            options.append(
                (
                    priorities.get("catalog", 99),
                    {
                        "mode": "catalog",
                        "requirement": requirement,
                        "layer_key": catalog_match.layer_key,
                        "label": catalog_match.name,
                    },
                )
            )
        if requirement in EXTERNAL_POI_SUPPORTED_REQUIREMENTS:
            options.append(
                (
                    priorities.get("external_poi", 99),
                    {
                        "mode": "external_poi",
                        "requirement": requirement,
                        "category": requirement,
                        "label": requirement,
                    },
                )
            )
        if not options:
            continue
        options.sort(key=lambda item: item[0])
        selected.append(options[0][1])
    return selected


def _pick_catalog_layer_for_requirement(requirement: str, catalog_layers: list[LayerDescriptor]) -> LayerDescriptor | None:
    hints = DATA_REQUIREMENT_CATALOG_HINTS.get(requirement, ())
    scored: list[tuple[int, LayerDescriptor]] = []
    for layer in catalog_layers:
        if layer.status != "active":
            continue
        if layer.source_type == "result":
            continue
        haystacks = [
            layer.name.casefold(),
            layer.description.casefold(),
            layer.category.casefold(),
            *(item.casefold() for item in layer.tags),
            *(item.casefold() for item in layer.analysis_capabilities),
        ]
        score = 0
        for hint in hints:
            if layer.category.casefold() == hint:
                score += 6
            if any(item == hint for item in (token.casefold() for token in layer.tags)):
                score += 4
            if any(item == hint for item in (token.casefold() for token in layer.analysis_capabilities)):
                score += 3
            if any(hint in haystack for haystack in haystacks):
                score += 2
        if score > 0:
            scored.append((score, layer))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1].name))
    return scored[0][1]


def _build_source_acquisition_steps(
    *,
    source: dict[str, str],
    alias: str,
    area_name: str | None = None,
    boundary_alias: str | None = None,
    anchor_alias: str | None = None,
    distance_m: int | None = None,
) -> list[PlanStep]:
    if source["mode"] == "catalog":
        args: dict[str, Any] = {"layer_key": source["layer_key"], "alias": alias}
        if boundary_alias:
            args["boundary"] = boundary_alias
        elif area_name:
            args["area_name"] = area_name
        return [
            PlanStep(
                id=alias,
                tool="load_layer",
                args=args,
                reason=f"加载真实 catalog 图层 {source['layer_key']}。",
            )
        ]

    args = {"category": source["category"], "alias": alias}
    if boundary_alias:
        args["boundary"] = boundary_alias
    elif anchor_alias:
        args["anchor"] = anchor_alias
        args["distance_m"] = distance_m or int(DEFAULT_NEARBY_DISTANCE_M)
    return [
        PlanStep(
            id=alias,
            tool="search_external_pois",
            args=args,
            reason=f"从外部 POI 来源检索 {source['requirement']} 数据。",
        )
    ]


async def parse_user_intent_with_model(
    query: str,
    *,
    adapter: BaseModelAdapter,
    model_name: str | None = None,
    latest_uploaded_layer_key: str | None = None,
    available_layers: list[str] | None = None,
) -> UserIntent:
    if not adapter.is_configured():
        return parse_user_intent(query, latest_uploaded_layer_key=latest_uploaded_layer_key)

    heuristic = parse_user_intent(query, latest_uploaded_layer_key=latest_uploaded_layer_key)
    schema = UserIntent.model_json_schema()
    prompt = (
        "你是 GIS Agent 的意图解析器。"
        "请从用户问题中提取结构化空间分析意图。"
        "禁止添加未识别的图层。"
        "如果用户问题依赖地点锚点，请显式给出 placeQuery 和 anchorType。"
        f"可用图层: {', '.join(available_layers or [])}。"
        f"如果用户提到上传图层，使用 {latest_uploaded_layer_key or 'latest_upload'}。"
        "如果地点存在明显歧义，必须设置 clarificationRequired=true。"
        f"\n用户问题: {query}\n"
        f"\n启发式参考: {heuristic.model_dump_json(indent=2)}"
    )
    try:
        payload = await adapter.structured(prompt, schema=schema, model=model_name)
        intent = UserIntent.model_validate(payload)
        if not intent.target_layers and heuristic.target_layers:
            intent.target_layers = heuristic.target_layers
        if intent.distance_m is None:
            intent.distance_m = heuristic.distance_m
        if not intent.task_type:
            intent.task_type = heuristic.task_type
        if not intent.place_query:
            intent.place_query = heuristic.place_query
        if not intent.area:
            intent.area = heuristic.area
        if not intent.anchor_type:
            intent.anchor_type = heuristic.anchor_type
        if intent.publish_requested is False and heuristic.publish_requested:
            intent.publish_requested = True
        return intent
    except Exception:
        return heuristic


async def build_execution_plan_with_model(
    query: str,
    *,
    intent: UserIntent,
    adapter: BaseModelAdapter,
    model_name: str | None = None,
    latest_uploaded_layer_key: str | None = None,
    available_tools: list[str] | None = None,
    catalog_layers: list[LayerDescriptor] | None = None,
    planning_config: RuntimePlanningConfig | None = None,
) -> ExecutionPlan:
    heuristic = build_execution_plan(
        query,
        intent,
        latest_uploaded_layer_key=latest_uploaded_layer_key,
        catalog_layers=catalog_layers,
        planning_config=planning_config,
    )
    if not adapter.is_configured() or intent.clarification_required:
        return heuristic

    schema = ExecutionPlan.model_json_schema()
    prompt = (
        "你是 GIS Agent 的执行计划生成器。"
        "你只能使用允许的工具，不能生成 SQL，不能生成 Python 代码。"
        f"允许工具: {', '.join(available_tools or [])}。"
        "如果任务依赖地点锚点，只能在地点已经解析完成后使用 place_anchor 这样的已知引用。"
        "如果需要用 catalog 图层，必须使用提供给你的真实 layer_key。"
        f"可用 catalog 图层: {', '.join(layer.layer_key for layer in (catalog_layers or [])) or '当前为空'}。"
        f"\n用户问题: {query}"
        f"\n解析意图: {intent.model_dump_json(indent=2)}"
        f"\n启发式参考计划: {heuristic.model_dump_json(indent=2)}"
    )
    try:
        payload = await adapter.structured(prompt, schema=schema, model=model_name)
        plan = ExecutionPlan.model_validate(payload)
        if not plan.steps:
            return heuristic
        return plan
    except Exception:
        return heuristic


def verify_execution_plan(
    plan: ExecutionPlan,
    available_tools: list[str],
    area: str | None,
    *,
    available_layers: list[str] | None = None,
    latest_uploaded_layer_key: str | None = None,
    preloaded_aliases: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    errors: list[str] = []
    known_aliases: set[str] = set(preloaded_aliases or [])
    known_layers = set(available_layers or [])
    if latest_uploaded_layer_key:
        known_layers.add(latest_uploaded_layer_key)

    for step in plan.steps:
        if step.tool not in available_tools:
            errors.append(f"工具 {step.tool} 未注册。")
        if step.tool in {"buffer", "distance_query"} and "distance_m" not in step.args:
            errors.append(f"步骤 {step.id} 缺少 distance_m。")
        if step.tool == "load_boundary" and not step.args.get("name"):
            errors.append(f"步骤 {step.id} 缺少边界名称。")
        if step.tool == "load_layer":
            layer_key = str(step.args.get("layer_key", "")).strip()
            if not layer_key:
                errors.append(f"步骤 {step.id} 缺少 layer_key。")
            elif layer_key == "latest_upload" and not latest_uploaded_layer_key:
                errors.append(f"步骤 {step.id} 引用了上传图层，但当前会话没有上传结果。")
            elif layer_key != "latest_upload" and layer_key not in known_layers:
                errors.append(f"步骤 {step.id} 引用了未知图层 {layer_key}。")
            boundary_ref = step.args.get("boundary")
            if boundary_ref and str(boundary_ref) not in known_aliases:
                errors.append(f"步骤 {step.id} 依赖的边界别名 {boundary_ref} 尚未定义。")
        if step.tool == "search_external_pois":
            has_boundary = bool(step.args.get("boundary"))
            has_anchor = bool(step.args.get("anchor"))
            if not step.args.get("category"):
                errors.append(f"步骤 {step.id} 缺少外部 POI 类别。")
            if not has_boundary and not has_anchor:
                errors.append(f"步骤 {step.id} 缺少边界或锚点，无法检索外部 POI。")
            if has_boundary and str(step.args.get("boundary")) not in known_aliases:
                errors.append(f"步骤 {step.id} 依赖的边界别名 {step.args.get('boundary')} 尚未定义。")
            if has_anchor and str(step.args.get("anchor")) not in known_aliases:
                errors.append(f"步骤 {step.id} 依赖的锚点别名 {step.args.get('anchor')} 尚未定义。")
        for arg_name in _alias_refs_for_step(step):
            ref = step.args.get(arg_name)
            if ref and str(ref) not in known_aliases:
                errors.append(f"步骤 {step.id} 引用了未定义的结果别名 {ref}。")
        alias = step.args.get("alias")
        if alias:
            known_aliases.add(str(alias))

    if not plan.steps and plan.goal not in {"clarification_needed", "missing_data_sources", "text_only_delivery"}:
        warnings.append("当前计划没有可执行步骤。")

    return warnings, errors


def _alias_refs_for_step(step: PlanStep) -> list[str]:
    if step.tool == "buffer":
        return ["input"]
    if step.tool in {"intersect", "clip"}:
        return ["a", "b"]
    if step.tool == "spatial_join":
        return ["points", "polygons"]
    if step.tool == "point_in_polygon":
        return ["points", "polygon"]
    if step.tool == "distance_query":
        return ["source", "target"]
    if step.tool == "publish_result_geojson":
        return ["input"]
    return []


def _extract_admin_area(normalized: str) -> str | None:
    for candidate, canonical in ADMIN_AREA_ALIASES.items():
        if candidate in normalized:
            return canonical
    return None


def _extract_data_requirements(text: str, normalized: str) -> list[str]:
    matches: list[tuple[int, str]] = []
    for requirement, keywords in DATA_REQUIREMENT_KEYWORDS.items():
        positions = [normalized.find(keyword.casefold()) for keyword in keywords if normalized.find(keyword.casefold()) != -1]
        if positions:
            matches.append((min(positions), requirement))
    matches.sort(key=lambda item: item[0])
    return [requirement for _, requirement in matches]


def _prune_anchor_embedded_requirements(
    text: str,
    normalized: str,
    place_query: str | None,
    data_requirements: list[str],
) -> list[str]:
    if not place_query or len(data_requirements) <= 1:
        return data_requirements
    anchor_text = place_query.casefold()
    anchor_start = normalized.find(anchor_text)
    if anchor_start == -1:
        return data_requirements
    anchor_end = anchor_start + len(anchor_text)
    filtered: list[str] = []
    for requirement in data_requirements:
        keyword_positions = [
            normalized.find(keyword.casefold())
            for keyword in DATA_REQUIREMENT_KEYWORDS.get(requirement, ())
            if normalized.find(keyword.casefold()) != -1
        ]
        if any(position < anchor_start or position >= anchor_end for position in keyword_positions):
            filtered.append(requirement)
            continue
        if all(anchor_start <= position < anchor_end for position in keyword_positions):
            continue
        filtered.append(requirement)
    return filtered or data_requirements


def _extract_distance_m(text: str, normalized: str) -> float | None:
    match = DISTANCE_PATTERN.search(normalized)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).lower()
    if unit in {"公里", "km", "千米"}:
        return value * 1000
    return value


def _extract_place_query(text: str, data_requirements: list[str], distance_m: float | None, area: str | None) -> str | None:
    if area or "上传" in text:
        return None
    if distance_m is None and not any(token in text for token in ("解析", "地址", "地点", "坐标", *LOCATION_LOOKUP_TOKENS, *MAP_NAVIGATION_TOKENS, *NEARBY_TOKENS)):
        return None
    for pattern in PLACE_DISTANCE_PATTERNS:
        match = pattern.match(_strip_query_prefix(text))
        if match:
            candidate = _cleanup_place_phrase(match.group("place"), data_requirements)
            if candidate:
                return candidate
    if any(token in text for token in ("解析", "地址", "地点", "坐标", *LOCATION_LOOKUP_TOKENS, *MAP_NAVIGATION_TOKENS)):
        candidate = _cleanup_place_phrase(_strip_query_prefix(text), data_requirements)
        return candidate or None
    return None


def _cleanup_place_phrase(value: str, data_requirements: list[str]) -> str:
    candidate = value.strip(" ，。！？?、")
    candidate = re.sub(r"^(查询|查找|搜索|找|看看|分析|定位|定位到|跳转到|飞到|导航到|转到|打开地图到|查一下|帮我查|帮我看看)", "", candidate).strip()
    candidate = re.sub(r"(在哪(?:里|儿)?|位置|什么地方|具体位置|在哪呢|在哪啊)$", "", candidate).strip(" ，。！？?、的")
    return candidate


def _strip_query_prefix(text: str) -> str:
    return re.sub(r"^(请|帮我|帮忙|麻烦)?", "", text).strip()


def _infer_anchor_type(text: str, *, area: str | None, place_query: str | None, latest_uploaded_layer_key: str | None) -> str:
    if latest_uploaded_layer_key and any(token in text for token in ("上传", "我上传", "我传")):
        return "uploaded_layer"
    if area:
        return "admin_area"
    if place_query:
        return "poi"
    return "unknown"


def _looks_like_map_navigation(text: str) -> bool:
    return any(token in text for token in MAP_NAVIGATION_TOKENS)


def _looks_like_nearby_query(text: str, target_layers: list[str], place_query: str | None) -> bool:
    if place_query and len(target_layers) >= 1:
        return any(token in text for token in NEARBY_TOKENS) or "范围内" in text
    return any(token in text for token in NEARBY_TOKENS) or "范围内" in text


def _looks_like_uploaded_point_in_polygon_query(
    text: str,
    area: str | None,
    latest_uploaded_layer_key: str | None,
) -> bool:
    if not latest_uploaded_layer_key or not area:
        return False
    mentions_upload = any(token in text for token in ("上传", "我传", "我上传"))
    mentions_points = "点" in text or "位置" in text
    mentions_inside = any(token in text for token in INSIDE_TOKENS) or bool(re.search(r"哪些.*在.*(里面|区内|范围内|内)", text))
    return mentions_upload and mentions_points and mentions_inside
