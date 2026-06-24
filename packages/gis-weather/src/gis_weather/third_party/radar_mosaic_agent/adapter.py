# +-------------------------------------------------------------------------
#
#   地理智能平台 - 雷达拼图第三方工具适配器
#
#   文件:       adapter.py
#
#   日期:       2026年06月23日
#   作者:       Codex
# --------------------------------------------------------------------------

"""Newmap wrapper for the copied radar mosaic tool.

The original files under ``source`` are kept intact. This adapter translates
Newmap valueRef inputs into the original pure Python algorithm calls and writes
only explicit artifact targets supplied by the worker.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
import shutil
import tempfile
from typing import Any

import numpy as np

from gis_weather.third_party.common import ensure_parent, finite_float, import_source_module


SOURCE_DIR = Path(__file__).resolve().parent / "source"
TIME_FORMAT = "%Y%m%d%H%M"


def _radar_mosaic_module() -> Any:
    return import_source_module("radar_mosaic", SOURCE_DIR)


def _mosaic_comparison_module() -> Any:
    return import_source_module("mosaic_comparison", SOURCE_DIR)


def _parse_target_time(value: str) -> datetime:
    try:
        return datetime.strptime(value, TIME_FORMAT)
    except ValueError as exc:
        raise ValueError(f"target_time 必须是 {TIME_FORMAT} 格式: {value}") from exc


def _parse_records(paths: list[Path]) -> tuple[Any, list[Any]]:
    rm = _radar_mosaic_module()
    records = []
    failures: list[str] = []
    for path in paths:
        try:
            records.append(rm.parse_record(path))
        except Exception as exc:  # noqa: BLE001 - third-party decoder raises broad exceptions.
            failures.append(f"{path.name}: {exc}")
    if not records:
        detail = "; ".join(failures[:5])
        raise ValueError(f"未找到可解析的雷达 bz2 文件。{detail}")
    return rm, records


def inspect_radar_station_collection(paths: list[Path]) -> dict[str, Any]:
    """Inspect copied radar files and return station/time candidates."""

    rm, records = _parse_records(paths)
    station_counts = Counter(record.station for record in records)
    time_counts = Counter(record.timestamp for record in records)
    station_records = rm.group_records_by_station(records)
    product_options = rm.product_options()

    candidate_times = []
    for timestamp, count in sorted(time_counts.items()):
        candidate_times.append(
            {
                "timestamp": timestamp.strftime(TIME_FORMAT),
                "isoTime": timestamp.isoformat(),
                "fileCount": int(count),
            }
        )

    return {
        "fileCount": len(records),
        "stations": [
            {
                "station": station,
                "fileCount": int(count),
                "availableTimes": [
                    item.timestamp.strftime(TIME_FORMAT)
                    for item in sorted(station_records.get(station, []), key=lambda record: record.timestamp)
                ],
            }
            for station, count in sorted(station_counts.items())
        ],
        "candidateTimes": candidate_times,
        "products": [item["key"] for item in product_options],
        "productOptions": product_options,
        "productAliases": dict(getattr(rm, "PRODUCT_ALIASES", {})),
        "strategies": ["max", "weighted", "quality"],
    }


def recommend_radar_mosaic_strategy(goal_mode: str, time_strategy: str) -> dict[str, Any]:
    """Return the original console's deterministic strategy recommendation."""

    goal = goal_mode.strip().lower()
    timing = time_strategy.strip().lower()
    if goal in {"quality", "qc", "analysis"}:
        strategy = "quality"
        reason = "质量优先场景使用质量评分拼图，以降低杂波和异常站点影响。"
    elif goal in {"smooth", "weighted", "presentation"} or timing in {"wide", "loose"}:
        strategy = "weighted"
        reason = "展示或宽时间窗场景使用加权拼图，使站点过渡更平滑。"
    else:
        strategy = "max"
        reason = "业务快速查看默认使用最大值拼图，保留最强回波信号。"
    return {
        "strategy": strategy,
        "reason": reason,
        "goalMode": goal_mode,
        "timeStrategy": time_strategy,
    }


def render_radar_mosaic(
    *,
    paths: list[Path],
    output_png: Path,
    output_npz: Path,
    output_map_png: Path | None = None,
    target_time: str,
    tolerance_sec: int = 300,
    strategy: str = "max",
    product: str = "reflectivity",
    level_index: int = 0,
    grid_res_km: float = 1.0,
    min_dbz: float = 5.0,
) -> dict[str, Any]:
    """Run one radar mosaic and copy generated artifacts to platform targets."""

    rm, records = _parse_records(paths)
    normalized_strategy = strategy.lower().strip()
    if normalized_strategy not in {"max", "weighted", "quality"}:
        raise ValueError(f"不支持的雷达拼图策略: {strategy}")
    known_products = set(getattr(rm, "PRODUCT_CONFIGS", {}).keys())
    known_aliases = set(getattr(rm, "PRODUCT_ALIASES", {}).keys())
    requested_product = product.lower().strip()
    if requested_product not in known_products and requested_product not in known_aliases:
        raise ValueError(f"不支持的雷达产品: {product}")
    normalized_product = rm.normalize_product_key(product)

    parsed_target = _parse_target_time(target_time)
    station_records = rm.group_records_by_station(records)
    group = rm.build_single_group(station_records, parsed_target, int(tolerance_sec))
    if not group.records:
        raise ValueError(f"目标时次 {target_time} 在 {tolerance_sec}s 容差内没有匹配雷达文件")

    ensure_parent(output_png)
    ensure_parent(output_npz)
    with tempfile.TemporaryDirectory(prefix="radar-mosaic-") as tmp:
        tmp_dir = Path(tmp)
        rm.process_group(
            group,
            tmp_dir,
            float(grid_res_km),
            float(min_dbz),
            None,
            "data",
            0.05,
            normalized_strategy,
            normalized_product,
            int(level_index),
        )
        generated_pngs = sorted(tmp_dir.glob("*.png"))
        generated_npzs = sorted(tmp_dir.glob("*.npz"))
        if not generated_pngs or not generated_npzs:
            raise RuntimeError("雷达拼图算法未生成 PNG/NPZ 输出")
        shutil.copy2(generated_pngs[0], output_png)
        shutil.copy2(generated_npzs[0], output_npz)

    payload = np.load(output_npz, allow_pickle=True)
    display_key = "display_ref" if "display_ref" in payload.files else "mosaic_ref"
    if display_key not in payload.files:
        raise RuntimeError(f"雷达拼图 NPZ 缺少结果字段: {payload.files}")
    mosaic = payload[display_key]
    bounds = _grid_bounds(payload)
    if output_map_png is not None:
        _write_map_overlay_png(
            output_map_png=output_map_png,
            data=mosaic,
            product=normalized_product,
        )
    finite = np.isfinite(mosaic)
    return {
        "targetTime": target_time,
        "strategy": normalized_strategy,
        "product": normalized_product,
        "levelIndex": int(level_index),
        "stationsUsed": sorted({record.station for record in group.records}),
        "sourceFiles": [record.path.name for record in group.records],
        "maxDeltaSec": int(group.max_delta_sec),
        "valueRange": {
            "min": finite_float(np.nanmin(mosaic[finite])) if np.any(finite) else None,
            "max": finite_float(np.nanmax(mosaic[finite])) if np.any(finite) else None,
        },
        "bounds": bounds,
        "coordinates": _coordinates_from_bounds(bounds),
        "outputs": {
            "png": output_png.name,
            "npz": output_npz.name,
            **({"mapPng": output_map_png.name} if output_map_png is not None else {}),
        },
    }


def _grid_bounds(payload: Any) -> list[float]:
    required = {"grid_lon", "grid_lat"}
    if not required.issubset(payload.files):
        raise RuntimeError(f"雷达拼图 NPZ 缺少地图坐标字段: {', '.join(sorted(required - set(payload.files)))}")
    grid_lon = np.asarray(payload["grid_lon"], dtype=float)
    grid_lat = np.asarray(payload["grid_lat"], dtype=float)
    return [
        float(np.nanmin(grid_lon)),
        float(np.nanmin(grid_lat)),
        float(np.nanmax(grid_lon)),
        float(np.nanmax(grid_lat)),
    ]


def _coordinates_from_bounds(bounds: list[float]) -> list[list[float]]:
    west, south, east, north = bounds
    return [[west, north], [east, north], [east, south], [west, south]]


def _write_map_overlay_png(*, output_map_png: Path, data: np.ndarray, product: str) -> None:
    """Write a transparent map-native radar overlay without axes or legends."""

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    rm = _radar_mosaic_module()
    config = rm.get_product_config(product)
    cmap, norm, _levels = rm.get_radar_colormap(config.key)
    display = np.asarray(data, dtype=np.float32).copy()
    display[display < float(config.min_display)] = np.nan
    rgba = cmap(norm(display))
    rgba[~np.isfinite(display), 3] = 0.0
    ensure_parent(output_map_png)
    plt.imsave(output_map_png, np.flipud(rgba))


def compare_radar_mosaic_reference(
    *,
    mosaic_npz: Path,
    reference_paths: list[Path],
    output_png: Path,
    output_reference_png: Path,
    target_time: str,
    level_index: int = 0,
    product_label: str = "反射率",
    product_unit: str = "dBZ",
    min_display: float = 10.0,
) -> dict[str, Any]:
    """Compare a generated mosaic NPZ with an NC reference product."""

    mc = _mosaic_comparison_module()
    data = np.load(mosaic_npz, allow_pickle=True)
    required = {"grid_lon", "grid_lat"}
    if not required.issubset(data.files):
        raise ValueError(f"雷达拼图 NPZ 缺少字段: {', '.join(sorted(required - set(data.files)))}")
    display_key = "display_ref" if "display_ref" in data.files else "mosaic_ref"
    if display_key not in data.files:
        raise ValueError("雷达拼图 NPZ 缺少 display_ref/mosaic 字段")

    ensure_parent(output_png)
    ensure_parent(output_reference_png)
    reference_dirs = sorted({path.parent for path in reference_paths})
    with tempfile.TemporaryDirectory(prefix="radar-compare-") as tmp:
        tmp_dir = Path(tmp)
        result = mc.run_comparison(
            grid_lon=data["grid_lon"],
            grid_lat=data["grid_lat"],
            generated_display=data[display_key],
            target_time=_parse_target_time(target_time),
            output_dir=tmp_dir,
            level_index=int(level_index),
            product_label=product_label,
            product_unit=product_unit,
            min_display=float(min_display),
            reference_dirs=reference_dirs,
        )
        if result is None:
            raise ValueError(f"没有找到目标时次 {target_time} 对应的 NC 参考文件")
        generated_pngs = sorted(tmp_dir.glob("comparison_*.png"))
        reference_pngs = sorted(tmp_dir.glob("comparison_*_ref.png"))
        if not generated_pngs or not reference_pngs:
            raise RuntimeError("雷达对比算法未生成对比 PNG")
        shutil.copy2(generated_pngs[0], output_png)
        shutil.copy2(reference_pngs[0], output_reference_png)

    stats = result.get("stats", {})
    return {
        "targetTime": target_time,
        "ncFile": result.get("nc_file"),
        "levelHeightKm": finite_float(result.get("nc_level_height_km")),
        "stats": {key: finite_float(value) for key, value in stats.items()},
        "outputs": {
            "comparisonPng": output_png.name,
            "referencePng": output_reference_png.name,
        },
    }
