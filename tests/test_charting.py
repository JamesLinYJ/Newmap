# +-------------------------------------------------------------------------
#
#   地理智能平台 - 统计图表渲染测试
#
#   文件:       test_charting.py
#
#   日期:       2026年05月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证统计图表工具可按 Agent 指定尺寸生成 PNG，并返回稳定 metadata。

from __future__ import annotations

from PIL import Image

from tool_registry.charting import render_stat_chart


def test_render_stat_chart_respects_agent_selected_canvas_size(tmp_path) -> None:
    # 图表尺寸自由度。
    #
    # Agent 可以根据报告版式选择画布大小；渲染器必须保留该尺寸并写入 metadata。
    output = tmp_path / "chart.png"
    metadata = render_stat_chart(
        data=[
            {"name": "降雨>50mm", "value": 12},
            {"name": "降雨20-50mm", "value": 31},
            {"name": "降雨<20mm", "value": 8},
        ],
        output_path=output,
        chart_type="bar",
        title="降雨等级统计",
        x_field="name",
        y_field="value",
        unit="区",
        width=1440,
        height=900,
    )

    with Image.open(output) as image:
        assert image.size == (1440, 900)
    assert metadata["chartType"] == "bar"
    assert metadata["rowCount"] == 3
    assert metadata["valueRange"] == [8.0, 31.0]
