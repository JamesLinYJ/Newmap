# +-------------------------------------------------------------------------
#
#   地理智能平台 - 意图解析与计划构建
#
#   文件:       parser.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import re
from typing import Any

from model_adapters import BaseModelAdapter
from shared_types.schemas import ClarificationOption, ExecutionPlan, PlanStep, UserIntent


LAYER_KEYWORDS: dict[str, tuple[str, ...]] = {
    "metro_stations": ("地铁", "metro", "station"),
    "hospitals": ("医院", "hospital", "clinic"),
    "candidate_sites": ("候选", "candidate", "site", "poi"),
    "admin_boundaries": ("边界", "行政区", "boundary"),
}

KNOWN_AREAS = ("巴黎", "Paris", "柏林", "Berlin", "上海", "上海市", "Springfield")


# 意图解析与执行计划构建
#
# 这里先用规则做稳定底座，再允许模型参与增强和修正。
def parse_user_intent(query: str, latest_uploaded_layer_key: str | None = None) -> UserIntent:
    text = query.strip()
    normalized = text.lower()
    area = _extract_area(text, normalized)
    distance_m = _extract_distance_m(text, normalized)
    publish_requested = any(token in text for token in ("发布", "分享", "公开")) or "publish" in normalized

    target_layers = _extract_target_layers(text, normalized, latest_uploaded_layer_key)
    spatial_constraints: list[str] = []
    task_type = None

    if distance_m is not None:
        spatial_constraints.append(f"distance:{int(distance_m)}m")
    if "落在" in text or "点落区" in text or "within" in normalized:
        spatial_constraints.append("point_in_polygon")
        task_type = "point_in_polygon_analysis"
    if "裁剪" in text or "clip" in normalized:
        spatial_constraints.append("clip")
        task_type = "clip_analysis"
    if "相交" in text or "intersect" in normalized:
        spatial_constraints.append("intersect")
        task_type = "intersect_analysis"
    if "距离" in text and distance_m is not None:
        task_type = "distance_query"
    if task_type is None and distance_m is not None and {"metro_stations", "hospitals"} <= set(target_layers):
        task_type = "buffer_intersection_analysis"
    if task_type is None and any(word in text for word in ("边界", "行政区")):
        task_type = "boundary_lookup"
    if task_type is None and any(word in text for word in ("解析", "地址", "地点")):
        task_type = "geocode_lookup"
    if task_type is None and target_layers:
        task_type = "layer_preview"
    if task_type is None:
        task_type = "orientation"

    desired_outputs = ["中文解释", "GeoJSON", "地图图层"]
    uncertainty_flags: list[str] = []
    clarification_required = False
    clarification_question = None
    clarification_options: list[ClarificationOption] = []

    if "Springfield" in text and not re.search(r"(Illinois|Missouri|Massachusetts)", text, re.I):
        clarification_required = True
        uncertainty_flags.append("ambiguous_place")
        clarification_question = "检测到歧义地名 Springfield，请先指定具体州。"
        clarification_options = [
            ClarificationOption(label="Springfield, Illinois", description="美国伊利诺伊州 Springfield"),
            ClarificationOption(label="Springfield, Missouri", description="美国密苏里州 Springfield"),
        ]

    return UserIntent(
        area=area,
        task_type=task_type,
        distance_m=distance_m,
        publish_requested=publish_requested,
        target_layers=target_layers,
        spatial_constraints=spatial_constraints,
        desired_outputs=desired_outputs,
        uncertainty_flags=uncertainty_flags,
        clarification_required=clarification_required,
        clarification_question=clarification_question,
        clarification_options=clarification_options,
    )


def build_execution_plan(query: str, intent: UserIntent, latest_uploaded_layer_key: str | None = None) -> ExecutionPlan:
    # 执行计划构建器。
    if intent.clarification_required:
        return ExecutionPlan(goal="clarification_needed", steps=[])

    area_name = intent.area or "巴黎"
    distance_m = int(intent.distance_m or 1000)
    task_type = intent.task_type or "orientation"

    if task_type == "buffer_intersection_analysis":
        steps = [
            PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="限定分析范围。"),
            PlanStep(
                id="metro_stations_scope",
                tool="load_layer",
                args={"layer_key": "metro_stations", "area_name": area_name, "boundary": "boundary", "alias": "metro_stations_scope"},
                reason="加载地铁站图层。",
            ),
            PlanStep(
                id="hospitals_scope",
                tool="load_layer",
                args={"layer_key": "hospitals", "area_name": area_name, "boundary": "boundary", "alias": "hospitals_scope"},
                reason="加载医院图层。",
            ),
            PlanStep(
                id="metro_buffer",
                tool="buffer",
                args={"input": "metro_stations_scope", "distance_m": distance_m, "alias": "metro_buffer"},
                reason=f"生成地铁站 {distance_m} 米缓冲区。",
            ),
            PlanStep(
                id="nearby_hospitals",
                tool="intersect",
                args={"a": "hospitals_scope", "b": "metro_buffer", "alias": "nearby_hospitals"},
                reason="筛选缓冲区内的医院。",
            ),
            PlanStep(
                id="nearby_hospitals_geojson",
                tool="publish_result_geojson",
                args={"input": "nearby_hospitals", "alias": "nearby_hospitals_geojson"},
                reason="输出 GeoJSON 结果。",
            ),
        ]
        return ExecutionPlan(goal="buffer_intersection_analysis", steps=steps)

    if task_type == "point_in_polygon_analysis" and latest_uploaded_layer_key:
        steps = [
            PlanStep(id="boundary", tool="load_boundary", args={"name": intent.area or "柏林", "alias": "boundary"}, reason="加载目标行政区边界。"),
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
        source_layer = _pick_primary_layer(intent.target_layers, default="candidate_sites")
        steps = [
            PlanStep(id="boundary", tool="load_boundary", args={"name": area_name, "alias": "boundary"}, reason="加载裁剪边界。"),
            PlanStep(
                id="source_layer",
                tool="load_layer",
                args={"layer_key": source_layer, "area_name": area_name, "alias": "source_layer"},
                reason="加载待裁剪图层。",
            ),
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
        ]
        return ExecutionPlan(goal="clip_analysis", steps=steps)

    if task_type == "intersect_analysis" and len(intent.target_layers) >= 2:
        first_layer, second_layer = intent.target_layers[:2]
        steps = [
            PlanStep(
                id="first_layer",
                tool="load_layer",
                args={"layer_key": first_layer, "area_name": area_name if intent.area else None, "alias": "first_layer"},
                reason="加载第一个图层。",
            ),
            PlanStep(
                id="second_layer",
                tool="load_layer",
                args={"layer_key": second_layer, "area_name": area_name if intent.area else None, "alias": "second_layer"},
                reason="加载第二个图层。",
            ),
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
        ]
        return ExecutionPlan(goal="intersect_analysis", steps=steps)

    if task_type == "distance_query" and len(intent.target_layers) >= 2:
        source_layer, target_layer = intent.target_layers[:2]
        steps = [
            PlanStep(
                id="source_layer",
                tool="load_layer",
                args={"layer_key": source_layer, "area_name": area_name if intent.area else None, "alias": "source_layer"},
                reason="加载距离查询源图层。",
            ),
            PlanStep(
                id="target_layer",
                tool="load_layer",
                args={"layer_key": target_layer, "area_name": area_name if intent.area else None, "alias": "target_layer"},
                reason="加载距离查询目标图层。",
            ),
            PlanStep(
                id="distance_query",
                tool="distance_query",
                args={"source": "source_layer", "target": "target_layer", "distance_m": distance_m, "alias": "distance_query_result"},
                reason=f"查询 {distance_m} 米范围内的目标要素。",
            ),
            PlanStep(
                id="distance_query_geojson",
                tool="publish_result_geojson",
                args={"input": "distance_query_result", "alias": "distance_query_geojson"},
                reason="导出距离查询结果。",
            ),
        ]
        return ExecutionPlan(goal="distance_query", steps=steps)

    if task_type == "boundary_lookup":
        steps = [
            PlanStep(id="boundary", tool="load_boundary", args={"name": intent.area or query, "alias": "boundary"}, reason="获取行政区边界。"),
            PlanStep(id="boundary_geojson", tool="publish_result_geojson", args={"input": "boundary", "alias": "boundary_geojson"}, reason="导出边界 GeoJSON。"),
        ]
        return ExecutionPlan(goal="boundary_lookup", steps=steps)

    if task_type == "geocode_lookup":
        steps = [
            PlanStep(id="geocode", tool="geocode_place", args={"query": query}, reason="解析地点名称。"),
        ]
        return ExecutionPlan(goal="geocode_lookup", steps=steps)

    if task_type == "layer_preview" and intent.target_layers:
        layer_key = _pick_primary_layer(intent.target_layers, default="candidate_sites")
        steps = [
            PlanStep(
                id="layer_preview",
                tool="load_layer",
                args={"layer_key": layer_key, "area_name": area_name if intent.area else None, "alias": "layer_preview"},
                reason="加载请求的图层。",
            ),
            PlanStep(
                id="layer_preview_geojson",
                tool="publish_result_geojson",
                args={"input": "layer_preview", "alias": "layer_preview_geojson"},
                reason="导出图层结果。",
            ),
        ]
        return ExecutionPlan(goal="layer_preview", steps=steps)

    return ExecutionPlan(
        goal="orientation",
        steps=[PlanStep(id="available_layers", tool="list_available_layers", args={}, reason="提供当前可分析图层作为引导。")],
    )


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
) -> ExecutionPlan:
    heuristic = build_execution_plan(query, intent, latest_uploaded_layer_key=latest_uploaded_layer_key)
    if not adapter.is_configured() or intent.clarification_required:
        return heuristic

    schema = ExecutionPlan.model_json_schema()
    prompt = (
        "你是 GIS Agent 的执行计划生成器。"
        "你只能使用允许的工具，不能生成 SQL，不能生成 Python 代码。"
        f"允许工具: {', '.join(available_tools or [])}。"
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
) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    errors: list[str] = []
    known_aliases: set[str] = set()
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
        for arg_name in _alias_refs_for_step(step):
            ref = step.args.get(arg_name)
            if ref and str(ref) not in known_aliases:
                errors.append(f"步骤 {step.id} 引用了未定义的结果别名 {ref}。")
        if step.tool == "publish_to_qgis_project" and not step.args.get("artifact_id"):
            errors.append(f"步骤 {step.id} 缺少 artifact_id，无法发布。")
        alias = step.args.get("alias")
        if alias:
            known_aliases.add(str(alias))

    if any(step.tool in {"buffer", "distance_query"} for step in plan.steps) and area not in {"巴黎", "柏林", "上海市"}:
        warnings.append("当前距离分析未锁定熟悉城市范围，建议在结果中复核 CRS 近似误差。")
    if not plan.steps:
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


def _extract_area(text: str, normalized: str) -> str | None:
    for candidate in KNOWN_AREAS:
        if candidate.lower() in normalized:
            if candidate in {"上海", "上海市"}:
                return "上海市"
            return candidate.replace("Paris", "巴黎").replace("Berlin", "柏林")
    return None


def _extract_target_layers(text: str, normalized: str, latest_uploaded_layer_key: str | None) -> list[str]:
    layers: list[str] = []
    for layer_key, keywords in LAYER_KEYWORDS.items():
        if any(keyword.lower() in normalized for keyword in keywords):
            layers.append(layer_key)
    if "上传" in text or "uploaded" in normalized or "我上传" in text:
        layers.append(latest_uploaded_layer_key or "latest_upload")
    return list(dict.fromkeys(layers))


def _extract_distance_m(text: str, normalized: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(公里|km|千米|米|m)", normalized)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2)
    if unit in {"公里", "km", "千米"}:
        return value * 1000
    return value


def _pick_primary_layer(layers: list[str], *, default: str) -> str:
    for layer in layers:
        if layer != "admin_boundaries":
            return layer
    return default
