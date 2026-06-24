# +-------------------------------------------------------------------------
#
#   地理智能平台 - 降雨风险区划图第三方工具适配器
#
#   文件:       adapter.py
#
#   日期:       2026年06月23日
#   作者:       Codex
# --------------------------------------------------------------------------

"""Newmap wrapper for the copied rainfall risk map tool.

The Flask session cache and local path browser from the source app are not part
of the platform contract. This adapter exposes the same core workflow through
explicit NetCDF, boundary, threshold, and artifact inputs.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr

from gis_weather.third_party.common import choose_label_column, ensure_parent, finite_float, load_geodataframe


DEFAULT_THRESHOLDS = [
    {"label": "无雨/小雨", "min": 0.0, "max": 1.5, "color": "#f0f0f0"},
    {"label": "短时大雨", "min": 1.5, "max": 3.0, "color": "#a6d96a"},
    {"label": "短时暴雨", "min": 3.0, "max": 5.0, "color": "#1a9850"},
    {"label": "短时大暴雨", "min": 5.0, "max": 8.0, "color": "#fdae61"},
    {"label": "短时大暴雨~特大暴雨", "min": 8.0, "max": 12.0, "color": "#d73027"},
    {"label": "短时特大暴雨", "min": 12.0, "max": 999.0, "color": "#7a0177"},
]


@dataclass(frozen=True)
class RiskGrid:
    """Two-dimensional rainfall field and its coordinate metadata."""

    data: np.ndarray
    lats: np.ndarray
    lons: np.ndarray
    variable: str
    units: str
    long_name: str


def _coord_name(dataset: xr.Dataset, candidates: tuple[str, ...]) -> str:
    for name in candidates:
        if name in dataset.coords or name in dataset.variables:
            return name
    raise ValueError(f"NC 文件缺少坐标变量: {', '.join(candidates)}")


def _select_2d_grid(nc_path: Path, variable: str) -> RiskGrid:
    with xr.open_dataset(nc_path) as dataset:
        if variable not in dataset.data_vars:
            raise ValueError(f"NC 文件中不存在变量 {variable}")
        lat_name = _coord_name(dataset, ("lat", "latitude", "y"))
        lon_name = _coord_name(dataset, ("lon", "longitude", "x"))
        da = dataset[variable]
        for dim in list(da.dims):
            if dim not in {lat_name, lon_name}:
                da = da.isel({dim: 0})
        if lat_name not in da.dims or lon_name not in da.dims:
            raise ValueError(f"变量 {variable} 不能归一化为经纬度二维网格")
        da = da.transpose(lat_name, lon_name)
        data = np.asarray(da.values, dtype=float)
        lats = np.asarray(dataset[lat_name].values, dtype=float)
        lons = np.asarray(dataset[lon_name].values, dtype=float)
        attrs = dict(da.attrs)
    return RiskGrid(
        data=data,
        lats=lats,
        lons=lons,
        variable=variable,
        units=str(attrs.get("units") or ""),
        long_name=str(attrs.get("long_name") or attrs.get("standard_name") or variable),
    )


def inspect_rainfall_dataset(nc_path: Path) -> dict[str, Any]:
    """Return renderable variable candidates for the mini-app selector."""

    with xr.open_dataset(nc_path) as dataset:
        variables = []
        for name, da in dataset.data_vars.items():
            dims = list(da.dims)
            is_grid = any(dim in dims for dim in ("lat", "latitude", "y")) and any(
                dim in dims for dim in ("lon", "longitude", "x")
            )
            variables.append(
                {
                    "name": name,
                    "dims": dims,
                    "shape": list(da.shape),
                    "units": da.attrs.get("units"),
                    "longName": da.attrs.get("long_name") or da.attrs.get("standard_name"),
                    "mapReady": bool(is_grid),
                }
            )
    return {"variables": variables}


def normalize_thresholds(thresholds: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Validate and normalize threshold levels into a contiguous palette."""

    levels = thresholds or DEFAULT_THRESHOLDS
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(levels):
        try:
            label = str(item["label"])
            lower = float(item["min"])
            upper = float(item["max"])
            color = str(item["color"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"第 {index + 1} 个阈值配置无效") from exc
        if upper <= lower:
            raise ValueError(f"第 {index + 1} 个阈值上界必须大于下界")
        normalized.append({"label": label, "min": lower, "max": upper, "color": color})
    normalized.sort(key=lambda item: item["min"])
    return normalized


def _aggregate_by_region(
    grid: RiskGrid,
    boundary_path: Path,
    method: str,
    label_field: str | None,
) -> tuple[Any, np.ndarray, str | None]:
    import geopandas as gpd

    gdf = load_geodataframe(boundary_path)
    label_column = choose_label_column(list(gdf.columns), label_field)
    lon_grid, lat_grid = np.meshgrid(grid.lons, grid.lats)
    flat_values = grid.data.ravel()
    valid = np.isfinite(flat_values)
    points = gpd.GeoDataFrame(
        {"value": flat_values[valid]},
        geometry=gpd.points_from_xy(lon_grid.ravel()[valid], lat_grid.ravel()[valid]),
        crs="EPSG:4326",
    )
    joined = gpd.sjoin(points, gdf[["geometry"]].reset_index(), how="inner", predicate="within")
    values = np.full(len(gdf), np.nan, dtype=float)
    if not joined.empty:
        grouped = joined.groupby("index")["value"]
        if method == "max":
            series = grouped.max()
        elif method == "sum":
            series = grouped.sum()
        else:
            series = grouped.mean()
        for idx, value in series.items():
            values[int(idx)] = float(value)
    return gdf, values, label_column


def _classify(values: np.ndarray, thresholds: list[dict[str, Any]]) -> dict[str, int]:
    counts = {item["label"]: 0 for item in thresholds}
    for value in values:
        if not np.isfinite(value):
            continue
        for item in thresholds:
            if item["min"] <= float(value) < item["max"]:
                counts[item["label"]] += 1
                break
    return counts


def _risk_level(value: float | None, thresholds: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the configured risk level for a scalar region value."""

    if value is None or not np.isfinite(value):
        return None
    for item in thresholds:
        if item["min"] <= float(value) < item["max"]:
            return item
    return None


def _bounds_from_grid(grid: RiskGrid) -> list[float]:
    """Derive WGS84 bounds from the NC grid coordinates."""

    return [
        float(np.nanmin(grid.lons)),
        float(np.nanmin(grid.lats)),
        float(np.nanmax(grid.lons)),
        float(np.nanmax(grid.lats)),
    ]


def _coordinates_from_bounds(bounds: list[float]) -> list[list[float]]:
    """Return MapLibre image-source coordinates for west/south/east/north bounds."""

    west, south, east, north = bounds
    return [[west, north], [east, north], [east, south], [west, south]]


def _write_region_geojson(
    *,
    gdf: Any,
    values: np.ndarray,
    thresholds: list[dict[str, Any]],
    output_geojson: Path,
    label_column: str | None,
    variable: str,
    units: str,
    aggregation: str,
) -> None:
    """Persist a map-native regional risk layer beside the preview PNG."""

    ensure_parent(output_geojson)
    layer_gdf = gdf.copy()
    if layer_gdf.crs is not None and str(layer_gdf.crs).upper() != "EPSG:4326":
        layer_gdf = layer_gdf.to_crs("EPSG:4326")
    risk_values: list[float | None] = []
    risk_levels: list[str | None] = []
    risk_colors: list[str | None] = []
    risk_min: list[float | None] = []
    risk_max: list[float | None] = []
    for value in values:
        scalar = finite_float(value)
        level = _risk_level(scalar, thresholds)
        risk_values.append(scalar)
        risk_levels.append(str(level["label"]) if level else None)
        risk_colors.append(str(level["color"]) if level else None)
        risk_min.append(finite_float(level["min"]) if level else None)
        risk_max.append(finite_float(level["max"]) if level else None)
    layer_gdf["risk_value"] = risk_values
    layer_gdf["risk_level"] = risk_levels
    layer_gdf["risk_color"] = risk_colors
    layer_gdf["risk_min"] = risk_min
    layer_gdf["risk_max"] = risk_max
    layer_gdf["risk_variable"] = variable
    layer_gdf["risk_units"] = units
    layer_gdf["risk_aggregation"] = aggregation
    if label_column and label_column in layer_gdf.columns:
        layer_gdf["name"] = layer_gdf[label_column].astype(str)
    _normalize_geojson_properties(layer_gdf)
    output_geojson.write_text(layer_gdf.to_json(drop_id=True), encoding="utf-8")


def _normalize_geojson_properties(gdf: Any) -> None:
    """Convert GeoDataFrame properties to JSON-native values before to_json."""

    for column in gdf.columns:
        if column == gdf.geometry.name:
            continue
        gdf[column] = gdf[column].map(_json_native_value)


def _json_native_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, np.ndarray):
        return [_json_native_value(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return _json_native_value(value.item())
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, list | tuple):
        return [_json_native_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_native_value(item) for key, item in value.items()}
    return value


def _draw_map(
    *,
    grid: RiskGrid,
    gdf: Any | None,
    region_values: np.ndarray | None,
    thresholds: list[dict[str, Any]],
    output_png: Path,
    map_mode: str,
    title: str,
    label_column: str | None,
) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    from matplotlib.patches import Patch

    ensure_parent(output_png)
    colors = [item["color"] for item in thresholds]
    boundaries = [item["min"] for item in thresholds] + [thresholds[-1]["max"]]
    cmap = ListedColormap(colors)
    norm = BoundaryNorm(boundaries, cmap.N, clip=True)
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    if map_mode == "compare":
        fig, axes = plt.subplots(1, 2, figsize=(15, 6), constrained_layout=True)
    else:
        fig, axes = plt.subplots(1, 1, figsize=(9, 7), constrained_layout=True)
        axes = [axes]

    gradient_ax = axes[0] if map_mode in {"gradient", "compare"} else None
    regional_ax = axes[-1] if map_mode in {"regional", "compare"} else None

    if gradient_ax is not None:
        mesh = gradient_ax.pcolormesh(grid.lons, grid.lats, grid.data, cmap=cmap, norm=norm, shading="auto")
        if gdf is not None:
            gdf.boundary.plot(ax=gradient_ax, color="#1f2937", linewidth=0.6)
        gradient_ax.set_title(f"{title} - 网格渐变")
        fig.colorbar(mesh, ax=gradient_ax, shrink=0.8, label=grid.units or grid.variable)

    if regional_ax is not None:
        if gdf is None or region_values is None:
            raise ValueError("区划图模式需要边界文件")
        plot_gdf = gdf.copy()
        plot_gdf["_risk_value"] = region_values
        plot_gdf.plot(
            column="_risk_value",
            ax=regional_ax,
            cmap=cmap,
            norm=norm,
            edgecolor="#ffffff",
            linewidth=0.5,
            missing_kwds={"color": "#f3f4f6", "edgecolor": "#e5e7eb", "label": "无数据"},
        )
        if label_column:
            for _, row in plot_gdf.iterrows():
                point = row.geometry.representative_point()
                regional_ax.text(point.x, point.y, str(row[label_column]), fontsize=6, ha="center", va="center")
        regional_ax.set_title(f"{title} - 区划等级")
        legend_handles = [
            Patch(facecolor=item["color"], edgecolor="#ffffff", label=f"{item['label']} ({item['min']:g}~{item['max']:g})")
            for item in thresholds
        ]
        regional_ax.legend(handles=legend_handles, loc="lower left", fontsize=8, frameon=True)

    for ax in axes:
        ax.set_xlabel("")
        ax.set_ylabel("")
        ax.tick_params(labelsize=8)
        ax.set_aspect("equal", adjustable="box")

    fig.suptitle(title, fontsize=14, fontweight="bold")
    fig.savefig(output_png, dpi=160, facecolor="white", bbox_inches="tight")
    plt.close(fig)


def render_rainfall_risk_map(
    *,
    nc_path: Path,
    output_png: Path,
    variable: str,
    boundary_path: Path | None = None,
    output_geojson: Path | None = None,
    thresholds: list[dict[str, Any]] | None = None,
    map_mode: str = "regional",
    aggregation: str = "mean",
    label_field: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    """Render regional, gradient, or comparison rainfall risk map."""

    mode = map_mode.lower().strip()
    if mode not in {"regional", "gradient", "compare"}:
        raise ValueError(f"不支持的风险图模式: {map_mode}")
    if aggregation not in {"mean", "max", "sum"}:
        raise ValueError(f"不支持的区划聚合方法: {aggregation}")

    grid = _select_2d_grid(nc_path, variable)
    levels = normalize_thresholds(thresholds)
    gdf = None
    values = None
    label_column = None
    if boundary_path is not None:
        gdf, values, label_column = _aggregate_by_region(grid, boundary_path, aggregation, label_field)
    elif mode in {"regional", "compare"}:
        raise ValueError("regional/compare 模式必须提供边界文件 valueRef")

    output_title = title or f"{grid.long_name} 风险区划图"
    _draw_map(
        grid=grid,
        gdf=gdf,
        region_values=values,
        thresholds=levels,
        output_png=output_png,
        map_mode=mode,
        title=output_title,
        label_column=label_column,
    )

    finite = grid.data[np.isfinite(grid.data)]
    region_summary = None
    if values is not None:
        region_summary = {
            "counts": _classify(values, levels),
            "topRegions": [],
        }
        if gdf is not None:
            order = np.argsort(np.nan_to_num(values, nan=-np.inf))[::-1][:10]
            for idx in order:
                value = finite_float(values[idx])
                if value is None:
                    continue
                region_summary["topRegions"].append(
                    {
                        "name": str(gdf.iloc[int(idx)][label_column]) if label_column else str(idx),
                        "value": value,
                    }
                )

    if output_geojson is not None:
        if gdf is None or values is None:
            raise ValueError("输出区划 GeoJSON 需要边界文件和区划统计结果")
        _write_region_geojson(
            gdf=gdf,
            values=values,
            thresholds=levels,
            output_geojson=output_geojson,
            label_column=label_column,
            variable=grid.variable,
            units=grid.units,
            aggregation=aggregation,
        )

    bounds = _bounds_from_grid(grid)
    return {
        "variable": grid.variable,
        "units": grid.units,
        "longName": grid.long_name,
        "mapMode": mode,
        "aggregation": aggregation,
        "bounds": bounds,
        "coordinates": _coordinates_from_bounds(bounds),
        "thresholds": levels,
        "valueRange": {
            "min": finite_float(np.nanmin(finite)) if finite.size else None,
            "max": finite_float(np.nanmax(finite)) if finite.size else None,
            "mean": finite_float(np.nanmean(finite)) if finite.size else None,
        },
        "regionSummary": region_summary,
        "outputs": {
            "png": output_png.name,
            **({"geojson": output_geojson.name} if output_geojson is not None else {}),
        },
    }
