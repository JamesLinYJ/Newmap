# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象栅格读取抽象
#
#   文件:       readers.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 将 NetCDF/GeoTIFF 等气象数据读取统一成 GridQuery/GridSlice。
# xarray 负责科学维度语义，rasterio/GDAL 负责地图执行；上层服务不直接读数组。

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from shapely import intersects_xy
from shapely.geometry import shape
from shapely.ops import unary_union


@dataclass(frozen=True)
class GridQuery:
    # 栅格读取请求。
    #
    # purpose 决定 reader 的执行策略：analysis 保留完整切片，render 可下采样，
    # nowcast 强调多时次小窗口读取。
    variable: str | None = None
    time_index: int | None = None
    level_index: int | None = None
    bbox: list[float] | None = None
    area: dict[str, Any] | None = None
    purpose: str = "analysis"
    max_size: int | None = None


@dataclass(frozen=True)
class GridSlice:
    data: Any
    variable: str
    unit: str | None = None
    long_name: str | None = None
    time_value: str | None = None
    level_value: str | None = None
    lat: Any | None = None
    lon: Any | None = None
    bounds: list[float] | None = None
    backend: str = "unknown"
    mask_applied: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MeteorologicalDatasetIndex:
    filename: str
    format: str
    engine: str
    variables: list[dict[str, Any]]
    coordinates: dict[str, Any]
    times: list[str] = field(default_factory=list)
    levels: list[str] = field(default_factory=list)
    bounds: list[float] | None = None
    is_georeferenced: bool = False
    backend_summary: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def to_metadata(self) -> dict[str, Any]:
        return {
            "filename": self.filename,
            "format": self.format,
            "engine": self.engine,
            "variables": self.variables,
            "coordinates": self.coordinates,
            "times": self.times,
            "levels": self.levels,
            "bounds": self.bounds,
            "isGeoreferenced": self.is_georeferenced,
            "backendSummary": self.backend_summary,
            "warnings": self.warnings,
        }


class MeteorologicalDatasetReader(Protocol):
    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        ...

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        ...

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        ...


class XarrayScientificReader:
    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        return _effective_suffix(path, filename) in {".nc", ".nc4", ".grib", ".grb", ".grb2", ".h5", ".hdf5"}

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        xr = _xarray()
        suffix = _effective_suffix(path, filename)
        ds, engine = _open_xarray_dataset(xr, path, suffix=suffix)
        try:
            lat_name, lon_name = _find_lat_lon_coords(ds)
            time_name = _find_time_coord(ds)
            level_name = _find_level_coord(ds)
            bounds = _bounds_from_coords(ds[lat_name].values, ds[lon_name].values) if lat_name and lon_name else None
            variables: list[dict[str, Any]] = []
            for name, data_array in ds.data_vars.items():
                if not _is_numeric_dtype(data_array.dtype):
                    continue
                stats = _sample_data_array_stats(data_array)
                xarray_map_ready = bool(lat_name and lon_name and _data_uses_coords(data_array, lat_name, lon_name))
                variables.append(
                    {
                        "name": str(name),
                        "dimensions": [str(item) for item in data_array.dims],
                        "shape": [int(item) for item in data_array.shape],
                        "dataType": str(data_array.dtype),
                        "unit": _attr_text(data_array, "units"),
                        "longName": _attr_text(data_array, "long_name") or _attr_text(data_array, "standard_name"),
                        "valueRange": stats,
                        "timeCount": _matching_dim_count(data_array, _is_time_coord),
                        "levelCount": _matching_dim_count(data_array, _is_level_coord),
                        "bounds": bounds if xarray_map_ready else None,
                        "mapReady": xarray_map_ready,
                        "analysisReady": stats is not None,
                        "preferredBackend": "xarray" if stats is not None else "none",
                        "backends": [
                            {
                                "name": "xarray",
                                "analysisReady": stats is not None,
                                "mapReady": xarray_map_ready,
                                "bounds": bounds if xarray_map_ready else None,
                            }
                        ],
                    }
                )
            if not variables:
                raise ValueError("文件中没有可识别的数值型气象变量。")
            return MeteorologicalDatasetIndex(
                filename=filename or path.name,
                format=_format_label(suffix),
                engine=engine,
                variables=variables,
                coordinates={"latitude": lat_name, "longitude": lon_name, "time": time_name, "level": level_name},
                times=_extract_coord_values(ds, time_name),
                levels=_extract_coord_values(ds, level_name),
                bounds=bounds,
                is_georeferenced=bounds is not None,
                backend_summary={"xarray": {"engine": engine}},
                warnings=[] if bounds else ["未识别到经纬度坐标，地图叠加能力不可用。"],
            )
        finally:
            ds.close()

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        xr = _xarray()
        ds, _engine = _open_xarray_dataset(xr, path, suffix=_effective_suffix(path, filename))
        try:
            lat_name, lon_name = _find_lat_lon_coords(ds)
            variable_name = query.variable or (
                _pick_default_variable(ds, lat_name, lon_name)
                if lat_name and lon_name
                else _pick_default_numeric_variable(ds)
            )
            if variable_name not in ds.data_vars:
                raise ValueError(f"气象变量不存在：{variable_name}")
            data_array = ds[variable_name]
            selected, time_value, level_value = _select_2d_data_array(
                data_array,
                time_index=query.time_index,
                level_index=query.level_index,
            )
            selected = _transpose_to_lat_lon(selected, ds, lat_name, lon_name)
            if query.purpose == "render" and query.max_size is not None:
                selected = _thin_selected_data_array_for_render(selected, max_size=query.max_size)
            lat = selected.coords[lat_name].values if lat_name and lat_name in selected.coords else ds[lat_name].values if lat_name else None
            lon = selected.coords[lon_name].values if lon_name and lon_name in selected.coords else ds[lon_name].values if lon_name else None
            data = _np().asarray(selected.values, dtype="float64")
            data = _normalize_missing_values(data, data_array.attrs)
            data, lat, lon = crop_grid_with_coords_by_bbox(data, lat, lon, query.bbox)
            mask_applied = query.area is not None
            data = mask_grid_to_area(data, lat, lon, query.area)
            return GridSlice(
                data=data,
                variable=variable_name,
                unit=_attr_text(data_array, "units"),
                long_name=_attr_text(data_array, "long_name") or _attr_text(data_array, "standard_name"),
                time_value=time_value,
                level_value=level_value,
                lat=lat,
                lon=lon,
                bounds=_bounds_from_coords(lat, lon) if lat is not None and lon is not None else None,
                backend="xarray",
                mask_applied=mask_applied,
                metadata={"purpose": query.purpose},
            )
        finally:
            ds.close()


class RasterMapReader:
    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        return _effective_suffix(path, filename) in {".tif", ".tiff"}

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        rasterio = _rasterio()
        with rasterio.open(path) as src:
            bounds = _raster_bounds_wgs84(src)
            variables = []
            for band_index in range(1, src.count + 1):
                tags = src.tags(band_index)
                variables.append(
                    {
                        "name": f"band_{band_index}",
                        "dimensions": ["y", "x"],
                        "shape": [int(src.height), int(src.width)],
                        "dataType": str(src.dtypes[band_index - 1]),
                        "unit": tags.get("units") or tags.get("unit"),
                        "longName": tags.get("long_name") or tags.get("description") or f"Band {band_index}",
                        "valueRange": _raster_band_range(src, band_index),
                        "timeCount": 0,
                        "levelCount": 0,
                        "bounds": bounds,
                        "mapReady": bounds is not None,
                        "analysisReady": True,
                        "preferredBackend": "rasterio",
                        "backends": [{"name": "rasterio", "analysisReady": True, "mapReady": bounds is not None, "bounds": bounds}],
                    }
                )
            return MeteorologicalDatasetIndex(
                filename=filename or path.name,
                format="GeoTIFF",
                engine="rasterio",
                variables=variables,
                coordinates={"latitude": "y", "longitude": "x", "time": None, "level": None},
                bounds=bounds,
                is_georeferenced=bounds is not None,
                backend_summary={"rasterio": {"available": True}},
                warnings=[] if bounds else ["GeoTIFF 缺少 CRS 或 bounds，地图叠加能力不可用。"],
            )

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        rasterio = _rasterio()
        max_size = query.max_size or 4096
        with rasterio.open(path) as src:
            band_index = _band_index_from_variable(query.variable, src.count)
            data, bounds, lat, lon = _read_raster_band_as_wgs84(src, band_index=band_index, max_size=max_size)
            data, lat, lon = crop_grid_with_coords_by_bbox(data, lat, lon, query.bbox)
            data = mask_grid_to_area(data, lat, lon, query.area)
            tags = src.tags(band_index)
            return GridSlice(
                data=data,
                variable=f"band_{band_index}",
                unit=tags.get("units") or tags.get("unit"),
                long_name=tags.get("long_name") or tags.get("description") or f"Band {band_index}",
                lat=lat,
                lon=lon,
                bounds=_bounds_from_coords(lat, lon) or bounds,
                backend="rasterio",
                mask_applied=query.area is not None,
                metadata={"bandIndex": band_index},
            )


class MeteorologicalReaderFacade:
    # Reader 路由器。
    #
    # 上层只构造 GridQuery；具体由哪个 backend 执行在这里决定。
    def __init__(self, readers: list[MeteorologicalDatasetReader] | None = None):
        self.readers = readers or [RasterMapReader(), XarrayScientificReader()]

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        return self._reader_for(path, filename=filename).inspect(path, filename=filename)

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        return self._reader_for(path, filename=filename).read_slice(path, query, filename=filename)

    def _reader_for(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetReader:
        for reader in self.readers:
            if reader.supports(path, filename=filename):
                return reader
        suffix = _effective_suffix(path, filename)
        raise ValueError(f"不支持的气象文件格式：{suffix or 'unknown'}")


def finite_values(data: Any) -> Any:
    np = _np()
    values = np.asarray(data, dtype="float64")
    return values[np.isfinite(values)]


def finite_range(data: Any) -> list[float] | None:
    values = finite_values(data)
    if values.size == 0:
        return None
    return [float(values.min()), float(values.max())]


def crop_grid_with_coords_by_bbox(data: Any, lat: Any | None, lon: Any | None, bbox: list[float] | None) -> tuple[Any, Any | None, Any | None]:
    if bbox is None or lat is None or lon is None:
        return data, lat, lon
    np = _np()
    west, south, east, north = [float(item) for item in bbox]
    lat_values = np.asarray(lat)
    lon_values = np.asarray(lon)
    if lat_values.ndim != 1 or lon_values.ndim != 1:
        return data, lat, lon
    row_mask = (lat_values >= south) & (lat_values <= north)
    col_mask = (lon_values >= west) & (lon_values <= east)
    if not row_mask.any() or not col_mask.any():
        return data[:0, :0], lat_values[:0], lon_values[:0]
    row_indices = np.where(row_mask)[0]
    col_indices = np.where(col_mask)[0]
    return (
        data[row_indices.min() : row_indices.max() + 1, col_indices.min() : col_indices.max() + 1],
        lat_values[row_indices.min() : row_indices.max() + 1],
        lon_values[col_indices.min() : col_indices.max() + 1],
    )


def mask_grid_to_area(data: Any, lat: Any | None, lon: Any | None, area: dict[str, Any] | None) -> Any:
    if area is None:
        return data
    lat_values, lon_values = require_1d_lat_lon_values(data, lat, lon)
    np = _np()
    lon_grid, lat_grid = np.meshgrid(lon_values, lat_values)
    geom = _area_union(area)
    mask = intersects_xy(geom, lon_grid, lat_grid)
    return np.where(mask, data, np.nan)


def require_1d_lat_lon_values(data: Any, lat: Any | None, lon: Any | None) -> tuple[Any, Any]:
    if lat is None or lon is None:
        raise ValueError("该变量没有一维经纬度坐标，无法执行空间裁剪或矢量化。")
    np = _np()
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if lat_values.ndim != 1 or lon_values.ndim != 1:
        raise ValueError("该变量不是规则经纬网格，当前不支持精确空间裁剪。")
    expected = (lat_values.size, lon_values.size)
    if tuple(data.shape[-2:]) != expected:
        raise ValueError("变量网格形状与经纬度坐标长度不一致。")
    return lat_values, lon_values


def coord_edges(values: Any) -> Any:
    np = _np()
    values = np.asarray(values, dtype="float64")
    if values.size < 2:
        delta = 0.01
        return np.array([values[0] - delta / 2, values[0] + delta / 2])
    mids = (values[:-1] + values[1:]) / 2
    first = values[0] - (mids[0] - values[0])
    last = values[-1] + (values[-1] - mids[-1])
    return np.concatenate([[first], mids, [last]])


def _open_xarray_dataset(xr: Any, path: Path, *, suffix: str | None = None) -> tuple[Any, str]:
    suffix = suffix or path.suffix.lower()
    if suffix in {".grib", ".grb", ".grb2"}:
        engines: list[str | None] = ["cfgrib"]
    elif suffix in {".h5", ".hdf5"}:
        engines = ["h5netcdf", None]
    else:
        engines = [None, "netcdf4", "h5netcdf"]
    errors: list[str] = []
    for engine in engines:
        try:
            kwargs = {"engine": engine} if engine else {}
            if engine == "h5netcdf":
                kwargs["phony_dims"] = "access"
            return xr.open_dataset(path, **kwargs), engine or "auto"
        except Exception as exc:
            errors.append(f"{engine or 'auto'}: {exc}")
    raise ValueError("无法读取气象文件；" + "；".join(errors[:3]))


def _effective_suffix(path: Path, filename: str | None = None) -> str:
    # runtime 对象存储使用内容寻址路径，可能没有扩展名；科学格式归属由原始
    # 上传文件名补齐，避免把 hash 路径误判为 unknown。
    path_suffix = path.suffix.lower()
    if path_suffix:
        return path_suffix
    return Path(filename or "").suffix.lower()


def _find_lat_lon_coords(ds: Any) -> tuple[str | None, str | None]:
    lat = lon = None
    for name, coord in ds.coords.items():
        normalized = str(name).casefold()
        units = str(coord.attrs.get("units", "")).casefold()
        standard_name = str(coord.attrs.get("standard_name", "")).casefold()
        if normalized in {"lat", "latitude", "y"} or "degrees_north" in units or standard_name == "latitude":
            lat = str(name)
        if normalized in {"lon", "longitude", "x"} or "degrees_east" in units or standard_name == "longitude":
            lon = str(name)
    return lat, lon


def _find_time_coord(ds: Any) -> str | None:
    for name, coord in ds.coords.items():
        if _is_time_coord(name, coord):
            return str(name)
    return None


def _find_level_coord(ds: Any) -> str | None:
    for name, coord in ds.coords.items():
        if _is_level_coord(name, coord):
            return str(name)
    return None


def _extract_coord_values(ds: Any, coord_name: str | None, *, limit: int = 72) -> list[str]:
    if not coord_name:
        return []
    values = _np().asarray(ds[coord_name].values).ravel()[:limit]
    unit = _attr_text(ds[coord_name], "units")
    return [f"{item} {unit}" if unit and coord_name == _find_level_coord(ds) else str(item) for item in values.tolist()]


def _pick_default_variable(ds: Any, lat_name: str, lon_name: str) -> str:
    for name, data_array in ds.data_vars.items():
        if _is_numeric_dtype(data_array.dtype) and _data_uses_coords(data_array, lat_name, lon_name):
            return str(name)
    raise ValueError("未找到同时包含经纬度坐标的数值变量。")


def _pick_default_numeric_variable(ds: Any) -> str:
    for name, data_array in ds.data_vars.items():
        if not _is_numeric_dtype(data_array.dtype):
            continue
        try:
            _select_2d_data_array(data_array, time_index=0, level_index=0)
        except Exception:
            continue
        return str(name)
    raise ValueError("文件中没有可统计的二维数值型气象变量。")


def _select_2d_data_array(data_array: Any, *, time_index: int | None, level_index: int | None) -> tuple[Any, str | None, str | None]:
    selected = data_array
    time_value: str | None = None
    level_value: str | None = None
    for dim in list(selected.dims):
        if selected.ndim <= 2:
            break
        coord = selected.coords.get(dim)
        is_time = _is_time_coord(dim, coord)
        is_level = _is_level_coord(dim, coord)
        index = int(time_index or 0) if is_time else int(level_index or 0) if is_level else 0
        index = max(0, min(index, int(selected.sizes[dim]) - 1))
        if coord is not None and is_time:
            time_value = str(_np().asarray(coord.values).ravel()[index])
        if coord is not None and is_level:
            raw_level_value = str(_np().asarray(coord.values).ravel()[index])
            unit = _attr_text(coord, "units")
            level_value = f"{raw_level_value} {unit}" if unit else raw_level_value
        selected = selected.isel({dim: index})
    selected = selected.squeeze(drop=True)
    if selected.ndim != 2:
        raise ValueError(f"变量 {data_array.name} 无法收敛成二维网格。")
    return selected, time_value, level_value


def _transpose_to_lat_lon(selected: Any, ds: Any, lat_name: str | None, lon_name: str | None) -> Any:
    if not lat_name or not lon_name:
        return selected
    lat_dim = _coord_primary_dim(ds[lat_name], lat_name)
    lon_dim = _coord_primary_dim(ds[lon_name], lon_name)
    if lat_dim != lon_dim and lat_dim in selected.dims and lon_dim in selected.dims:
        return selected.transpose(lat_dim, lon_dim)
    return selected


def _thin_selected_data_array_for_render(selected: Any, *, max_size: int) -> Any:
    if selected.ndim != 2:
        return selected
    max_size = max(1, int(max_size or 1024))
    height, width = (int(item) for item in selected.shape[-2:])
    stride = max(1, int(math.ceil(max(height / max_size, width / max_size))))
    if stride <= 1:
        return selected
    row_dim, col_dim = selected.dims[-2], selected.dims[-1]
    return selected.isel({row_dim: slice(None, None, stride), col_dim: slice(None, None, stride)})


def _sample_data_array_stats(data_array: Any) -> list[float] | None:
    try:
        selected, _time_value, _level_value = _select_2d_data_array(data_array, time_index=0, level_index=0)
        return finite_range(_normalize_missing_values(_np().asarray(selected.values, dtype="float64"), data_array.attrs))
    except Exception:
        return None


def _data_uses_coords(data_array: Any, lat_name: str, lon_name: str) -> bool:
    dims = set(str(item) for item in data_array.dims)
    return (lat_name in dims and lon_name in dims) or (
        any(str(dim).casefold() in {"lat", "latitude", "y"} for dim in dims)
        and any(str(dim).casefold() in {"lon", "longitude", "x"} for dim in dims)
    )


def _matching_dim_count(data_array: Any, matcher: Any) -> int:
    for dim in data_array.dims:
        coord = data_array.coords.get(dim)
        if matcher(dim, coord):
            return int(data_array.sizes[dim])
    return 0


def _is_time_coord(name: Any, coord: Any | None) -> bool:
    normalized = str(name).casefold()
    attrs = getattr(coord, "attrs", {}) if coord is not None else {}
    return "time" in normalized or str(attrs.get("standard_name", "")).casefold() == "time" or str(attrs.get("axis", "")).casefold() == "t"


def _is_level_coord(name: Any, coord: Any | None) -> bool:
    normalized = str(name).casefold()
    attrs = getattr(coord, "attrs", {}) if coord is not None else {}
    units = str(attrs.get("units", "")).casefold()
    known_names = {"level", "lev", "pressure", "isobaric", "height", "depth", "altitude", "elevation"}
    return (
        normalized in known_names
        or str(attrs.get("axis", "")).casefold() == "z"
        or bool(str(attrs.get("positive", "")).strip())
        or str(attrs.get("standard_name", "")).casefold() in {"air_pressure", "height", "depth", "altitude", "geopotential_height"}
        or units in {"pa", "hpa", "millibar", "mbar"}
    )


def _coord_primary_dim(coord: Any, default_dim: str) -> str:
    return str(coord.dims[0]) if getattr(coord, "dims", None) else default_dim


def _bounds_from_coords(lat: Any, lon: Any) -> list[float] | None:
    np = _np()
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if lat_values.size == 0 or lon_values.size == 0:
        return None
    finite_lat = lat_values[np.isfinite(lat_values)]
    finite_lon = lon_values[np.isfinite(lon_values)]
    if finite_lat.size == 0 or finite_lon.size == 0:
        return None
    return [float(finite_lon.min()), float(finite_lat.min()), float(finite_lon.max()), float(finite_lat.max())]


def _normalize_missing_values(data: Any, attrs: dict[str, Any]) -> Any:
    np = _np()
    result = np.asarray(data, dtype="float64")
    for key in ("_FillValue", "missing_value"):
        if key not in attrs:
            continue
        raw = attrs.get(key)
        candidates = np.asarray(raw).ravel().tolist() if isinstance(raw, (list, tuple)) else [raw]
        for candidate in candidates:
            try:
                result = np.where(result == float(candidate), np.nan, result)
            except (TypeError, ValueError):
                continue
    return result


def _area_union(area: dict[str, Any]) -> Any:
    features = area.get("features") if isinstance(area, dict) else None
    if not isinstance(features, list) or not features:
        raise ValueError("分析区域必须是非空 FeatureCollection。")
    geometries = []
    for feature in features:
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        if geometry:
            geometries.append(shape(geometry))
    if not geometries:
        raise ValueError("分析区域没有有效几何。")
    return unary_union(geometries)


def _raster_bounds_wgs84(src: Any) -> list[float] | None:
    if not src.bounds or not src.crs:
        return None
    try:
        if str(src.crs).upper() not in {"EPSG:4326", "OGC:CRS84"}:
            west, south, east, north = _rasterio_warp().transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
        else:
            west, south, east, north = src.bounds
        return [float(west), float(south), float(east), float(north)]
    except Exception:
        return None


def _raster_band_range(src: Any, band_index: int) -> list[float] | None:
    try:
        data = src.read(band_index, masked=True)
        values = data.compressed() if hasattr(data, "compressed") else finite_values(data)
        if len(values) == 0:
            return None
        return [float(values.min()), float(values.max())]
    except Exception:
        return None


def _read_raster_band_as_wgs84(src: Any, *, band_index: int, max_size: int) -> tuple[Any, list[float] | None, Any | None, Any | None]:
    np = _np()
    max_size = max(1, int(max_size or 1024))
    out_shape = _scaled_shape(src.height, src.width, max_size)
    data = src.read(band_index, out_shape=out_shape, masked=True)
    values = data.filled(np.nan) if hasattr(data, "filled") else data
    bounds = _raster_bounds_wgs84(src)
    if bounds is None:
        return np.asarray(values, dtype="float64"), None, None, None
    west, south, east, north = bounds
    lat = np.linspace(north, south, values.shape[0])
    lon = np.linspace(west, east, values.shape[1])
    return np.asarray(values, dtype="float64"), bounds, lat, lon


def _scaled_shape(height: int, width: int, max_size: int) -> tuple[int, int]:
    scale = max(height / max_size, width / max_size, 1)
    return max(1, int(math.ceil(height / scale))), max(1, int(math.ceil(width / scale)))


def _band_index_from_variable(variable: str | None, band_count: int) -> int:
    if variable and variable.startswith("band_"):
        try:
            index = int(variable.split("_", 1)[1])
            return max(1, min(index, band_count))
        except ValueError:
            pass
    return 1


def _is_numeric_dtype(dtype: Any) -> bool:
    return _np().issubdtype(dtype, _np().number)


def _attr_text(data_array: Any, key: str) -> str | None:
    value = getattr(data_array, "attrs", {}).get(key)
    return None if value is None else str(value)


def _format_label(suffix: str) -> str:
    return {".nc": "NetCDF", ".nc4": "NetCDF", ".grib": "GRIB", ".grb": "GRIB", ".grb2": "GRIB2", ".h5": "HDF5", ".hdf5": "HDF5"}.get(suffix, suffix.upper().lstrip("."))


def _np() -> Any:
    import numpy as np
    return np


def _xarray() -> Any:
    import xarray as xr
    return xr


def _rasterio() -> Any:
    import rasterio
    return rasterio


def _rasterio_warp() -> Any:
    import rasterio.warp
    return rasterio.warp
