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


def test_parse_colloquial_nearby_query_for_immediate_map_display():
    query = "我想找柏林离地铁近一点的医院，帮我在地图上显示出来"
    intent = parse_user_intent(query)
    plan = build_execution_plan(query, intent)

    assert intent.task_type == "buffer_intersection_analysis"
    assert intent.distance_m == 1000
    assert intent.publish_requested is True
    assert plan.goal == "buffer_intersection_analysis"
    assert [step.tool for step in plan.steps[-2:]] == ["intersect", "publish_result_geojson"]


def test_parse_colloquial_uploaded_points_query_for_immediate_map_display():
    query = "我传了两个点，帮我看看哪些在柏林里面，然后放地图上"
    intent = parse_user_intent(query, latest_uploaded_layer_key="upload_demo")
    plan = build_execution_plan(query, intent, latest_uploaded_layer_key="upload_demo")

    assert intent.task_type == "point_in_polygon_analysis"
    assert intent.publish_requested is True
    assert "upload_demo" in intent.target_layers
    assert "admin_boundaries" in intent.target_layers
    assert plan.goal == "point_in_polygon_analysis"
    assert [step.tool for step in plan.steps[:3]] == ["load_boundary", "load_layer", "point_in_polygon"]
