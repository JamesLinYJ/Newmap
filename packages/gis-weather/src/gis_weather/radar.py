# +-------------------------------------------------------------------------
#
#   地理智能平台 - 雷达原始数据解码
#
#   文件:       radar.py
#
#   日期:       2026年05月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 解码 .bz2 压缩雷达原始径向数据，提取站点、仰角和双偏振产品，
# 并提供可被地图叠加使用的近似 WGS84 笛卡尔网格。

from __future__ import annotations

import bz2
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any


RADAR_PRODUCTS: dict[int, tuple[str, str | None, str]] = {
    2: ("reflectivity", "dBZ", "反射率"),
    3: ("velocity", "m/s", "径向速度"),
    4: ("spectrum_width", "m/s", "谱宽"),
    7: ("zdr", "dB", "差分反射率"),
    9: ("cc", None, "协相关系数"),
    10: ("dp", "degree", "差分相位"),
    11: ("kdp", "degree/km", "差分相位常数"),
    16: ("snrh", "dB", "水平信噪比"),
}


@dataclass(frozen=True)
class RadarProduct:
    name: str
    unit: str | None
    long_name: str
    data: Any
    elevations: list[float]


@dataclass(frozen=True)
class RadarDecodeResult:
    latitude: float
    longitude: float
    height_m: int
    radar_type: int
    products: dict[str, RadarProduct]
    bounds: list[float]
    range_km: float


def decode_radar_bz2(path: Path) -> RadarDecodeResult:
    # 原始雷达径向数据解码。
    #
    # 该格式以站点配置、任务配置和径向数据块顺序组织；产品数据仍是
    # 极坐标，因此解码后统一重采样到 1km range bin，供后续笛卡尔化。
    try:
        filedata = bz2.BZ2File(path, "rb").read()
    except (OSError, EOFError) as exc:
        raise ValueError(f"雷达 bz2 文件读取失败：{exc}") from exc
    if len(filedata) < 672:
        raise ValueError("雷达文件过短，缺少站点或任务配置块。")

    station_lat = _unpack("f", filedata, 72)
    station_lon = _unpack("f", filedata, 76)
    station_height = int(_unpack("i", filedata, 80))
    radar_type = int(_unpack("h", filedata, 104))
    scan_level = int(_unpack("i", filedata, 336))
    if scan_level <= 0 or scan_level > 64:
        raise ValueError(f"雷达扫描层数异常：{scan_level}")

    elevations, log_res, dop_res, max_range1, max_range2 = _read_scan_config(filedata, scan_level)
    ref_res = _resolve_resolution(log_res[0], dop_res[0], radar_type, default_resolution=250.0)
    vel_res = _resolve_resolution(dop_res[0], log_res[0], radar_type, default_resolution=ref_res)
    max_range_m = _resolve_max_range(log_res[0], max_range1[0], max_range2[0])

    range_shape_ref = int(max_range_m / ref_res) + 32
    range_shape_vel = int(max_range_m / vel_res) + 32
    arrays = {
        "reflectivity": _zeros(scan_level, range_shape_ref),
        "velocity": _zeros(scan_level, range_shape_vel),
        "spectrum_width": _zeros(scan_level, range_shape_vel),
        "zdr": _zeros(scan_level, range_shape_ref),
        "cc": _zeros(scan_level, range_shape_ref),
        "dp": _zeros(scan_level, range_shape_ref),
        "kdp": _zeros(scan_level, range_shape_ref),
        "snrh": _zeros(scan_level, range_shape_ref),
    }
    product_elevation_indices: dict[str, list[int]] = {name: [] for name in arrays}

    azimuths = _np().arange(0, 360)
    cursor = 416 + 256 * scan_level
    while cursor < len(filedata):
        if cursor + 64 > len(filedata):
            break
        radial_state = int(_unpack("i", filedata, cursor))
        elevation_number = int(_unpack("i", filedata, cursor + 16))
        azimuth = float(_unpack("f", filedata, cursor + 20))
        data_length = int(_unpack("i", filedata, cursor + 36))
        if data_length <= 0:
            break
        elevation_index = elevation_number - 1
        if elevation_index < 0 or elevation_index >= scan_level:
            cursor += data_length + 64
            continue
        azimuth_index = int(_np().argmin(_np().abs(azimuths - azimuth)))

        data_index = cursor + 64
        data_end = min(cursor + data_length, len(filedata) - 32)
        while data_index <= data_end:
            data_type = int(_unpack("i", filedata, data_index))
            scale = int(_unpack("i", filedata, data_index + 4))
            offset = int(_unpack("i", filedata, data_index + 8))
            bin_len = int(_unpack("h", filedata, data_index + 12))
            single_len = int(_unpack("i", filedata, data_index + 16))
            if single_len <= 0:
                break
            product_info = RADAR_PRODUCTS.get(data_type)
            if product_info is not None:
                product_name = product_info[0]
                decoded, decoded_range = _decode_data_block(filedata, data_index, offset=offset, scale=scale, bin_len=bin_len, single_len=single_len)
                target = arrays[product_name]
                target[elevation_index, azimuth_index, : min(decoded_range, target.shape[-1])] = decoded[: target.shape[-1]]
                product_elevation_indices[product_name].append(elevation_index)
            data_index += single_len + 32
        cursor += data_length + 64
        if radial_state in {4, 6}:
            break

    products: dict[str, RadarProduct] = {}
    for _code, (name, unit, long_name) in RADAR_PRODUCTS.items():
        indices = _unique_indices(product_elevation_indices[name])
        if not indices:
            continue
        resolution = vel_res if name in {"velocity", "spectrum_width"} else ref_res
        resampled = _resample_to_1km(arrays[name], indices, resolution)
        if name == "reflectivity":
            resampled[resampled < 0] = 0
        products[name] = RadarProduct(
            name=name,
            unit=unit,
            long_name=long_name,
            data=resampled,
            elevations=[float(elevations[index]) for index in indices],
        )
    if not products:
        raise ValueError("雷达文件中没有可识别的双偏振产品数据。")

    range_km = 230.0
    bounds = radar_bounds(station_lat, station_lon, range_km)
    return RadarDecodeResult(
        latitude=float(station_lat),
        longitude=float(station_lon),
        height_m=station_height,
        radar_type=radar_type,
        products=products,
        bounds=bounds,
        range_km=range_km,
    )


def radar_product_to_grid(
    decoded: RadarDecodeResult,
    *,
    variable: str | None = None,
    elevation_index: int | None = None,
    grid_size: int = 512,
) -> tuple[Any, Any, Any, RadarProduct, int]:
    # 极坐标转近似经纬网格。
    #
    # MapLibre image source 需要规则矩形范围；这里用站点为中心的局地平面近似
    # 生成 WGS84 经纬度网格，足以支撑第一版叠图、统计和阈值区域。
    if variable and variable not in decoded.products:
        available = ", ".join(sorted(decoded.products))
        raise ValueError(f"雷达产品不存在：{variable}；可用产品：{available}")
    product = decoded.products.get(variable or "reflectivity") if variable else decoded.products.get("reflectivity")
    if product is None:
        product = next(iter(decoded.products.values()))
    if product.data.shape[0] <= 0:
        raise ValueError(f"雷达产品没有可用仰角：{product.name}")
    selected_index = max(0, min(int(elevation_index or 0), product.data.shape[0] - 1))
    polar = _np().asarray(product.data[selected_index], dtype="float64")
    range_bins = int(polar.shape[-1])
    extent_km = float(min(range_bins, int(decoded.range_km)))

    x_km = _np().linspace(-extent_km, extent_km, grid_size)
    y_km = _np().linspace(-extent_km, extent_km, grid_size)
    xx, yy = _np().meshgrid(x_km, y_km)
    radius = _np().sqrt(xx * xx + yy * yy)
    azimuth = (_np().degrees(_np().arctan2(xx, yy)) + 360.0) % 360.0
    azimuth_index = _np().rint(azimuth).astype("int32") % 360
    range_index = _np().floor(radius).astype("int32")
    range_index = _np().clip(range_index, 0, range_bins - 1)
    grid = polar[azimuth_index, range_index]
    grid[radius > extent_km] = _np().nan

    lat = decoded.latitude + y_km / 110.574
    lon = decoded.longitude + x_km / (111.320 * max(math.cos(math.radians(decoded.latitude)), 0.01))
    return grid, lat, lon, product, selected_index


def radar_bounds(latitude: float, longitude: float, range_km: float) -> list[float]:
    lat_delta = range_km / 110.574
    lon_delta = range_km / (111.320 * max(math.cos(math.radians(latitude)), 0.01))
    return [float(longitude - lon_delta), float(latitude - lat_delta), float(longitude + lon_delta), float(latitude + lat_delta)]


def _read_scan_config(filedata: bytes, scan_level: int):
    np = _np()
    elevations = np.zeros(scan_level)
    log_res = np.zeros(scan_level)
    dop_res = np.zeros(scan_level)
    max_range1 = np.zeros(scan_level)
    max_range2 = np.zeros(scan_level)
    for index in range(scan_level):
        base = 416 + index * 256
        elevations[index] = float(_unpack("f", filedata, base + 24))
        log_res[index] = float(_unpack("i", filedata, base + 44))
        dop_res[index] = float(_unpack("i", filedata, base + 48))
        max_range1[index] = float(_unpack("i", filedata, base + 52))
        max_range2[index] = float(_unpack("i", filedata, base + 56))
    return elevations, log_res, dop_res, max_range1, max_range2


def _resolve_resolution(primary: float, secondary: float, radar_type: int, *, default_resolution: float) -> float:
    if primary in {62.5, 125.0, 150.0, 250.0, 300.0, 500.0, 1000.0}:
        return float(primary)
    if radar_type == 4 and secondary != 250.0:
        return 62.5
    return float(default_resolution)


def _resolve_max_range(log_res: float, max_range1: float, max_range2: float) -> float:
    if log_res == 1000.0:
        return 460000.0
    candidate = max(float(max_range1), float(max_range2))
    return candidate if candidate > 0 else 230000.0


def _decode_data_block(filedata: bytes, data_index: int, *, offset: int, scale: int, bin_len: int, single_len: int):
    np = _np()
    payload = filedata[data_index + 32:data_index + 32 + single_len]
    if bin_len == 1:
        decoded_range = single_len
        raw = np.asarray(struct.unpack(f"<{single_len}B", payload), dtype="float32")
    elif bin_len == 2:
        decoded_range = int(single_len / 2)
        raw = np.asarray(struct.unpack(f"<{decoded_range}h", payload), dtype="float32")
    else:
        raise ValueError(f"雷达数据位宽不支持：{bin_len}")
    if scale > 0:
        data = (raw - offset) / scale
    elif scale < 0:
        data = (raw - offset) * scale
    else:
        data = raw - offset
    data[raw <= 5] = 0
    return data, decoded_range


def _resample_to_1km(data: Any, indices: list[int], data_res: float, *, bins: int = 230):
    np = _np()
    if not indices:
        return np.zeros((0, 360, bins), dtype="float64")
    selected = np.asarray(data[indices], dtype="float64")
    source_bins = selected.shape[-1]
    source_indices = np.rint(((np.arange(bins) + 1) * 1000.0 / float(data_res)) - 1).astype("int32")
    source_indices = np.clip(source_indices, 0, source_bins - 1)
    return selected[:, :, source_indices]


def _unique_indices(values: list[int]) -> list[int]:
    seen: set[int] = set()
    result: list[int] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _zeros(scan_level: int, range_bins: int):
    return _np().zeros((scan_level, 360, range_bins), dtype="float64")


def _unpack(fmt: str, data: bytes, offset: int) -> Any:
    size = struct.calcsize(fmt)
    if offset + size > len(data):
        raise ValueError("雷达文件结构不完整，读取字段越界。")
    return struct.unpack_from(f"<{fmt}", data, offset)[0]


def _np() -> Any:
    import numpy as np
    return np
