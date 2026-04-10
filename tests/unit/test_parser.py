from agent_core.parser import build_execution_plan, parse_user_intent


def test_parse_buffer_intersection_intent():
    intent = parse_user_intent("查询巴黎地铁站 1 公里范围内的医院")
    assert intent.area == "巴黎"
    assert "metro_stations" in intent.target_layers
    assert "hospitals" in intent.target_layers
    assert "distance:1000m" in intent.spatial_constraints


def test_parse_ambiguous_place_requires_clarification():
    intent = parse_user_intent("查询叫 Springfield 的区域")
    assert intent.clarification_required is True
    assert intent.clarification_options


def test_build_point_in_polygon_plan():
    intent = parse_user_intent("判断我上传的点是否落在柏林行政区内", latest_uploaded_layer_key="upload_demo")
    plan = build_execution_plan("判断我上传的点是否落在柏林行政区内", intent, latest_uploaded_layer_key="upload_demo")
    assert plan.goal == "point_in_polygon_analysis"
    assert [step.tool for step in plan.steps[:3]] == ["load_boundary", "load_layer", "point_in_polygon"]


def test_parse_clip_query():
    intent = parse_user_intent("裁剪上海市范围内的候选点")
    assert intent.task_type == "clip_analysis"
    plan = build_execution_plan("裁剪上海市范围内的候选点", intent)
    assert plan.goal == "clip_analysis"
    assert [step.tool for step in plan.steps[:3]] == ["load_boundary", "load_layer", "clip"]


def test_parse_publish_distance_query():
    intent = parse_user_intent("查询柏林地铁站 500 米范围内的医院并发布结果")
    assert intent.distance_m == 500
    assert intent.publish_requested is True
