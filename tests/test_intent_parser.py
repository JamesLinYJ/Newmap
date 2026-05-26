# +-------------------------------------------------------------------------
#
#   地理智能平台 - 意图解析测试
#
#   文件:       test_intent_parser.py
#
#   日期:       2026年05月14日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定用户自然语言到运行时意图的关键边界，尤其是地图跳转类请求。

from __future__ import annotations

from agent_core.parser import parse_user_intent


def test_map_navigation_query_extracts_place_anchor() -> None:
    # 地图跳转不是普通闲聊。
    #
    # 运行时需要明确 place_query，后续 Agent 才会调用 geocode_place 写回地图可用坐标。
    intent = parse_user_intent("跳转到北京")

    assert intent.task_type == "map_navigation"
    assert intent.place_query == "北京"
    assert intent.anchor_type == "poi"
