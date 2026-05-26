# +-------------------------------------------------------------------------
#
#   地理智能平台 - 图层描述契约测试
#
#   文件:       test_layer_descriptor_contracts.py
#
#   日期:       2026年05月13日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定图层管理新增画像字段，以及工具层共享布尔解析边界。

from __future__ import annotations

from shared_types.schemas import LayerDescriptor
from tool_registry.registry import _coerce_tool_bool_arg


def test_layer_descriptor_serializes_management_profile() -> None:
    # 图层管理字段契约
    #
    # 前端按 camelCase 消费 bounds/propertySchema/updatedAt；后端不能退回旧的一行摘要形态。
    descriptor = LayerDescriptor(
        layer_key="managed_grid",
        name="Managed grid",
        source_type="managed",
        geometry_type="Polygon",
        description="Grid layer",
        feature_count=4,
        bounds=[0, 0, 1, 1],
        property_schema=[
            {
                "name": "id",
                "data_type": "number",
                "populated_count": 4,
                "sample_values": ["1", "2"],
            }
        ],
    )

    payload = descriptor.model_dump(mode="json")

    assert payload["layerKey"] == "managed_grid"
    assert payload["bounds"] == [0.0, 0.0, 1.0, 1.0]
    assert payload["propertySchema"][0]["dataType"] == "number"
    assert payload["propertySchema"][0]["populatedCount"] == 4


def test_registry_tool_bool_parser_handles_false_string() -> None:
    # 字符串布尔值不能用 Python truthiness 解释。
    #
    # 否则 "false" 会被误判为 True，导致工具参数边界和 UI 调试入口行为不一致。
    assert _coerce_tool_bool_arg("false", default=True) is False
    assert _coerce_tool_bool_arg("true", default=False) is True
    assert _coerce_tool_bool_arg(None, default=True) is True
