# +-------------------------------------------------------------------------
#
#   地理智能平台 - 区域累计面雨量排行表第三方工具适配器
#
#   文件:       adapter.py
#
#   日期:       2026年06月23日
#   作者:       Codex
# --------------------------------------------------------------------------

"""Newmap wrapper for the copied short-term rainfall table tool.

The source project used a Flask page, browser screenshots, and local directory
browsing. This adapter keeps the scientific calculation and table artifact
shape, while every input and output is supplied by the platform runtime.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr

from gis_meteorology.third_party.common import choose_label_column, ensure_parent, finite_float, load_geodataframe


DEFAULT_STYLE = {
    "titleText": "区县面雨量排行",
    "titleColor": "#2E72D6",
    "headerBg": "#E8F0FA",
    "headerColor": "#333333",
    "top3Bg": "#FFF2CC",
    "borderColor": "#D0D0D0",
    "dataColor": "#333333",
    "bgColor": "#FFFFFF",
}


TABLE_HEADERS = ["排行", "区县", "最大雨量(mm)", "面雨量(mm)", "覆盖格点数"]


def _format_time_from_name(filename: str, part_index: int) -> str:
    stem = Path(filename).stem
    parts = stem.split("_")
    token = parts[part_index] if len(parts) > part_index else parts[0]
    if len(token) >= 12 and token[:12].isdigit():
        return f"{token[0:4]}年{token[4:6]}月{token[6:8]}日{token[8:10]}时{token[10:12]}分"
    return token


def _format_time_from_stem(path: Path, part_index: int) -> str:
    return _format_time_from_name(path.name, part_index)


def _read_rate(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, str]:
    with xr.open_dataset(path) as dataset:
        lat_name = "lat" if "lat" in dataset.variables else "latitude"
        lon_name = "lon" if "lon" in dataset.variables else "longitude"
        if lat_name not in dataset.variables or lon_name not in dataset.variables:
            raise ValueError(f"NC 文件缺少经纬度坐标: {path.name}")
        if "QPF" in dataset.data_vars:
            rate_da = dataset["QPF"]
            data_type = "QPF"
        elif "dbz" in dataset.data_vars:
            dbz_da = dataset["dbz"]
            for dim in list(dbz_da.dims):
                if dim not in {lat_name, lon_name}:
                    dbz_da = dbz_da.max(dim=dim)
            dbz = np.asarray(dbz_da.values, dtype=float)
            z_linear = np.power(10.0, dbz / 10.0)
            rate = np.power(z_linear / 300.0, 1.0 / 1.4)
            rate = np.where(dbz > -10, rate, 0.0)
            return rate, np.asarray(dataset[lat_name].values, dtype=float), np.asarray(dataset[lon_name].values, dtype=float), "dbz"
        else:
            raise ValueError(f"无法识别降水变量，支持 QPF 或 dbz: {path.name}")

        da = rate_da
        for dim in list(da.dims):
            if dim not in {lat_name, lon_name}:
                da = da.isel({dim: 0})
        da = da.transpose(lat_name, lon_name)
        return (
            np.asarray(da.values, dtype=float),
            np.asarray(dataset[lat_name].values, dtype=float),
            np.asarray(dataset[lon_name].values, dtype=float),
            data_type,
        )


def _accumulate_rainfall(nc_paths: list[Path]) -> tuple[np.ndarray, np.ndarray, np.ndarray, str, list[str]]:
    if not nc_paths:
        raise ValueError("区域累计面雨量排行表需要至少一个 NC 文件")
    logs = [f"共 {len(nc_paths)} 个 NC 文件"]
    rain_sum = None
    lats = None
    lons = None
    data_type = None
    time_weight = 5.0 / 60.0
    for path in sorted(nc_paths, key=lambda item: item.name):
        rate, current_lats, current_lons, current_type = _read_rate(path)
        if rain_sum is None:
            rain_sum = np.zeros_like(rate, dtype=float)
            lats = current_lats
            lons = current_lons
            data_type = current_type
            logs.append(f"数据类型: {current_type}")
            logs.append(f"网格: lat[{current_lats[0]:.3f}~{current_lats[-1]:.3f}] lon[{current_lons[0]:.3f}~{current_lons[-1]:.3f}]")
        elif rain_sum.shape != rate.shape:
            raise ValueError(f"NC 网格尺寸不一致: {path.name}")
        rain_sum += rate * time_weight
    assert rain_sum is not None and lats is not None and lons is not None and data_type is not None
    finite = rain_sum[np.isfinite(rain_sum)]
    logs.append(f"降水累加完成: max={float(np.nanmax(finite)):.2f}mm mean={float(np.nanmean(finite)):.2f}mm")
    return rain_sum, lats, lons, data_type, logs


def _aggregate_county(
    *,
    rainfall: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
    boundary_path: Path,
    label_field: str | None,
) -> tuple[Any, str, Any]:
    import geopandas as gpd
    import pandas as pd

    gdf = load_geodataframe(boundary_path)
    label_column = choose_label_column(list(gdf.columns), label_field)
    if not label_column:
        raise ValueError("边界文件缺少可用于区划名称的字段")

    lon_grid, lat_grid = np.meshgrid(lons, lats)
    flat_values = rainfall.ravel()
    valid = np.isfinite(flat_values)
    points = gpd.GeoDataFrame(
        {
            "qpf": flat_values[valid],
            "lat": lat_grid.ravel()[valid],
            "cos_lat": np.cos(np.radians(lat_grid.ravel()[valid])),
        },
        geometry=gpd.points_from_xy(lon_grid.ravel()[valid], lat_grid.ravel()[valid]),
        crs="EPSG:4326",
    )
    joined = gpd.sjoin(
        points,
        gdf[[label_column, "geometry"]].reset_index(drop=True),
        how="inner",
        predicate="within",
    )
    if joined.empty:
        raise ValueError("NC 网格与区划边界没有空间相交")
    joined["qpf_w"] = joined["qpf"] * joined["cos_lat"]
    grouped = joined.groupby(label_column).agg(
        最大雨量=("qpf", "max"),
        面雨量分子=("qpf_w", "sum"),
        面雨量分母=("cos_lat", "sum"),
        覆盖格点数=("qpf", lambda series: int((series > 0).sum())),
    )
    grouped["面雨量"] = grouped["面雨量分子"] / grouped["面雨量分母"]
    grouped = grouped.drop(columns=["面雨量分子", "面雨量分母"]).sort_values("面雨量", ascending=False)
    grouped = grouped.reset_index()
    grouped.insert(0, "排行", np.arange(1, len(grouped) + 1))
    return gdf, label_column, pd.DataFrame(grouped)


def _format_rainfall(value: Any) -> str:
    # 面雨量样例里大量数值小于 0.1mm；PNG 使用三位小数和极小值标记，
    # 避免真实非零降水被旧模板的一位小数展示成 0.0。
    numeric = float(value)
    if 0 < abs(numeric) < 0.001:
        return "<0.001"
    return f"{numeric:.3f}"


def _table_row_values(row: Any) -> list[Any]:
    return [
        int(row["排行"]),
        row.iloc[1],
        float(row["最大雨量"]),
        float(row["面雨量"]),
        int(row["覆盖格点数"]),
    ]


def _write_excel(table, output_xlsx: Path, time_text: str) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    ensure_parent(output_xlsx)
    wb = Workbook()
    ws = wb.active
    ws.title = "区域累计面雨量排行表"

    title_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    header_fill = PatternFill(start_color="2E75B6", end_color="2E75B6", fill_type="solid")
    top_fill = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")
    thin = Side(style="thin", color="D0D0D0")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center")

    ws.merge_cells("A1:E1")
    ws["A1"] = "短时临近降水预报——区县区域累计面雨量排行表"
    ws["A1"].font = Font(name="Microsoft YaHei", size=16, bold=True, color="FFFFFF")
    ws["A1"].fill = title_fill
    ws["A1"].alignment = center

    ws.merge_cells("A2:E2")
    ws["A2"] = time_text
    ws["A2"].alignment = center
    ws["A2"].font = Font(name="Microsoft YaHei", size=11)

    for column, header in enumerate(TABLE_HEADERS, 1):
        cell = ws.cell(row=4, column=column, value=header)
        cell.font = Font(name="Microsoft YaHei", size=11, bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.border = border
        cell.alignment = center

    for row_index, row in table.iterrows():
        excel_row = row_index + 5
        values = _table_row_values(row)
        for column, value in enumerate(values, 1):
            cell = ws.cell(row=excel_row, column=column, value=value)
            cell.font = Font(name="Microsoft YaHei", size=10)
            cell.border = border
            cell.alignment = center
            if column in {3, 4}:
                cell.number_format = "0.000###"
            if row_index < 3:
                cell.fill = top_fill

    for column, width in enumerate([8, 20, 16, 16, 14], 1):
        ws.column_dimensions[chr(64 + column)].width = width
    ws.freeze_panes = "A5"
    wb.save(output_xlsx)


def _write_table_png(table, output_png: Path, time_text: str, top_n: int, style: dict[str, Any] | None) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ensure_parent(output_png)
    merged = dict(DEFAULT_STYLE)
    if style:
        merged.update({key: value for key, value in style.items() if value is not None})

    plot_table = table.head(top_n).reset_index(drop=True)
    figure_height = max(3.0, 1.7 + 0.38 * len(plot_table))
    fig, ax = plt.subplots(figsize=(5.8, figure_height))
    ax.axis("off")
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    rows = [TABLE_HEADERS]
    for _, row in plot_table.iterrows():
        rows.append([
            str(int(row["排行"])),
            str(row.iloc[1]),
            _format_rainfall(row["最大雨量"]),
            _format_rainfall(row["面雨量"]),
            str(int(row["覆盖格点数"])),
        ])

    table_artist = ax.table(
        cellText=rows,
        cellLoc="center",
        loc="upper center",
        colWidths=[0.12, 0.24, 0.22, 0.22, 0.18],
    )
    table_artist.auto_set_font_size(False)
    table_artist.set_fontsize(9)
    table_artist.scale(1, 1.35)

    for (row_index, _), cell in table_artist.get_celld().items():
        cell.set_edgecolor(str(merged["borderColor"]))
        if row_index == 0:
            cell.set_facecolor(str(merged["headerBg"]))
            cell.set_text_props(color=str(merged["headerColor"]), fontweight="bold")
        elif row_index <= 3:
            cell.set_facecolor(str(merged["top3Bg"]))
            cell.set_text_props(color=str(merged["dataColor"]))
        else:
            cell.set_facecolor(str(merged["bgColor"]))
            cell.set_text_props(color=str(merged["dataColor"]))

    ax.set_title(
        f"{merged['titleText']}\n{time_text}",
        fontsize=13,
        fontweight="bold",
        color=str(merged["titleColor"]),
        pad=8,
    )
    fig.savefig(output_png, dpi=180, bbox_inches="tight", facecolor=str(merged["bgColor"]), pad_inches=0.12)
    plt.close(fig)


def generate_area_rainfall_table(
    *,
    nc_paths: list[Path],
    nc_names: list[str] | None = None,
    boundary_path: Path,
    output_xlsx: Path,
    output_png: Path,
    top_n: int = 10,
    label_field: str | None = None,
    style: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generate XLSX and PNG area-rainfall ranking artifacts."""

    if top_n < 1 or top_n > 100:
        raise ValueError("top_n 必须在 1 到 100 之间")
    rainfall, lats, lons, data_type, logs = _accumulate_rainfall(nc_paths)
    _, label_column, table = _aggregate_county(
        rainfall=rainfall,
        lats=lats,
        lons=lons,
        boundary_path=boundary_path,
        label_field=label_field,
    )

    display_names = nc_names if nc_names and len(nc_names) == len(nc_paths) else [path.name for path in nc_paths]
    ordered_names = [name for _, name in sorted(zip(nc_paths, display_names), key=lambda item: item[1])]
    start_text = _format_time_from_name(ordered_names[0], 0)
    end_text = _format_time_from_name(ordered_names[-1], 1)
    time_text = f"{start_text}-{end_text}(单位:毫米)"
    _write_excel(table, output_xlsx, time_text)
    _write_table_png(table, output_png, time_text, top_n, style)

    top_rows = []
    for _, row in table.head(top_n).iterrows():
        top_rows.append(
            {
                "rank": int(row["排行"]),
                "region": str(row[label_column]),
                "areaRainfall": finite_float(row["面雨量"]),
                "maxRainfall": finite_float(row["最大雨量"]),
                "coveredGridCount": int(row["覆盖格点数"]),
            }
        )

    return {
        "dataType": data_type,
        "labelField": label_column,
        "timeText": time_text,
        "regionCount": int(len(table)),
        "topN": int(top_n),
        "topRows": top_rows,
        "logs": logs,
        "outputs": {
            "xlsx": output_xlsx.name,
            "png": output_png.name,
        },
    }
