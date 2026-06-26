#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
低层反射率雷达拼接脚本

功能:
1. 扫描 data/*/*.bz2 雷达文件
2. 按时间容差匹配多站文件
3. 读取首层反射率并投影到统一经纬网格
4. 在重叠区域取最大反射率, 输出 .npz 和 .png
"""

from __future__ import annotations

import argparse
from functools import lru_cache
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable
import math
import struct

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib import font_manager
from matplotlib.path import Path as MplPath
from matplotlib.patches import PathPatch
import numpy as np
from scipy.ndimage import gaussian_filter, label, maximum_filter

from radar_decoder import decode_radar_file


TIME_FORMAT = "%Y%m%d%H%M%S"
KM_PER_DEGREE = 111.0
DEFAULT_MAX_RANGE_KM = 230.0
DEFAULT_BOUNDARY_GEOJSON = Path("data") / "boundaries" / "hangzhou_330100_full.json"
ALBERS_CENTRAL_MERIDIAN_DEG = 105.0
ALBERS_STANDARD_PARALLEL_1_DEG = 25.0
ALBERS_STANDARD_PARALLEL_2_DEG = 47.0
WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = 2 * WGS84_F - WGS84_F**2
SELECTED_FONT_NAME: str | None = None


@dataclass(frozen=True)
class ProductConfig:
    key: str
    field_key: str | None
    label: str
    short_label: str
    unit: str
    title: str
    colorbar_label: str
    levels: tuple[float, ...]
    colors: tuple[str, ...]
    min_valid: float
    min_display: float
    peak_enhance: bool = False


REFLECTIVITY_LEVELS = (5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70)
REFLECTIVITY_COLORS = (
    "#d8ebff",
    "#9cccf7",
    "#4f9ce9",
    "#20bcc8",
    "#16c565",
    "#7fd300",
    "#ffe100",
    "#ffb000",
    "#ff8a00",
    "#ff5a36",
    "#d7303f",
    "#f000b7",
    "#b57fed",
)

PRODUCT_CONFIGS: dict[str, ProductConfig] = {
    "reflectivity": ProductConfig(
        key="reflectivity",
        field_key="reflectivity",
        label="反射率场",
        short_label="反射率",
        unit="dBZ",
        title="浙江省反射率场拼图",
        colorbar_label="Reflectivity (dBZ)",
        levels=REFLECTIVITY_LEVELS,
        colors=REFLECTIVITY_COLORS,
        min_valid=0.0,
        min_display=10.0,
        peak_enhance=True,
    ),
    "velocity": ProductConfig(
        key="velocity",
        field_key="velocity",
        label="径向速度场",
        short_label="速度",
        unit="m/s",
        title="浙江省径向速度场拼图",
        colorbar_label="Radial velocity (m/s)",
        levels=(-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30),
        colors=(
            "#053061",
            "#2166ac",
            "#4393c3",
            "#92c5de",
            "#d1e5f0",
            "#f7f7f7",
            "#fddbc7",
            "#f4a582",
            "#d6604d",
            "#b2182b",
            "#7f0000",
            "#4d0011",
        ),
        min_valid=-80.0,
        min_display=-30.0,
    ),
    "spectrum_width": ProductConfig(
        key="spectrum_width",
        field_key="spectrum_width",
        label="谱宽场",
        short_label="谱宽",
        unit="m/s",
        title="浙江省谱宽场拼图",
        colorbar_label="Spectrum width (m/s)",
        levels=(0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15),
        colors=(
            "#f7fbff",
            "#deebf7",
            "#c6dbef",
            "#9ecae1",
            "#6baed6",
            "#4292c6",
            "#2171b5",
            "#08519c",
            "#54278f",
            "#2b0054",
        ),
        min_valid=0.1,
        min_display=0.5,
    ),
    "zdr": ProductConfig(
        key="zdr",
        field_key="zdr",
        label="差分反射率场",
        short_label="ZDR",
        unit="dB",
        title="浙江省差分反射率场拼图",
        colorbar_label="ZDR (dB)",
        levels=(-4, -2, -1, 0, 1, 2, 3, 4, 5, 6),
        colors=(
            "#313695",
            "#4575b4",
            "#abd9e9",
            "#ffffbf",
            "#fee090",
            "#fdae61",
            "#f46d43",
            "#d73027",
            "#a50026",
        ),
        min_valid=-8.0,
        min_display=-4.0,
    ),
    "cc": ProductConfig(
        key="cc",
        field_key="cc",
        label="相关系数场",
        short_label="CC",
        unit="",
        title="浙江省相关系数场拼图",
        colorbar_label="Correlation coefficient",
        levels=(0.70, 0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 0.99, 1.01),
        colors=(
            "#7f2704",
            "#a63603",
            "#d94801",
            "#f16913",
            "#fd8d3c",
            "#fdae6b",
            "#74c476",
            "#238b45",
        ),
        min_valid=0.70,
        min_display=0.70,
    ),
    "dp": ProductConfig(
        key="dp",
        field_key="dp",
        label="差分相位场",
        short_label="PhiDP",
        unit="deg",
        title="浙江省差分相位场拼图",
        colorbar_label="Differential phase (deg)",
        levels=(0, 30, 60, 90, 120, 150, 180, 240, 300, 360),
        colors=(
            "#f7fbff",
            "#deebf7",
            "#9ecae1",
            "#6baed6",
            "#3182bd",
            "#31a354",
            "#fed976",
            "#fd8d3c",
            "#e31a1c",
        ),
        min_valid=0.0,
        min_display=0.0,
    ),
    "kdp": ProductConfig(
        key="kdp",
        field_key="kdp",
        label="差分相移率场",
        short_label="KDP",
        unit="deg/km",
        title="浙江省差分相移率场拼图",
        colorbar_label="KDP (deg/km)",
        levels=(-3, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 8),
        colors=(
            "#313695",
            "#74add1",
            "#abd9e9",
            "#ffffbf",
            "#fee090",
            "#fdae61",
            "#f46d43",
            "#d73027",
            "#a50026",
        ),
        min_valid=-5.0,
        min_display=-3.0,
    ),
    "snrh": ProductConfig(
        key="snrh",
        field_key="snrh",
        label="信噪比场",
        short_label="SNRH",
        unit="dB",
        title="浙江省信噪比场拼图",
        colorbar_label="SNRH (dB)",
        levels=(0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50),
        colors=(
            "#f7fcf5",
            "#e5f5e0",
            "#c7e9c0",
            "#a1d99b",
            "#74c476",
            "#41ab5d",
            "#238b45",
            "#006d2c",
            "#00441b",
            "#002d12",
        ),
        min_valid=0.0,
        min_display=5.0,
    ),
    "echo_top": ProductConfig(
        key="echo_top",
        field_key=None,
        label="回波顶高场",
        short_label="顶高",
        unit="km",
        title="浙江省回波顶高场拼图",
        colorbar_label="Echo top height (km)",
        levels=(0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15),
        colors=(
            "#f7fbff",
            "#deebf7",
            "#c6dbef",
            "#9ecae1",
            "#6baed6",
            "#4292c6",
            "#238443",
            "#78c679",
            "#fdd049",
            "#fdae61",
            "#d7301f",
        ),
        min_valid=0.1,
        min_display=0.2,
    ),
}

PRODUCT_ALIASES = {
    "height": "echo_top",
    "wind": "velocity",
    "phidp": "dp",
}


def normalize_product_key(product: str) -> str:
    key = (product or "reflectivity").strip().lower()
    return PRODUCT_ALIASES.get(key, key if key in PRODUCT_CONFIGS else "reflectivity")


def get_product_config(product: str) -> ProductConfig:
    return PRODUCT_CONFIGS[normalize_product_key(product)]


def product_options() -> list[dict[str, str]]:
    return [
        {
            "key": config.key,
            "label": config.label,
            "short_label": config.short_label,
            "unit": config.unit,
        }
        for config in PRODUCT_CONFIGS.values()
    ]


@dataclass(frozen=True)
class BoundaryFeature:
    name: str | None
    centroid: tuple[float, float] | None
    rings: list[np.ndarray]


@dataclass(frozen=True)
class BoundaryData:
    features: list[BoundaryFeature]
    bounds: tuple[float, float, float, float] | None


_BOUNDARY_CACHE: dict[str, BoundaryData | None] = {}


@dataclass(frozen=True)
class RadarRecord:
    station: str
    timestamp: datetime
    path: Path


@dataclass
class MosaicGroup:
    target_time: datetime
    records: list[RadarRecord]
    max_delta_sec: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="低层反射率雷达拼接")
    parser.add_argument("--data-root", default="data", help="雷达数据根目录")
    parser.add_argument("--output-dir", default="outputs", help="输出目录")
    parser.add_argument(
        "--mode",
        choices=("single", "batch"),
        default="batch",
        help="single: 单时次, batch: 批处理全部时次",
    )
    parser.add_argument("--target-time", help="单时次目标时间, 格式 YYYYmmddHHMMSS")
    parser.add_argument(
        "--time-tolerance-sec",
        type=int,
        default=300,
        help="多站时间匹配容差, 秒",
    )
    parser.add_argument(
        "--grid-res-km",
        type=float,
        default=1.0,
        help="经纬网格分辨率, 公里",
    )
    parser.add_argument(
        "--min-dbz",
        type=float,
        default=0.0,
        help="最小有效反射率阈值",
    )
    parser.add_argument(
        "--boundary-path",
        "--boundary-geojson",
        dest="boundary_path",
        default=str(DEFAULT_BOUNDARY_GEOJSON),
        help="行政边界文件路径, 支持 GeoJSON 或 Shapefile(.shp)",
    )
    parser.add_argument(
        "--no-boundary",
        action="store_true",
        help="不叠加行政边界",
    )
    parser.add_argument(
        "--extent-mode",
        choices=("boundary", "mosaic"),
        default="boundary",
        help="出图范围: boundary 聚焦行政边界, mosaic 显示完整雷达拼接范围",
    )
    parser.add_argument(
        "--boundary-padding-degree",
        type=float,
        default=0.08,
        help="按行政边界聚焦时的经纬度外扩量",
    )
    parser.add_argument(
        "--strategy",
        choices=("max", "weighted", "strict", "quality"),
        default="max",
        help="拼图算法: max / weighted / strict / quality",
    )
    parser.add_argument(
        "--product",
        choices=tuple(PRODUCT_CONFIGS.keys()),
        default="reflectivity",
        help="拼图产品: reflectivity / velocity / spectrum_width / zdr / cc / dp / kdp / snrh / echo_top",
    )
    parser.add_argument(
        "--level-index",
        type=int,
        default=0,
        help="拼图高度层索引, 默认第1层(0)",
    )
    return parser.parse_args()


def configure_matplotlib_fonts() -> None:
    global SELECTED_FONT_NAME
    font_files = [
        Path(r"C:\Windows\Fonts\NotoSansSC-VF.ttf"),
        Path(r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
    ]
    for font_file in font_files:
        if font_file.exists():
            font_manager.fontManager.addfont(str(font_file))

    preferred_fonts = ["Noto Sans SC", "Microsoft YaHei", "SimHei", "DengXian", "SimSun"]
    available = {font.name for font in font_manager.fontManager.ttflist}
    for font_name in preferred_fonts:
        if font_name in available:
            plt.rcParams["font.sans-serif"] = [font_name]
            SELECTED_FONT_NAME = font_name
            break
    if SELECTED_FONT_NAME is None:
        SELECTED_FONT_NAME = "DejaVu Sans"
    plt.rcParams["axes.unicode_minus"] = False


@lru_cache(maxsize=128)
def decode_radar_file_cached(filepath: str):
    return decode_radar_file(filepath)


def parse_record(file_path: Path) -> RadarRecord:
    parts = file_path.name.split("_")
    if len(parts) < 5:
        raise ValueError(f"无法从文件名解析时间戳: {file_path.name}")
    timestamp = datetime.strptime(parts[4], TIME_FORMAT)
    return RadarRecord(station=file_path.parent.name, timestamp=timestamp, path=file_path)


def scan_records(data_root: Path) -> list[RadarRecord]:
    records = []
    for file_path in sorted(data_root.glob("*/*.bz2")):
        records.append(parse_record(file_path))
    if not records:
        raise FileNotFoundError(f"未在 {data_root} 下找到雷达文件")
    return records


def group_records_by_station(records: Iterable[RadarRecord]) -> dict[str, list[RadarRecord]]:
    grouped: dict[str, list[RadarRecord]] = {}
    for record in sorted(records, key=lambda item: (item.station, item.timestamp)):
        grouped.setdefault(record.station, []).append(record)
    return grouped


def find_nearest_record(
    records: list[RadarRecord], target_time: datetime, tolerance_sec: int
) -> tuple[RadarRecord | None, int | None]:
    if not records:
        return None, None
    best = min(records, key=lambda item: abs((item.timestamp - target_time).total_seconds()))
    delta_sec = int(abs((best.timestamp - target_time).total_seconds()))
    if delta_sec > tolerance_sec:
        return None, None
    return best, delta_sec


def build_single_group(
    station_records: dict[str, list[RadarRecord]],
    target_time: datetime,
    tolerance_sec: int,
) -> MosaicGroup:
    selected = []
    deltas = []
    for station in sorted(station_records):
        record, delta_sec = find_nearest_record(station_records[station], target_time, tolerance_sec)
        if record is None:
            continue
        selected.append(record)
        deltas.append(delta_sec)
    if not selected:
        raise ValueError(
            f"目标时间 {target_time.strftime(TIME_FORMAT)} 在 {tolerance_sec} 秒容差内没有匹配文件"
        )
    return MosaicGroup(target_time=target_time, records=selected, max_delta_sec=max(deltas, default=0))


def build_batch_groups(
    station_records: dict[str, list[RadarRecord]],
    tolerance_sec: int,
) -> list[MosaicGroup]:
    anchor_station = max(
        station_records.items(),
        key=lambda item: (len(item[1]), item[0]),
    )[0]
    groups: list[MosaicGroup] = []
    seen_signatures: set[tuple[str, ...]] = set()
    used_paths: set[str] = set()

    for anchor_record in station_records[anchor_station]:
        target_time = anchor_record.timestamp
        group = build_single_group(station_records, target_time, tolerance_sec)
        signature = tuple(sorted(str(record.path) for record in group.records))
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        used_paths.update(signature)
        groups.append(group)

    for station in sorted(station_records):
        for record in station_records[station]:
            path_str = str(record.path)
            if path_str in used_paths:
                continue
            group = build_single_group(station_records, record.timestamp, tolerance_sec)
            signature = tuple(sorted(str(item.path) for item in group.records))
            if signature in seen_signatures:
                continue
            seen_signatures.add(signature)
            used_paths.update(signature)
            groups.append(group)

    return sorted(groups, key=lambda item: item.target_time)


def build_output_stem(
    group: MosaicGroup,
    product: str = "reflectivity",
    strategy: str = "max",
    level_index: int = 0,
) -> str:
    stations = "-".join(record.station for record in sorted(group.records, key=lambda item: item.station))
    product_key = normalize_product_key(product)
    return f"mosaic_{group.target_time.strftime(TIME_FORMAT)}_{product_key}_L{level_index + 1}_{strategy}_{stations}"


def compute_grid(
    records: list[RadarRecord],
    grid_res_km: float,
    range_km: float = DEFAULT_MAX_RANGE_KM,
) -> tuple[np.ndarray, np.ndarray]:
    min_lat = min_lon = float("inf")
    max_lat = max_lon = float("-inf")

    for record in records:
        decoded = decode_radar_file_cached(str(record.path))
        if decoded is None:
            continue
        lat0 = float(decoded["latitude"])
        lon0 = float(decoded["longitude"])
        lat_pad = range_km / KM_PER_DEGREE
        lon_pad = range_km / (KM_PER_DEGREE * max(math.cos(math.radians(lat0)), 1e-6))
        min_lat = min(min_lat, lat0 - lat_pad)
        max_lat = max(max_lat, lat0 + lat_pad)
        min_lon = min(min_lon, lon0 - lon_pad)
        max_lon = max(max_lon, lon0 + lon_pad)

    if not math.isfinite(min_lat):
        raise ValueError("无法从匹配文件中计算拼接网格范围")

    lat_step = grid_res_km / KM_PER_DEGREE
    mean_lat = (min_lat + max_lat) / 2.0
    lon_step = grid_res_km / (KM_PER_DEGREE * max(math.cos(math.radians(mean_lat)), 1e-6))

    lat_values = np.arange(min_lat, max_lat + lat_step, lat_step, dtype=np.float64)
    lon_values = np.arange(min_lon, max_lon + lon_step, lon_step, dtype=np.float64)
    return np.meshgrid(lon_values, lat_values)


def polar_to_latlon(
    field: np.ndarray,
    lat0: float,
    lon0: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    azimuth_deg = np.arange(field.shape[0], dtype=np.float64)
    range_km = np.arange(field.shape[1], dtype=np.float64)

    azimuth_rad = np.deg2rad(azimuth_deg)[:, None]
    radial_km = np.broadcast_to(range_km[None, :], field.shape)

    dx = radial_km * np.sin(azimuth_rad)
    dy = radial_km * np.cos(azimuth_rad)
    lat = lat0 + dy / KM_PER_DEGREE
    lon = lon0 + dx / (KM_PER_DEGREE * max(math.cos(math.radians(lat0)), 1e-6))
    return lat, lon, field


def accumulate_to_grid(
    mosaic: np.ndarray,
    hit_count: np.ndarray,
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    sample_lon: np.ndarray,
    sample_lat: np.ndarray,
    values: np.ndarray,
    min_dbz: float,
) -> None:
    lon_axis = grid_lon[0, :]
    lat_axis = grid_lat[:, 0]
    lon_step = lon_axis[1] - lon_axis[0]
    lat_step = lat_axis[1] - lat_axis[0]

    valid_mask = np.isfinite(values) & (values >= min_dbz)
    valid_mask &= (sample_lon >= lon_axis[0]) & (sample_lon <= lon_axis[-1])
    valid_mask &= (sample_lat >= lat_axis[0]) & (sample_lat <= lat_axis[-1])
    if not np.any(valid_mask):
        return

    sample_lon = sample_lon[valid_mask]
    sample_lat = sample_lat[valid_mask]
    sample_values = values[valid_mask]

    ix = np.rint((sample_lon - lon_axis[0]) / lon_step).astype(np.int64)
    iy = np.rint((sample_lat - lat_axis[0]) / lat_step).astype(np.int64)

    inside = (ix >= 0) & (ix < mosaic.shape[1]) & (iy >= 0) & (iy < mosaic.shape[0])
    if not np.any(inside):
        return

    flat_index = iy[inside] * mosaic.shape[1] + ix[inside]
    flat_values = sample_values[inside]
    np.maximum.at(mosaic.ravel(), flat_index, flat_values)
    np.add.at(hit_count.ravel(), flat_index, 1)


def accumulate_weighted_to_grid(
    value_sum: np.ndarray,
    weight_sum: np.ndarray,
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    sample_lon: np.ndarray,
    sample_lat: np.ndarray,
    values: np.ndarray,
    min_dbz: float,
    lat0: float,
    lon0: float,
) -> None:
    lon_axis = grid_lon[0, :]
    lat_axis = grid_lat[:, 0]
    lon_step = lon_axis[1] - lon_axis[0]
    lat_step = lat_axis[1] - lat_axis[0]

    valid_mask = np.isfinite(values) & (values >= min_dbz)
    valid_mask &= (sample_lon >= lon_axis[0]) & (sample_lon <= lon_axis[-1])
    valid_mask &= (sample_lat >= lat_axis[0]) & (sample_lat <= lat_axis[-1])
    if not np.any(valid_mask):
        return

    sample_lon = sample_lon[valid_mask]
    sample_lat = sample_lat[valid_mask]
    sample_values = values[valid_mask]

    ix = np.rint((sample_lon - lon_axis[0]) / lon_step).astype(np.int64)
    iy = np.rint((sample_lat - lat_axis[0]) / lat_step).astype(np.int64)

    inside = (ix >= 0) & (ix < value_sum.shape[1]) & (iy >= 0) & (iy < value_sum.shape[0])
    if not np.any(inside):
        return

    sample_lon = sample_lon[inside]
    sample_lat = sample_lat[inside]
    sample_values = sample_values[inside]
    ix = ix[inside]
    iy = iy[inside]

    dx = (sample_lon - lon0) * KM_PER_DEGREE * math.cos(math.radians(lat0))
    dy = (sample_lat - lat0) * KM_PER_DEGREE
    distance = np.hypot(dx, dy)
    weights = 1.0 / np.maximum(distance + 5.0, 5.0)

    flat_index = iy * value_sum.shape[1] + ix
    np.add.at(value_sum.ravel(), flat_index, sample_values * weights)
    np.add.at(weight_sum.ravel(), flat_index, weights)


def build_coverage_mask(
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    radar_sites: list[tuple[float, float]],
    range_km: float = DEFAULT_MAX_RANGE_KM,
) -> np.ndarray:
    coverage = np.zeros(grid_lon.shape, dtype=bool)
    for lat0, lon0 in radar_sites:
        dx = (grid_lon - lon0) * KM_PER_DEGREE * math.cos(math.radians(lat0))
        dy = (grid_lat - lat0) * KM_PER_DEGREE
        coverage |= np.hypot(dx, dy) <= range_km
    return coverage


def build_display_field(
    mosaic: np.ndarray,
    coverage_mask: np.ndarray,
    min_display_dbz: float,
    peak_enhance: bool = True,
) -> np.ndarray:
    display = mosaic.astype(np.float32).copy()
    display[display < min_display_dbz] = np.nan

    finite = np.isfinite(display)
    if not np.any(finite):
        return display

    values = np.where(finite, display, 0.0)
    weights = finite.astype(np.float32)

    smooth_values = gaussian_filter(values, sigma=1.0)
    smooth_weights = gaussian_filter(weights, sigma=1.0)
    smooth = np.divide(
        smooth_values,
        smooth_weights,
        out=np.full_like(smooth_values, np.nan, dtype=np.float32),
        where=smooth_weights > 1e-4,
    )

    local_peak = maximum_filter(np.where(finite, display, -np.inf), size=3, mode="nearest")
    hole_mask = (~finite) & coverage_mask & (smooth_weights > 0.08)
    display[hole_mask] = smooth[hole_mask]

    finite_after_fill = np.isfinite(display)
    if peak_enhance:
        enhanced = np.where(
            finite_after_fill,
            np.maximum(display, np.where(np.isfinite(local_peak), local_peak - 1.5, display)),
            np.nan,
        )
    else:
        enhanced = np.where(finite_after_fill, display, np.nan)

    enhanced = np.where(np.isfinite(enhanced), gaussian_filter(np.nan_to_num(enhanced, nan=0.0), sigma=0.45), np.nan)
    enhanced_weights = gaussian_filter(np.isfinite(display).astype(np.float32), sigma=0.45)
    enhanced = np.divide(
        enhanced,
        enhanced_weights,
        out=np.full_like(enhanced, np.nan, dtype=np.float32),
        where=enhanced_weights > 1e-4,
    )
    enhanced[~coverage_mask] = np.nan
    enhanced[enhanced < min_display_dbz] = np.nan
    enhanced = remove_small_echoes(enhanced, min_size=6)
    return enhanced


def remove_small_echoes(field: np.ndarray, min_size: int) -> np.ndarray:
    valid = np.isfinite(field)
    if not np.any(valid):
        return field
    labels, num = label(valid)
    if num == 0:
        return field
    counts = np.bincount(labels.ravel())
    small_labels = np.where(counts < min_size)[0]
    if len(small_labels) <= 1:
        return field
    cleaned = field.copy()
    remove_mask = np.isin(labels, small_labels[small_labels != 0])
    cleaned[remove_mask] = np.nan
    return cleaned


def select_product_field(
    decoded: dict,
    product: str,
    level_index: int,
) -> np.ndarray:
    config = get_product_config(product)
    if config.key == "echo_top":
        ref3d = np.asarray(decoded["reflectivity"], dtype=np.float32)
        elevations = np.asarray(decoded.get("elevation_ref", []), dtype=np.float32)
        if ref3d.ndim != 3 or ref3d.shape[0] == 0 or elevations.size == 0:
            raise ValueError("回波顶高场数据无效")

        layer_count = min(ref3d.shape[0], elevations.size)
        range_km = np.arange(ref3d.shape[2], dtype=np.float32)[None, None, :]
        heights = range_km * np.sin(np.deg2rad(elevations[:layer_count]))[:, None, None]
        valid = ref3d[:layer_count] >= 10.0
        echo_top = np.where(valid, heights, -np.inf).max(axis=0)
        echo_top[~np.isfinite(echo_top)] = np.nan
        return echo_top.astype(np.float32)

    if config.field_key is None:
        raise ValueError(f"产品 {product} 未配置原始字段")

    field3d = np.asarray(decoded[config.field_key], dtype=np.float32)
    if field3d.ndim != 3 or field3d.shape[0] == 0:
        raise ValueError(f"产品 {product} 数据无效")

    safe_index = min(max(level_index, 0), field3d.shape[0] - 1)
    field = field3d[safe_index].astype(np.float32, copy=True)
    if config.key != "reflectivity":
        ref3d = np.asarray(decoded.get("reflectivity", []), dtype=np.float32)
        if ref3d.ndim == 3 and ref3d.shape[0] > 0:
            ref_index = min(max(level_index, 0), ref3d.shape[0] - 1)
            ref_gate = ref3d[ref_index]
            if ref_gate.shape == field.shape:
                field[ref_gate < 5.0] = np.nan
    return field


def get_radar_colormap(product: str = "reflectivity") -> tuple[ListedColormap, BoundaryNorm, list[float]]:
    config = get_product_config(product)
    levels = list(config.levels)
    cmap = ListedColormap(list(config.colors))
    cmap.set_bad((1.0, 1.0, 1.0, 0.0))
    norm = BoundaryNorm(levels, cmap.N)
    return cmap, norm, levels


def iter_geojson_rings(geometry: dict) -> Iterable[np.ndarray]:
    geom_type = geometry.get("type")
    coordinates = geometry.get("coordinates", [])
    if geom_type == "Polygon":
        polygons = [coordinates]
    elif geom_type == "MultiPolygon":
        polygons = coordinates
    else:
        return

    for polygon in polygons:
        for ring in polygon:
            arr = np.asarray(ring, dtype=np.float64)
            if arr.ndim == 2 and arr.shape[0] >= 2 and arr.shape[1] >= 2:
                yield arr[:, :2]


def _wgs84_q(phi_rad: np.ndarray | float) -> np.ndarray | float:
    e = math.sqrt(WGS84_E2)
    sin_phi = np.sin(phi_rad)
    return (1.0 - WGS84_E2) * (
        sin_phi / (1.0 - WGS84_E2 * sin_phi * sin_phi)
        - (1.0 / (2.0 * e)) * np.log((1.0 - e * sin_phi) / (1.0 + e * sin_phi))
    )


def _wgs84_m(phi_rad: np.ndarray | float) -> np.ndarray | float:
    sin_phi = np.sin(phi_rad)
    return np.cos(phi_rad) / np.sqrt(1.0 - WGS84_E2 * sin_phi * sin_phi)


def albers_to_wgs84(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lon0 = math.radians(ALBERS_CENTRAL_MERIDIAN_DEG)
    phi1 = math.radians(ALBERS_STANDARD_PARALLEL_1_DEG)
    phi2 = math.radians(ALBERS_STANDARD_PARALLEL_2_DEG)
    phi0 = 0.0

    m1 = _wgs84_m(phi1)
    m2 = _wgs84_m(phi2)
    q1 = _wgs84_q(phi1)
    q2 = _wgs84_q(phi2)
    n = (m1 * m1 - m2 * m2) / (q2 - q1)
    c = m1 * m1 + n * q1
    q0 = _wgs84_q(phi0)
    rho0 = WGS84_A * np.sqrt(c - n * q0) / n
    rho = np.sqrt(x * x + (rho0 - y) ** 2)
    theta = np.arctan2(x, rho0 - y)
    q = (c - (rho * n / WGS84_A) ** 2) / n

    q_min = float(_wgs84_q(-math.pi / 2 + 1e-10))
    q_max = float(_wgs84_q(math.pi / 2 - 1e-10))
    q = np.clip(q, q_min, q_max)
    low = np.full_like(q, -math.pi / 2 + 1e-10, dtype=np.float64)
    high = np.full_like(q, math.pi / 2 - 1e-10, dtype=np.float64)
    for _ in range(50):
        mid = (low + high) / 2.0
        mid_q = _wgs84_q(mid)
        mask = mid_q < q
        low = np.where(mask, mid, low)
        high = np.where(mask, high, mid)
    phi = (low + high) / 2.0

    lon = lon0 + theta / n
    return np.rad2deg(lon), np.rad2deg(phi)


def compute_centroid(rings: list[np.ndarray]) -> tuple[float, float] | None:
    points = [ring for ring in rings if ring.size]
    if not points:
        return None
    merged = np.vstack(points)
    return float(np.nanmean(merged[:, 0])), float(np.nanmean(merged[:, 1]))


def load_geojson_boundary(boundary_path: Path) -> BoundaryData | None:
    if not boundary_path.exists():
        return None

    with boundary_path.open("r", encoding="utf-8") as file:
        geojson = json.load(file)

    features: list[BoundaryFeature] = []
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")
    for feature in geojson.get("features", []):
        geometry = feature.get("geometry") or {}
        rings = [ring for ring in iter_geojson_rings(geometry)]
        if not rings:
            continue
        for ring in rings:
            min_lon = min(min_lon, float(np.nanmin(ring[:, 0])))
            max_lon = max(max_lon, float(np.nanmax(ring[:, 0])))
            min_lat = min(min_lat, float(np.nanmin(ring[:, 1])))
            max_lat = max(max_lat, float(np.nanmax(ring[:, 1])))

        properties = feature.get("properties") or {}
        centroid = properties.get("centroid") or properties.get("center")
        centroid_xy = None
        if centroid and len(centroid) >= 2:
            centroid_xy = (float(centroid[0]), float(centroid[1]))
        elif rings:
            centroid_xy = compute_centroid(rings)

        features.append(
            BoundaryFeature(
                name=str(properties.get("name")) if properties.get("name") else None,
                centroid=centroid_xy,
                rings=rings,
            )
        )

    bounds = None
    if all(math.isfinite(value) for value in (min_lon, max_lon, min_lat, max_lat)):
        bounds = (min_lon, max_lon, min_lat, max_lat)
    return BoundaryData(features=features, bounds=bounds)


def load_dbf_records(dbf_path: Path) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    with dbf_path.open("rb") as file:
        header = file.read(32)
        record_count = int.from_bytes(header[4:8], "little")
        header_length = int.from_bytes(header[8:10], "little")
        record_length = int.from_bytes(header[10:12], "little")
        fields: list[tuple[str, int]] = []

        while True:
            desc = file.read(32)
            if not desc or desc[0] == 0x0D:
                break
            name = desc[:11].split(b"\x00", 1)[0].decode("ascii", errors="ignore")
            fields.append((name, desc[16]))

        file.seek(header_length)
        for _ in range(record_count):
            record = file.read(record_length)
            if not record or record[:1] == b"*":
                continue
            pos = 1
            row: dict[str, str] = {}
            for name, length in fields:
                raw = record[pos : pos + length]
                pos += length
                row[name] = raw.decode("utf-8", errors="replace").strip()
            records.append(row)
    return records


def load_shapefile_boundary(boundary_path: Path) -> BoundaryData | None:
    if not boundary_path.exists():
        return None

    dbf_path = boundary_path.with_suffix(".dbf")
    names = load_dbf_records(dbf_path) if dbf_path.exists() else []
    features: list[BoundaryFeature] = []
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")

    with boundary_path.open("rb") as file:
        header = file.read(100)
        shape_type = int.from_bytes(header[32:36], "little")
        if shape_type != 5:
            raise ValueError(f"暂只支持 Polygon shapefile, 当前类型: {shape_type}")

        feature_idx = 0
        while True:
            record_header = file.read(8)
            if len(record_header) < 8:
                break
            content_length_words = int.from_bytes(record_header[4:8], "big")
            content = file.read(content_length_words * 2)
            if len(content) < 44:
                continue

            rec_type = int.from_bytes(content[0:4], "little")
            if rec_type != 5:
                continue

            num_parts = int.from_bytes(content[36:40], "little")
            num_points = int.from_bytes(content[40:44], "little")
            parts = [int.from_bytes(content[44 + i * 4 : 48 + i * 4], "little") for i in range(num_parts)]
            points_offset = 44 + num_parts * 4
            coords = np.frombuffer(content, dtype="<f8", count=num_points * 2, offset=points_offset).reshape(num_points, 2)
            lon, lat = albers_to_wgs84(coords[:, 0], coords[:, 1])
            lonlat = np.column_stack([lon, lat])

            rings: list[np.ndarray] = []
            for part_idx, start in enumerate(parts):
                end = parts[part_idx + 1] if part_idx + 1 < len(parts) else num_points
                ring = lonlat[start:end]
                if ring.shape[0] < 2:
                    continue
                rings.append(ring)
                min_lon = min(min_lon, float(np.nanmin(ring[:, 0])))
                max_lon = max(max_lon, float(np.nanmax(ring[:, 0])))
                min_lat = min(min_lat, float(np.nanmin(ring[:, 1])))
                max_lat = max(max_lat, float(np.nanmax(ring[:, 1])))

            if not rings:
                feature_idx += 1
                continue

            props = names[feature_idx] if feature_idx < len(names) else {}
            name = props.get("FNAME") or props.get("NAME") or props.get("CLASID")
            centroid = compute_centroid(rings)
            features.append(BoundaryFeature(name=name or None, centroid=centroid, rings=rings))
            feature_idx += 1

    bounds = None
    if all(math.isfinite(value) for value in (min_lon, max_lon, min_lat, max_lat)):
        bounds = (min_lon, max_lon, min_lat, max_lat)
    return BoundaryData(features=features, bounds=bounds)


def load_boundary_data(boundary_path: Path | None) -> BoundaryData | None:
    if boundary_path is None:
        return None
    cache_key = str(boundary_path.resolve())
    if cache_key in _BOUNDARY_CACHE:
        return _BOUNDARY_CACHE[cache_key]

    if not boundary_path.exists():
        print(f"[WARN] 行政边界文件不存在, 跳过叠加: {boundary_path}")
        _BOUNDARY_CACHE[cache_key] = None
        return None

    suffix = boundary_path.suffix.lower()
    if suffix in {".json", ".geojson"}:
        data = load_geojson_boundary(boundary_path)
    elif suffix == ".shp":
        data = load_shapefile_boundary(boundary_path)
    else:
        raise ValueError(f"不支持的边界文件格式: {boundary_path.suffix}")

    _BOUNDARY_CACHE[cache_key] = data
    return data


def plot_boundary(ax: plt.Axes, boundary_data: BoundaryData, show_labels: bool = True) -> None:
    for feature in boundary_data.features:
        for ring in feature.rings:
            if ring.shape[0] < 3:
                continue
            span = max(float(np.ptp(ring[:, 0])), float(np.ptp(ring[:, 1])))
            if span < 0.015 and ring.shape[0] < 220:
                continue

            step = 1
            if ring.shape[0] > 2200:
                step = 8
            elif ring.shape[0] > 1400:
                step = 6
            elif ring.shape[0] > 800:
                step = 4
            elif ring.shape[0] > 400:
                step = 3
            elif ring.shape[0] > 180:
                step = 2

            plot_ring = ring[::step]
            if plot_ring.shape[0] < 3:
                continue
            if not np.allclose(plot_ring[-1], ring[-1]):
                plot_ring = np.vstack([plot_ring, ring[-1]])

            ax.plot(
                plot_ring[:, 0],
                plot_ring[:, 1],
                color="#a9b4c3",
                linewidth=0.34,
                alpha=0.55,
                solid_capstyle="round",
                solid_joinstyle="round",
                antialiased=True,
                zorder=7,
            )
        if show_labels and feature.name and feature.centroid is not None:
            ax.text(
                feature.centroid[0],
                feature.centroid[1],
                feature.name,
                color="#475569",
                fontsize=7,
                ha="center",
                va="center",
                alpha=0.7,
                zorder=8,
            )


def create_mosaic(
    group: MosaicGroup,
    grid_res_km: float,
    min_dbz: float,
    product: str = "reflectivity",
    level_index: int = 0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str], list[str], list[str]]:
    config = get_product_config(product)
    min_valid = max(min_dbz, config.min_valid) if config.key == "reflectivity" else config.min_valid
    grid_lon, grid_lat = compute_grid(group.records, grid_res_km)
    mosaic = np.full(grid_lon.shape, -np.inf, dtype=np.float32)
    hit_count = np.zeros(grid_lon.shape, dtype=np.int32)
    stations_used: list[str] = []
    source_times: list[str] = []
    source_files: list[str] = []
    radar_sites: list[tuple[float, float]] = []

    for record in sorted(group.records, key=lambda item: item.station):
        decoded = decode_radar_file_cached(str(record.path))
        if decoded is None:
            print(f"[WARN] 解码失败, 跳过: {record.path}")
            continue

        try:
            low_level = select_product_field(decoded, product, level_index)
        except Exception as exc:
            print(f"[WARN] 产品 {product} 选择失败, 跳过: {record.path} | {exc}")
            continue
        if low_level.shape != (360, 230):
            print(f"[WARN] 产品 {product} 层数据形状不是 (360, 230), 实际为 {low_level.shape}: {record.path}")

        lat0 = float(decoded["latitude"])
        lon0 = float(decoded["longitude"])
        radar_sites.append((lat0, lon0))
        sample_lat, sample_lon, sample_values = polar_to_latlon(low_level, lat0, lon0)
        accumulate_to_grid(mosaic, hit_count, grid_lon, grid_lat, sample_lon, sample_lat, sample_values, min_valid)

        stations_used.append(record.station)
        source_times.append(record.timestamp.strftime(TIME_FORMAT))
        source_files.append(str(record.path))

    mosaic[mosaic == -np.inf] = np.nan
    if not stations_used:
        raise ValueError(f"时次 {group.target_time.strftime(TIME_FORMAT)} 没有可用站点完成拼接")

    coverage_mask = build_coverage_mask(grid_lon, grid_lat, radar_sites)
    display_ref = build_display_field(
        mosaic,
        coverage_mask,
        config.min_display,
        peak_enhance=config.peak_enhance,
    )

    return grid_lon, grid_lat, mosaic, stations_used, source_times, source_files, display_ref


def create_weighted_mosaic(
    group: MosaicGroup,
    grid_res_km: float,
    min_dbz: float,
    product: str = "reflectivity",
    level_index: int = 0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str], list[str], list[str], np.ndarray]:
    config = get_product_config(product)
    min_valid = max(min_dbz, config.min_valid) if config.key == "reflectivity" else config.min_valid
    grid_lon, grid_lat = compute_grid(group.records, grid_res_km)
    value_sum = np.zeros(grid_lon.shape, dtype=np.float32)
    weight_sum = np.zeros(grid_lon.shape, dtype=np.float32)
    stations_used: list[str] = []
    source_times: list[str] = []
    source_files: list[str] = []
    radar_sites: list[tuple[float, float]] = []

    for record in sorted(group.records, key=lambda item: item.station):
        decoded = decode_radar_file_cached(str(record.path))
        if decoded is None:
            continue

        try:
            low_level = select_product_field(decoded, product, level_index)
        except Exception:
            continue
        lat0 = float(decoded["latitude"])
        lon0 = float(decoded["longitude"])
        radar_sites.append((lat0, lon0))
        sample_lat, sample_lon, sample_values = polar_to_latlon(low_level, lat0, lon0)
        accumulate_weighted_to_grid(
            value_sum=value_sum,
            weight_sum=weight_sum,
            grid_lon=grid_lon,
            grid_lat=grid_lat,
            sample_lon=sample_lon,
            sample_lat=sample_lat,
            values=sample_values,
            min_dbz=min_valid,
            lat0=lat0,
            lon0=lon0,
        )

        stations_used.append(record.station)
        source_times.append(record.timestamp.strftime(TIME_FORMAT))
        source_files.append(str(record.path))

    if not stations_used:
        raise ValueError(f"时次 {group.target_time.strftime(TIME_FORMAT)} 没有可用站点完成加权拼接")

    mosaic = np.divide(
        value_sum,
        weight_sum,
        out=np.full_like(value_sum, np.nan, dtype=np.float32),
        where=weight_sum > 1e-6,
    )

    coverage_mask = build_coverage_mask(grid_lon, grid_lat, radar_sites)
    display_ref = build_display_field(
        mosaic,
        coverage_mask,
        config.min_display,
        peak_enhance=config.peak_enhance,
    )
    return grid_lon, grid_lat, mosaic, stations_used, source_times, source_files, display_ref


def create_quality_mosaic(
    group: MosaicGroup,
    grid_res_km: float,
    min_dbz: float,
    product: str = "reflectivity",
    level_index: int = 0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str], list[str], list[str], np.ndarray]:
    config = get_product_config(product)
    min_valid = max(min_dbz, config.min_valid) if config.key == "reflectivity" else config.min_valid
    grid_lon, grid_lat = compute_grid(group.records, grid_res_km)
    best_score = np.full(grid_lon.shape, -np.inf, dtype=np.float32)
    best_value = np.full(grid_lon.shape, np.nan, dtype=np.float32)
    stations_used: list[str] = []
    source_times: list[str] = []
    source_files: list[str] = []
    radar_sites: list[tuple[float, float]] = []

    for record in sorted(group.records, key=lambda item: item.station):
        decoded = decode_radar_file_cached(str(record.path))
        if decoded is None:
            continue

        try:
            low_level = select_product_field(decoded, product, level_index)
        except Exception:
            continue
        lat0 = float(decoded["latitude"])
        lon0 = float(decoded["longitude"])
        radar_sites.append((lat0, lon0))
        sample_lat, sample_lon, sample_values = polar_to_latlon(low_level, lat0, lon0)

        lon_axis = grid_lon[0, :]
        lat_axis = grid_lat[:, 0]
        lon_step = lon_axis[1] - lon_axis[0]
        lat_step = lat_axis[1] - lat_axis[0]

        valid_mask = np.isfinite(sample_values) & (sample_values >= min_valid)
        valid_mask &= (sample_lon >= lon_axis[0]) & (sample_lon <= lon_axis[-1])
        valid_mask &= (sample_lat >= lat_axis[0]) & (sample_lat <= lat_axis[-1])
        if not np.any(valid_mask):
            continue

        sample_lon = sample_lon[valid_mask]
        sample_lat = sample_lat[valid_mask]
        sample_values = sample_values[valid_mask]

        ix = np.rint((sample_lon - lon_axis[0]) / lon_step).astype(np.int64)
        iy = np.rint((sample_lat - lat_axis[0]) / lat_step).astype(np.int64)
        inside = (ix >= 0) & (ix < best_value.shape[1]) & (iy >= 0) & (iy < best_value.shape[0])
        if not np.any(inside):
            continue

        sample_lon = sample_lon[inside]
        sample_lat = sample_lat[inside]
        sample_values = sample_values[inside]
        ix = ix[inside]
        iy = iy[inside]

        dx = (sample_lon - lon0) * KM_PER_DEGREE * math.cos(math.radians(lat0))
        dy = (sample_lat - lat0) * KM_PER_DEGREE
        distance = np.hypot(dx, dy)
        score = sample_values - 0.08 * distance.astype(np.float32)

        flat_index = iy * best_value.shape[1] + ix
        flat_score = best_score.ravel()
        flat_best = best_value.ravel()
        for idx, sc, val in zip(flat_index, score, sample_values):
            if sc > flat_score[idx]:
                flat_score[idx] = sc
                flat_best[idx] = val

        stations_used.append(record.station)
        source_times.append(record.timestamp.strftime(TIME_FORMAT))
        source_files.append(str(record.path))

    if not stations_used:
        raise ValueError(f"时次 {group.target_time.strftime(TIME_FORMAT)} 没有可用站点完成质量评分拼接")

    coverage_mask = build_coverage_mask(grid_lon, grid_lat, radar_sites)
    display_ref = build_display_field(
        best_value,
        coverage_mask,
        config.min_display,
        peak_enhance=config.peak_enhance,
    )
    return grid_lon, grid_lat, best_value, stations_used, source_times, source_files, display_ref


def save_mosaic_npz(
    out_path: Path,
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    mosaic: np.ndarray,
    stations_used: list[str],
    source_times: list[str],
    source_files: list[str],
    display_ref: np.ndarray,
) -> None:
    np.savez_compressed(
        out_path,
        grid_lon=grid_lon,
        grid_lat=grid_lat,
        mosaic_ref=mosaic,
        display_ref=display_ref,
        stations_used=np.asarray(stations_used, dtype="<U16"),
        source_times=np.asarray(source_times, dtype="<U32"),
        source_files=np.asarray(source_files, dtype="<U512"),
    )


def save_mosaic_png(
    out_path: Path,
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    mosaic: np.ndarray,
    display_ref: np.ndarray,
    group: MosaicGroup,
    stations_used: list[str],
    source_times: list[str],
    source_files: list[str],
    boundary_data: BoundaryData | None,
    extent_mode: str,
    boundary_padding_degree: float,
    product: str = "reflectivity",
    level_index: int = 0,
) -> None:
    if SELECTED_FONT_NAME is None:
        configure_matplotlib_fonts()

    config = get_product_config(product)
    fig, ax = plt.subplots(figsize=(11.2, 8.4), dpi=150)
    fig.patch.set_facecolor("#edf2f7")
    ax.set_facecolor("#fbfcfe")

    cmap, norm, levels = get_radar_colormap(config.key)
    display_plot = display_ref.copy().astype(np.float32)
    display_plot[display_plot < config.min_display] = np.nan
    extent = [
        float(np.nanmin(grid_lon)),
        float(np.nanmax(grid_lon)),
        float(np.nanmin(grid_lat)),
        float(np.nanmax(grid_lat)),
    ]
    mesh = ax.imshow(
        display_plot,
        extent=extent,
        origin="lower",
        interpolation="bilinear",
        cmap=cmap,
        norm=norm,
        aspect="auto",
        zorder=2,
    )
    colorbar = fig.colorbar(mesh, ax=ax, shrink=0.92, pad=0.018, ticks=levels)
    colorbar.set_label(config.colorbar_label, color="#102235", fontsize=11, labelpad=10)
    colorbar.ax.yaxis.set_tick_params(color="#334155", labelsize=9)
    plt.setp(colorbar.ax.get_yticklabels(), color="#243446")
    colorbar.outline.set_edgecolor("#7b8ea3")
    colorbar.outline.set_linewidth(0.9)
    colorbar.ax.yaxis.label.set_color("#102235")
    colorbar.ax.set_facecolor("#edf2f7")

    if boundary_data is not None:
        plot_boundary(ax, boundary_data, show_labels=False)
        if extent_mode == "boundary" and boundary_data.bounds is not None:
            bounds = boundary_data.bounds
            min_lon, max_lon, min_lat, max_lat = bounds
            ax.set_xlim(min_lon - boundary_padding_degree, max_lon + boundary_padding_degree)
            ax.set_ylim(min_lat - boundary_padding_degree, max_lat + boundary_padding_degree)

    for station, file_path in zip(stations_used, source_files):
        decoded = decode_radar_file_cached(file_path)
        if decoded is None:
            continue
        lon0 = float(decoded["longitude"])
        lat0 = float(decoded["latitude"])
        xlim = ax.get_xlim()
        ylim = ax.get_ylim()
        if not (xlim[0] <= lon0 <= xlim[1] and ylim[0] <= lat0 <= ylim[1]):
            continue
        ax.plot(lon0, lat0, marker="+", color="#11263c", markersize=7, markeredgewidth=1.3, zorder=9)
        ax.text(
            lon0 + 0.03,
            lat0 + 0.02,
            station,
            color="#11263c",
            fontsize=8,
            weight="bold",
            clip_on=True,
            zorder=10,
        )

    ax.set_aspect("equal", adjustable="box")
    ax.set_xlabel("")
    ax.set_ylabel("")
    ax.tick_params(colors="#334155", labelsize=10, length=0)
    ax.set_xticklabels([])
    ax.set_yticklabels([])
    for spine in ax.spines.values():
        spine.set_color("#a7b4c5")
        spine.set_linewidth(0.8)
    ax.grid(False)

    finite_display = np.isfinite(display_ref)
    if np.any(finite_display):
        min_value = float(np.nanmin(display_ref))
        max_value = float(np.nanmax(display_ref))
    else:
        min_value = float("nan")
        max_value = float("nan")
    unit_suffix = f" {config.unit}" if config.unit else ""
    info_lines = [
        f"{config.label}天气雷达组网拼图",
        f"时间: {group.target_time.strftime('%Y-%m-%d %H:%M')}",
        f"层次: 第{level_index + 1}层",
        f"站点: {', '.join(stations_used)}",
        f"参与数: {len(stations_used)}",
        (
            f"范围: {min_value:.1f} ~ {max_value:.1f}{unit_suffix}"
            if np.isfinite(max_value)
            else "范围: NaN"
        ),
    ]
    if config.key != "reflectivity":
        info_lines.append("空白: 无有效观测")
    ax.text(
        0.99,
        0.03,
        "\n".join(info_lines),
        transform=ax.transAxes,
        va="bottom",
        ha="right",
        fontsize=9,
        color="#11263c",
        fontfamily=SELECTED_FONT_NAME if SELECTED_FONT_NAME else None,
        bbox=dict(facecolor="#ffffff", edgecolor="#c9d4e0", alpha=0.94, pad=5),
    )

    station_line = " / ".join(stations_used)
    ax.set_title(
        f"{config.title}\n{group.target_time.strftime('%Y-%m-%d %H:%M')}   |   第{level_index + 1}层   |   {station_line}",
        fontsize=14,
        color="#102235",
        pad=10,
        weight="bold",
        fontfamily=SELECTED_FONT_NAME if SELECTED_FONT_NAME else None,
    )
    fig.tight_layout()
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


def print_group_summary(group: MosaicGroup) -> None:
    print(f"\n[INFO] 目标时次: {group.target_time.strftime(TIME_FORMAT)}")
    print(f"[INFO] 参与站点数: {len(group.records)} | 最大时间差: {group.max_delta_sec}s")
    for record in sorted(group.records, key=lambda item: item.station):
        delta_sec = int(abs((record.timestamp - group.target_time).total_seconds()))
        print(f"  - {record.station}: {record.timestamp.strftime(TIME_FORMAT)} | dt={delta_sec}s | {record.path}")


def run_single(args: argparse.Namespace, station_records: dict[str, list[RadarRecord]]) -> None:
    if not args.target_time:
        raise ValueError("single 模式下必须提供 --target-time YYYYmmddHHMMSS")
    target_time = datetime.strptime(args.target_time, TIME_FORMAT)
    group = build_single_group(station_records, target_time, args.time_tolerance_sec)
    boundary_data = None if args.no_boundary else load_boundary_data(Path(args.boundary_path))
    process_group(
        group,
        Path(args.output_dir),
        args.grid_res_km,
        args.min_dbz,
        boundary_data,
        args.extent_mode,
        args.boundary_padding_degree,
        args.strategy,
        args.product,
        args.level_index,
    )


def run_batch(args: argparse.Namespace, station_records: dict[str, list[RadarRecord]]) -> None:
    groups = build_batch_groups(station_records, args.time_tolerance_sec)
    if not groups:
        raise ValueError("没有构建出任何可处理的时次组")

    print(f"[INFO] 共发现 {len(groups)} 个拼接时次")
    boundary_data = None if args.no_boundary else load_boundary_data(Path(args.boundary_path))
    for group in groups:
        try:
            process_group(
                group,
                Path(args.output_dir),
                args.grid_res_km,
                args.min_dbz,
                boundary_data,
                args.extent_mode,
                args.boundary_padding_degree,
                args.strategy,
                args.product,
                args.level_index,
            )
        except Exception as exc:
            print(f"[WARN] 时次 {group.target_time.strftime(TIME_FORMAT)} 处理失败: {exc}")


def process_group(
    group: MosaicGroup,
    output_dir: Path,
    grid_res_km: float,
    min_dbz: float,
    boundary_data: BoundaryData | None,
    extent_mode: str,
    boundary_padding_degree: float,
    strategy: str = "max",
    product: str = "reflectivity",
    level_index: int = 0,
) -> None:
    print_group_summary(group)

    if strategy == "weighted":
        grid_lon, grid_lat, mosaic, stations_used, source_times, source_files, display_ref = create_weighted_mosaic(
            group=group,
            grid_res_km=grid_res_km,
            min_dbz=min_dbz,
            product=product,
            level_index=level_index,
        )
    elif strategy == "quality":
        grid_lon, grid_lat, mosaic, stations_used, source_times, source_files, display_ref = create_quality_mosaic(
            group=group,
            grid_res_km=grid_res_km,
            min_dbz=min_dbz,
            product=product,
            level_index=level_index,
        )
    else:
        grid_lon, grid_lat, mosaic, stations_used, source_times, source_files, display_ref = create_mosaic(
            group=group,
            grid_res_km=grid_res_km,
            min_dbz=min_dbz,
            product=product,
            level_index=level_index,
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    stem = build_output_stem(group, product=product, strategy=strategy, level_index=level_index)
    npz_path = output_dir / f"{stem}.npz"
    png_path = output_dir / f"{stem}.png"

    save_mosaic_npz(
        npz_path,
        grid_lon,
        grid_lat,
        mosaic,
        stations_used,
        source_times,
        source_files,
        display_ref,
    )
    save_mosaic_png(
        png_path,
        grid_lon,
        grid_lat,
        mosaic,
        display_ref,
        group,
        stations_used,
        source_times,
        source_files,
        boundary_data,
        extent_mode,
        boundary_padding_degree,
        product,
        level_index,
    )

    finite_mask = np.isfinite(mosaic)
    if np.any(finite_mask):
        min_val = float(np.nanmin(mosaic))
        max_val = float(np.nanmax(mosaic))
    else:
        min_val = float("nan")
        max_val = float("nan")

    print(f"[INFO] 输出 npz: {npz_path}")
    print(f"[INFO] 输出 png: {png_path}")
    config = get_product_config(product)
    unit_suffix = f" {config.unit}" if config.unit else ""
    print(f"[INFO] 拼接结果范围: {min_val:.2f} ~ {max_val:.2f}{unit_suffix}")


def main() -> None:
    configure_matplotlib_fonts()
    args = parse_args()
    data_root = Path(args.data_root)
    records = scan_records(data_root)
    station_records = group_records_by_station(records)

    if args.mode == "single":
        run_single(args, station_records)
    else:
        run_batch(args, station_records)


if __name__ == "__main__":
    main()
