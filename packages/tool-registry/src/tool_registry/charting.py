# +-------------------------------------------------------------------------
#
#   地理智能平台 - 统计图表渲染
#
#   文件:       charting.py
#
#   日期:       2026年05月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 将 Agent 工具传入的统计数据渲染成审美一致的 PNG 图表 artifact。

from __future__ import annotations

import math
from pathlib import Path
from typing import Any


PALETTE = [
    (0, 104, 122),
    (212, 129, 54),
    (91, 141, 239),
    (76, 149, 108),
    (127, 91, 213),
    (224, 91, 91),
]
INK = (30, 41, 59)
MUTED = (100, 116, 139)
GRID = (226, 232, 240)
PANEL = (248, 250, 252)
WHITE = (255, 255, 255)


def render_stat_chart(
    *,
    data: list[dict[str, Any]],
    output_path: Path,
    chart_type: str,
    title: str,
    x_field: str | None = None,
    y_field: str | None = None,
    category_field: str | None = None,
    value_field: str | None = None,
    subtitle: str | None = None,
    unit: str | None = None,
    width: int = 1280,
    height: int = 780,
) -> dict[str, Any]:
    # 图表渲染入口。
    #
    # 工具 schema 允许 Agent 用自然统计表传值；这里统一解析字段、绘制风格，
    # 并返回 artifact metadata 需要的图表事实。
    if not data:
        raise ValueError("图表数据不能为空。")
    chart_kind = _normalize_chart_type(chart_type)
    resolved_category = category_field or x_field or _pick_text_field(data)
    resolved_value = value_field or y_field or _pick_numeric_field(data)
    if not resolved_category or not resolved_value:
        raise ValueError("生成图表至少需要一个分类/横轴字段和一个数值字段。")

    rows = _coerce_chart_rows(data, category_field=resolved_category, value_field=resolved_value)
    if not rows:
        raise ValueError("图表数据中没有可用数值。")

    image, draw = _new_canvas(width, height)
    fonts = _load_fonts()
    plot = _draw_header(draw, title=title, subtitle=subtitle, width=width, height=height, fonts=fonts)
    if chart_kind == "pie":
        _draw_pie_chart(draw, rows, plot=plot, fonts=fonts, unit=unit)
    elif chart_kind == "line":
        _draw_line_chart(draw, rows, plot=plot, fonts=fonts, unit=unit)
    elif chart_kind == "scatter":
        _draw_scatter_chart(draw, rows, plot=plot, fonts=fonts, unit=unit)
    else:
        _draw_bar_chart(draw, rows, plot=plot, fonts=fonts, unit=unit)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    values = [row["value"] for row in rows]
    return {
        "chartType": chart_kind,
        "title": title,
        "subtitle": subtitle,
        "xField": resolved_category,
        "yField": resolved_value,
        "unit": unit,
        "rowCount": len(rows),
        "valueRange": [float(min(values)), float(max(values))],
        "width": width,
        "height": height,
    }


def _normalize_chart_type(value: str) -> str:
    normalized = (value or "bar").strip().casefold()
    if normalized in {"柱状图", "bar", "bars", "column"}:
        return "bar"
    if normalized in {"折线图", "line", "trend"}:
        return "line"
    if normalized in {"饼图", "pie", "donut"}:
        return "pie"
    if normalized in {"散点图", "scatter", "point"}:
        return "scatter"
    return "bar"


def _pick_text_field(data: list[dict[str, Any]]) -> str | None:
    first = data[0]
    for key, value in first.items():
        if not _to_float(value)[0]:
            return str(key)
    return next(iter(first.keys()), None)


def _pick_numeric_field(data: list[dict[str, Any]]) -> str | None:
    for key in data[0].keys():
        if any(_to_float(row.get(key))[0] for row in data):
            return str(key)
    return None


def _coerce_chart_rows(data: list[dict[str, Any]], *, category_field: str, value_field: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(data):
        ok, value = _to_float(item.get(value_field))
        if not ok:
            continue
        label = str(item.get(category_field, f"项目 {index + 1}")).strip() or f"项目 {index + 1}"
        rows.append({"label": label, "value": value})
    return rows[:40]


def _to_float(value: Any) -> tuple[bool, float]:
    if isinstance(value, bool) or value is None:
        return False, 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False, 0.0
    if not math.isfinite(number):
        return False, 0.0
    return True, number


def _new_canvas(width: int, height: int):
    Image = _pil_image()
    ImageDraw = _pil_draw()
    image = Image.new("RGB", (width, height), PANEL)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((28, 28, width - 28, height - 28), radius=28, fill=WHITE, outline=(226, 232, 240), width=2)
    return image, draw


def _load_fonts() -> dict[str, Any]:
    ImageFont = _pil_font()
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]

    def font(size: int, *, bold: bool = False):
        for path in candidates:
            if not Path(path).exists():
                continue
            try:
                return ImageFont.truetype(path, size=size, index=1 if bold and path.endswith(".ttc") else 0)
            except Exception:
                continue
        return ImageFont.load_default()

    return {
        "title": font(38, bold=True),
        "subtitle": font(20),
        "axis": font(18),
        "label": font(17),
        "small": font(15),
    }


def _draw_header(draw: Any, *, title: str, subtitle: str | None, width: int, height: int, fonts: dict[str, Any]) -> tuple[int, int, int, int]:
    draw.text((72, 64), title[:64], fill=INK, font=fonts["title"])
    if subtitle:
        draw.text((72, 112), subtitle[:120], fill=MUTED, font=fonts["subtitle"])
    draw.line((72, 152, width - 72, 152), fill=GRID, width=2)
    return (100, 190, width - 96, height - 120)


def _draw_axes(draw: Any, plot: tuple[int, int, int, int], *, value_min: float, value_max: float, fonts: dict[str, Any], unit: str | None) -> tuple[float, float]:
    left, top, right, bottom = plot
    span = value_max - value_min
    if math.isclose(span, 0):
        span = max(abs(value_max), 1.0)
        value_min -= span * 0.1
        value_max += span * 0.1
    for index in range(6):
        ratio = index / 5
        y = bottom - (bottom - top) * ratio
        value = value_min + (value_max - value_min) * ratio
        draw.line((left, y, right, y), fill=GRID, width=1)
        label = _format_value(value, unit)
        draw.text((left - 86, y - 10), label, fill=MUTED, font=fonts["small"])
    draw.line((left, top, left, bottom), fill=(148, 163, 184), width=2)
    draw.line((left, bottom, right, bottom), fill=(148, 163, 184), width=2)
    return value_min, value_max


def _draw_bar_chart(draw: Any, rows: list[dict[str, Any]], *, plot: tuple[int, int, int, int], fonts: dict[str, Any], unit: str | None) -> None:
    left, top, right, bottom = plot
    values = [row["value"] for row in rows]
    value_min = min(0.0, min(values))
    value_max = max(values)
    value_min, value_max = _draw_axes(draw, plot, value_min=value_min, value_max=value_max, fonts=fonts, unit=unit)
    baseline = bottom if value_min >= 0 else bottom - (0 - value_min) / (value_max - value_min) * (bottom - top)
    gap = 16
    bar_width = max(12, (right - left - gap * (len(rows) - 1)) / max(len(rows), 1))
    for index, row in enumerate(rows):
        x0 = left + index * (bar_width + gap)
        x1 = x0 + bar_width
        ratio = (row["value"] - value_min) / (value_max - value_min)
        y = bottom - ratio * (bottom - top)
        color = PALETTE[index % len(PALETTE)]
        y0, y1 = sorted((baseline, y))
        draw.rounded_rectangle((x0, y0, x1, y1), radius=8, fill=color)
        draw.text((x0, y0 - 24), _format_value(row["value"], unit), fill=INK, font=fonts["small"])
        label = _short_label(row["label"], max_chars=10 if len(rows) <= 12 else 6)
        draw.text((x0, bottom + 18), label, fill=MUTED, font=fonts["small"])


def _draw_line_chart(draw: Any, rows: list[dict[str, Any]], *, plot: tuple[int, int, int, int], fonts: dict[str, Any], unit: str | None) -> None:
    left, top, right, bottom = plot
    values = [row["value"] for row in rows]
    value_min = min(values)
    value_max = max(values)
    value_min, value_max = _draw_axes(draw, plot, value_min=value_min, value_max=value_max, fonts=fonts, unit=unit)
    step = (right - left) / max(len(rows) - 1, 1)
    points = []
    for index, row in enumerate(rows):
        x = left + step * index
        y = bottom - (row["value"] - value_min) / (value_max - value_min) * (bottom - top)
        points.append((x, y))
    if len(points) >= 2:
        draw.line(points, fill=PALETTE[0], width=5, joint="curve")
    for index, ((x, y), row) in enumerate(zip(points, rows, strict=False)):
        draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=WHITE, outline=PALETTE[0], width=4)
        if index in {0, len(rows) - 1} or len(rows) <= 8:
            draw.text((x - 28, y - 34), _format_value(row["value"], unit), fill=INK, font=fonts["small"])
            draw.text((x - 30, bottom + 18), _short_label(row["label"], max_chars=8), fill=MUTED, font=fonts["small"])


def _draw_scatter_chart(draw: Any, rows: list[dict[str, Any]], *, plot: tuple[int, int, int, int], fonts: dict[str, Any], unit: str | None) -> None:
    left, top, right, bottom = plot
    values = [row["value"] for row in rows]
    value_min = min(values)
    value_max = max(values)
    value_min, value_max = _draw_axes(draw, plot, value_min=value_min, value_max=value_max, fonts=fonts, unit=unit)
    step = (right - left) / max(len(rows) - 1, 1)
    for index, row in enumerate(rows):
        x = left + step * index
        y = bottom - (row["value"] - value_min) / (value_max - value_min) * (bottom - top)
        color = PALETTE[index % len(PALETTE)]
        radius = 9
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color, outline=WHITE, width=3)
    if rows:
        draw.text((left, bottom + 18), _short_label(rows[0]["label"], max_chars=10), fill=MUTED, font=fonts["small"])
        draw.text((right - 80, bottom + 18), _short_label(rows[-1]["label"], max_chars=10), fill=MUTED, font=fonts["small"])


def _draw_pie_chart(draw: Any, rows: list[dict[str, Any]], *, plot: tuple[int, int, int, int], fonts: dict[str, Any], unit: str | None) -> None:
    left, top, right, bottom = plot
    total = sum(max(0, row["value"]) for row in rows)
    if total <= 0:
        raise ValueError("饼图需要正数值。")
    size = min(bottom - top, right - left) - 32
    cx = left + size / 2 + 16
    cy = top + size / 2 + 12
    box = (cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2)
    start = -90.0
    for index, row in enumerate(rows[:10]):
        angle = max(0, row["value"]) / total * 360
        color = PALETTE[index % len(PALETTE)]
        draw.pieslice(box, start=start, end=start + angle, fill=color, outline=WHITE, width=3)
        start += angle
    legend_x = left + size + 72
    legend_y = top + 24
    for index, row in enumerate(rows[:10]):
        color = PALETTE[index % len(PALETTE)]
        percent = max(0, row["value"]) / total * 100
        y = legend_y + index * 42
        draw.rounded_rectangle((legend_x, y + 5, legend_x + 24, y + 29), radius=6, fill=color)
        draw.text((legend_x + 36, y), _short_label(row["label"], max_chars=18), fill=INK, font=fonts["label"])
        draw.text((legend_x + 36, y + 22), f"{percent:.1f}% · {_format_value(row['value'], unit)}", fill=MUTED, font=fonts["small"])


def _format_value(value: float, unit: str | None) -> str:
    suffix = unit or ""
    if abs(value) >= 1000:
        text = f"{value:,.0f}"
    elif abs(value) >= 10:
        text = f"{value:.1f}".rstrip("0").rstrip(".")
    else:
        text = f"{value:.2f}".rstrip("0").rstrip(".")
    return f"{text}{suffix}"


def _short_label(value: str, *, max_chars: int) -> str:
    return value if len(value) <= max_chars else f"{value[:max_chars - 1]}…"


def _pil_image() -> Any:
    from PIL import Image
    return Image


def _pil_draw() -> Any:
    from PIL import ImageDraw
    return ImageDraw


def _pil_font() -> Any:
    from PIL import ImageFont
    return ImageFont
