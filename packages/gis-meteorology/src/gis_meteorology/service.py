# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据解析服务
#
#   文件:       service.py
#
#   日期:       2026年05月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 解析 NetCDF / GRIB / HDF5 / GeoTIFF / 雷达原始数据等气象科学数据，
# 并把多维数组转成平台可消费的 metadata、PNG 热力图、GeoJSON 阈值区和等值线。

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shapely import intersects_xy
from shapely.geometry import LineString, mapping, box, shape
from shapely.ops import unary_union

from .radar import decode_radar_bz2, radar_product_to_grid
from .readers import GridQuery, GridSlice, MeteorologicalDatasetIndex, MeteorologicalReaderFacade
from .report import write_meteorological_report_docx

SUPPORTED_METEOROLOGICAL_SUFFIXES = {".nc", ".nc4", ".tif", ".tiff", ".grib", ".grb", ".grb2", ".h5", ".hdf5", ".bz2"}


def is_supported_meteorological_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_METEOROLOGICAL_SUFFIXES


@dataclass(frozen=True)
class MeteorologicalGrid:
    # 运行时网格切片
    #
    # data 是二维数值矩阵；lat/lon 为一维坐标时可做阈值区和等值线，
    # bounds 则是 raster overlay 的最小地图定位事实。
    data: Any
    variable: str
    unit: str | None
    long_name: str | None
    time_value: str | None
    level_value: str | None
    lat: Any | None
    lon: Any | None
    bounds: list[float] | None
    source_kind: str


class MeteorologicalDataService:
    def __init__(self, *, reader_facade: MeteorologicalReaderFacade | None = None):
        # 统一 reader 门面。
        #
        # 新能力优先走 GridQuery/GridSlice；旧 API 继续保持返回形态兼容，
        # 让短时临近预报（短临）和普通气象分析共享同一套读取抽象。
        self.reader_facade = reader_facade or MeteorologicalReaderFacade()

    def inspect_index(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        return self.reader_facade.inspect(path, filename=filename)

    def read_grid_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        return self.reader_facade.read_slice(path, query, filename=filename)

    def inspect(self, path: Path, *, filename: str | None = None) -> dict[str, Any]:
        # 文件画像入口。
        #
        # 解析阶段只输出轻量 metadata；原始数组继续留在 runtime 文件里，
        # 后续 render/stats/threshold/contours 再按需读取。
        suffix = _effective_suffix(path, filename)
        if suffix not in SUPPORTED_METEOROLOGICAL_SUFFIXES:
            raise ValueError(f"不支持的气象文件格式：{suffix or 'unknown'}")
        if suffix == ".bz2":
            return self._inspect_radar(path, filename=filename)
        if suffix in {".tif", ".tiff"}:
            return self._inspect_raster(path, filename=filename)
        try:
            return self._inspect_xarray(path, suffix=suffix, filename=filename)
        except Exception as exc:
            if suffix in {".h5", ".hdf5"}:
                h5py_metadata = self._inspect_hdf5(path, filename=filename)
                h5py_metadata["warnings"] = [
                    *h5py_metadata.get("warnings", []),
                    f"未能按 CF/xarray 方式读取：{exc}",
                ]
                return h5py_metadata
            raise

    def render_heatmap(
        self,
        path: Path,
        *,
        output_path: Path,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
        max_size: int = 1024,
    ) -> dict[str, Any]:
        grid = self._read_map_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index, max_size=max_size)
        if not grid.bounds:
            raise ValueError("该气象变量没有可用地理范围，无法渲染到地图。")
        data, lat, lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        data = _mask_grid_to_area(data, lat, lon, area)
        data, lat, lon = _downsample_grid_for_render(data, lat, lon, max_size=max_size)
        bounds = _bounds_from_coords(lat, lon) or grid.bounds
        data, bounds = _orient_grid_for_map(data, lat, lon, bounds)
        if _finite_range(data) is None:
            raise ValueError("分析区域与该气象变量没有重叠像元，无法渲染地图。")
        image = _colorize_grid(data)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path)
        value_range = _finite_range(data)
        west, south, east, north = bounds
        return {
            "variable": grid.variable,
            "unit": grid.unit,
            "longName": grid.long_name,
            "timeValue": grid.time_value,
            "levelValue": grid.level_value,
            "bounds": bounds,
            "coordinates": [[west, north], [east, north], [east, south], [west, south]],
            "valueRange": value_range,
            "width": image.width,
            "height": image.height,
            "backend": grid.source_kind,
        }

    def stats(
        self,
        path: Path,
        *,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        grid = self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)
        data, lat, lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        data = _mask_grid_to_area(data, lat, lon, area)
        values = _finite_values(data)
        if values.size == 0:
            return {
                "variable": grid.variable,
                "unit": grid.unit,
                "timeValue": grid.time_value,
                "levelValue": grid.level_value,
                "count": 0,
            }
        median = float(_np().percentile(values, 50))
        return {
            "variable": grid.variable,
            "unit": grid.unit,
            "longName": grid.long_name,
            "timeValue": grid.time_value,
            "levelValue": grid.level_value,
            "count": int(values.size),
            "min": float(values.min()),
            "max": float(values.max()),
            "mean": float(values.mean()),
            "median": median,
            "p50": median,
            "p90": float(_np().percentile(values, 90)),
        }

    def threshold_geojson(
        self,
        path: Path,
        *,
        threshold: float,
        operator: str = ">=",
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
        max_cells: int = 20000,
    ) -> dict[str, Any]:
        grid = self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)
        data, cropped_lat, cropped_lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        data = _mask_grid_to_area(data, cropped_lat, cropped_lon, area)
        lat, lon = _require_1d_lat_lon_values(data, cropped_lat, cropped_lon)
        mask = _compare(data, threshold, operator)
        selected_count = int(_np().count_nonzero(mask))
        if selected_count == 0:
            return {"type": "FeatureCollection", "features": []}
        if selected_count > max_cells:
            raise ValueError(f"阈值命中 {selected_count} 个网格，超过当前上限 {max_cells}，请先缩小范围或提高阈值。")

        lat_edges = _coord_edges(lat)
        lon_edges = _coord_edges(lon)
        polygons = []
        rows, cols = _np().where(mask)
        for row, col in zip(rows.tolist(), cols.tolist(), strict=False):
            south, north = sorted((float(lat_edges[row]), float(lat_edges[row + 1])))
            west, east = sorted((float(lon_edges[col]), float(lon_edges[col + 1])))
            polygons.append(box(west, south, east, north))
        merged = unary_union(polygons)
        if area is not None:
            merged = merged.intersection(_area_union(area))
        if merged.is_empty:
            return {"type": "FeatureCollection", "features": []}
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "variable": grid.variable,
                        "unit": grid.unit,
                        "threshold": threshold,
                        "operator": operator,
                        "cell_count": selected_count,
                        "time_value": grid.time_value,
                        "level_value": grid.level_value,
                    },
                    "geometry": mapping(merged),
                }
            ],
        }

    def contours_geojson(
        self,
        path: Path,
        *,
        levels: list[float] | None = None,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        contourpy = _contourpy()
        grid = self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)
        data, cropped_lat, cropped_lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        area_geom = _area_union(area) if area is not None else None
        data = _mask_grid_to_area(data, cropped_lat, cropped_lon, area)
        lat, lon = _require_1d_lat_lon_values(data, cropped_lat, cropped_lon)
        data, lat, lon = _orient_grid_for_contours(data, lat, lon)
        finite_range = _finite_range(data)
        if finite_range is None:
            return {"type": "FeatureCollection", "features": []}
        if not levels:
            low, high = finite_range
            if math.isclose(low, high):
                levels = [low]
            else:
                levels = [float(item) for item in _np().linspace(low, high, 7)[1:-1]]

        generator = contourpy.contour_generator(x=lon, y=lat, z=data, name="serial")
        features: list[dict[str, Any]] = []
        for level in levels:
            for line in generator.lines(float(level)):
                if len(line) < 2:
                    continue
                geometry = LineString([(float(x), float(y)) for x, y in line])
                if area_geom is not None:
                    geometry = geometry.intersection(area_geom)
                if geometry.is_empty:
                    continue
                features.extend(
                    _geometry_to_features(
                        geometry,
                        properties={
                            "variable": grid.variable,
                            "unit": grid.unit,
                            "level": float(level),
                            "time_value": grid.time_value,
                            "level_value": grid.level_value,
                        },
                    )
                )
        return {"type": "FeatureCollection", "features": features}

    def generate_report_docx(
        self,
        path: Path,
        *,
        output_path: Path,
        filename: str | None = None,
        dataset_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        llm_interpretation: str = "",
        max_variables: int = 12,
        stats_variable_limit: int = 8,
    ) -> dict[str, Any]:
        # 正式解读报告。
        #
        # 报告事实来源只包括 inspect metadata 和按变量读取的统计切片；
        # 不读取 Agent 历史，也不把无法统计的变量伪装成成功结论。
        if not llm_interpretation.strip():
            raise ValueError("生成 DOCX 解读报告必须提供大模型解读正文。")
        report_metadata = metadata if isinstance(metadata, dict) and metadata.get("variables") else self.inspect(path, filename=filename)
        variables = _report_variables(report_metadata, limit=max_variables)
        stats_rows: list[dict[str, Any]] = []
        for variable in variables[: max(0, int(stats_variable_limit))]:
            name = str(variable.get("name") or "").strip()
            if not name or not variable.get("analysisReady", True):
                continue
            try:
                stats_rows.append(self.stats(path, filename=filename, variable=name))
            except Exception as exc:
                stats_rows.append({"variable": name, "error": str(exc).strip() or exc.__class__.__name__})
        return write_meteorological_report_docx(
            output_path=output_path,
            dataset_id=dataset_id,
            filename=filename or path.name,
            metadata={**report_metadata, "variables": variables},
            stats_rows=stats_rows,
            llm_interpretation=llm_interpretation.strip(),
            generated_at=now_report_timestamp(),
        )

    def read_grid(
        self,
        path: Path,
        *,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
    ) -> MeteorologicalGrid:
        suffix = _effective_suffix(path, filename)
        if suffix == ".bz2":
            return self._read_radar_grid(path, variable=variable, elevation_index=time_index)
        if suffix in {".tif", ".tiff"}:
            return self._read_raster_grid(path, variable=variable)
        try:
            return self._read_xarray_grid(path, suffix=suffix, variable=variable, time_index=time_index, level_index=level_index)
        except Exception as exc:
            if suffix in {".h5", ".hdf5"}:
                return self._read_hdf5_grid(path, variable=variable, xarray_error=exc)
            raise

    def _read_map_grid(
        self,
        path: Path,
        *,
        filename: str | None,
        variable: str | None,
        time_index: int | None,
        level_index: int | None,
        max_size: int,
    ) -> MeteorologicalGrid:
        suffix = _effective_suffix(path, filename)
        if suffix in {".nc", ".nc4"}:
            raster_grid = self._read_netcdf_raster_grid(
                path,
                variable=variable,
                time_index=time_index,
                level_index=level_index,
                max_size=max_size,
            )
            if raster_grid is not None:
                return raster_grid
        if suffix not in {".bz2", ".tif", ".tiff", ".h5", ".hdf5"}:
            return self._read_xarray_grid(
                path,
                suffix=suffix,
                variable=variable,
                time_index=time_index,
                level_index=level_index,
                max_size=max_size,
            )
        return self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)

    def _inspect_xarray(self, path: Path, *, suffix: str, filename: str | None) -> dict[str, Any]:
        xr = _xarray()
        ds, engine = _open_xarray_dataset(xr, path, suffix)
        try:
            lat_name, lon_name = _find_lat_lon_coords(ds)
            level_name = _find_level_coord(ds)
            bounds = _bounds_from_coords(ds[lat_name].values, ds[lon_name].values) if lat_name and lon_name else None
            raster_variables, raster_summary, raster_warnings = (
                self._inspect_netcdf_rasterio(path) if suffix in {".nc", ".nc4"} else ({}, {}, [])
            )
            variables = []
            for name, data_array in ds.data_vars.items():
                if not _is_numeric_dtype(data_array.dtype):
                    continue
                stats = _sample_data_array_stats(data_array)
                time_count = _matching_dim_count(data_array, _is_time_coord)
                level_count = _matching_dim_count(data_array, _is_level_coord)
                xarray_map_ready = bool(lat_name and lon_name and _data_uses_coords(data_array, lat_name, lon_name))
                raster_meta = raster_variables.get(str(name).casefold())
                raster_map_ready = bool(raster_meta and raster_meta.get("mapReady"))
                backends = [
                    {
                        "name": "xarray",
                        "analysisReady": stats is not None,
                        "mapReady": xarray_map_ready,
                        "bounds": bounds if xarray_map_ready else None,
                    }
                ]
                if raster_meta:
                    backends.append({"name": "rasterio", **raster_meta})
                preferred_backend = "rasterio" if raster_map_ready else "xarray" if stats is not None else "none"
                variables.append(
                    {
                        "name": str(name),
                        "dimensions": [str(item) for item in data_array.dims],
                        "shape": [int(item) for item in data_array.shape],
                        "dataType": str(data_array.dtype),
                        "unit": _attr_text(data_array, "units"),
                        "longName": _attr_text(data_array, "long_name") or _attr_text(data_array, "standard_name"),
                        "valueRange": stats,
                        "timeCount": time_count,
                        "levelCount": level_count,
                        "bounds": raster_meta.get("bounds") if raster_meta and raster_meta.get("bounds") else bounds if xarray_map_ready else None,
                        "mapReady": raster_map_ready or xarray_map_ready,
                        "analysisReady": stats is not None,
                        "preferredBackend": preferred_backend,
                        "backends": backends,
                    }
                )
            if not variables:
                raise ValueError("文件中没有可识别的数值型气象变量。")
            warnings = [] if bounds else ["未识别到经纬度坐标，地图叠加能力不可用。"]
            warnings.extend(raster_warnings)
            return {
                "filename": filename or path.name,
                "format": _format_label(suffix),
                "engine": engine,
                "variables": variables,
                "coordinates": {"latitude": lat_name, "longitude": lon_name, "time": _find_time_coord(ds), "level": level_name},
                "times": _extract_time_values(ds),
                "levels": _extract_level_values(ds),
                "bounds": bounds,
                "isGeoreferenced": bounds is not None,
                "backendSummary": {"xarray": {"engine": engine}, "rasterio": raster_summary},
                "warnings": warnings,
            }
        finally:
            ds.close()

    def _read_xarray_grid(
        self,
        path: Path,
        *,
        suffix: str,
        variable: str | None,
        time_index: int | None,
        level_index: int | None,
        max_size: int | None = None,
    ) -> MeteorologicalGrid:
        xr = _xarray()
        ds, _engine = _open_xarray_dataset(xr, path, suffix)
        try:
            lat_name, lon_name = _find_lat_lon_coords(ds)
            variable_name = variable or (
                _pick_default_variable(ds, lat_name, lon_name)
                if lat_name and lon_name
                else _pick_default_numeric_variable(ds)
            )
            if variable_name not in ds.data_vars:
                raise ValueError(f"气象变量不存在：{variable_name}")
            data_array = ds[variable_name]
            selected, time_value, level_value = _select_2d_data_array(data_array, time_index=time_index, level_index=level_index)
            if lat_name and lon_name:
                lat_dim = _coord_primary_dim(ds[lat_name], lat_name)
                lon_dim = _coord_primary_dim(ds[lon_name], lon_name)
                if lat_dim != lon_dim and lat_dim in selected.dims and lon_dim in selected.dims:
                    selected = selected.transpose(lat_dim, lon_dim)
            if max_size is not None:
                selected = _thin_selected_data_array_for_render(selected, max_size=max_size)
            lat = selected.coords[lat_name].values if lat_name and lat_name in selected.coords else ds[lat_name].values if lat_name else None
            lon = selected.coords[lon_name].values if lon_name and lon_name in selected.coords else ds[lon_name].values if lon_name else None
            data = _np().asarray(selected.values, dtype="float64")
            data = _normalize_missing_values(data, data_array.attrs)
            return MeteorologicalGrid(
                data=data,
                variable=variable_name,
                unit=_attr_text(data_array, "units"),
                long_name=_attr_text(data_array, "long_name") or _attr_text(data_array, "standard_name"),
                time_value=time_value,
                level_value=level_value,
                lat=lat,
                lon=lon,
                bounds=_bounds_from_coords(lat, lon) if lat is not None and lon is not None else None,
                source_kind="xarray",
            )
        finally:
            ds.close()

    def _inspect_netcdf_rasterio(self, path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any], list[str]]:
        # rasterio/GDAL 只记录地图执行元数据。
        #
        # 变量语义仍以 xarray 为准；这里建立稳定 subdatasetId，避免把
        # GDAL 内部字符串暴露成模型需要手抄的参数。
        try:
            rasterio = _rasterio()
            with rasterio.open(path) as src:
                subdatasets = list(src.subdatasets or [])
                root_bounds = _raster_bounds_wgs84(src)
        except Exception as exc:
            return {}, {"available": False, "variables": 0}, [f"rasterio/GDAL 未能读取 NetCDF 子数据集：{exc}"]

        if not subdatasets:
            return {}, {"available": False, "variables": 0, "subdatasets": []}, []

        by_variable: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []
        for subdataset in subdatasets:
            variable_name = _subdataset_variable_name(subdataset)
            try:
                with rasterio.open(subdataset) as src:
                    bounds = _raster_bounds_wgs84(src)
                    tags = {str(key): value for key, value in src.tags().items()}
                    by_variable[variable_name.casefold()] = {
                        "subdatasetId": _subdataset_ref_id(subdataset),
                        "variable": variable_name,
                        "mapReady": bounds is not None,
                        "bounds": bounds,
                        "crs": str(src.crs) if src.crs else None,
                        "width": int(src.width),
                        "height": int(src.height),
                        "bandCount": int(src.count),
                        "dataTypes": [str(item) for item in src.dtypes],
                        "tags": tags,
                    }
            except Exception as exc:
                warnings.append(f"rasterio/GDAL 子数据集 {variable_name} 读取失败：{exc}")
        summary = {
            "available": bool(by_variable),
            "variables": len(by_variable),
            "rootBounds": root_bounds,
            "subdatasets": [
                {"variable": item["variable"], "subdatasetId": item["subdatasetId"], "mapReady": item["mapReady"]}
                for item in by_variable.values()
            ],
        }
        return by_variable, summary, warnings

    def _read_netcdf_raster_grid(
        self,
        path: Path,
        *,
        variable: str | None,
        time_index: int | None,
        level_index: int | None,
        max_size: int,
    ) -> MeteorologicalGrid | None:
        try:
            rasterio = _rasterio()
            with rasterio.open(path) as root:
                subdatasets = list(root.subdatasets or [])
        except Exception:
            return None
        if not subdatasets:
            return None

        selected_subdataset = _select_subdataset(subdatasets, variable)
        if selected_subdataset is None:
            return None

        with rasterio.open(selected_subdataset) as src:
            # 多 band NetCDF 通常来自 time/level 等科学维度。为避免错误摊平，
            # 这类切片继续交给 xarray；单 band 才使用 GDAL 执行层直接渲染。
            if src.count != 1:
                return None
            data, bounds, lat, lon = _read_raster_band_as_wgs84(src, band_index=1, max_size=max_size)
            if bounds is None:
                return None
            tags = src.tags(1)
            variable_name = _subdataset_variable_name(selected_subdataset)
            return MeteorologicalGrid(
                data=data,
                variable=variable_name,
                unit=tags.get("units") or tags.get("unit"),
                long_name=tags.get("long_name") or tags.get("description") or variable_name,
                time_value=str(time_index) if time_index is not None else None,
                level_value=str(level_index) if level_index is not None else None,
                lat=lat,
                lon=lon,
                bounds=bounds,
                source_kind="rasterio",
            )

    def _inspect_raster(self, path: Path, *, filename: str | None) -> dict[str, Any]:
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
                        "mapReady": bounds is not None,
                        "analysisReady": True,
                        "preferredBackend": "rasterio",
                        "backends": [
                            {
                                "name": "rasterio",
                                "analysisReady": True,
                                "mapReady": bounds is not None,
                                "bounds": bounds,
                                "crs": str(src.crs) if src.crs else None,
                            }
                        ],
                    }
                )
            return {
                "filename": filename or path.name,
                "format": "GeoTIFF",
                "engine": "rasterio",
                "variables": variables,
                "coordinates": {"latitude": "y", "longitude": "x", "time": None, "level": None},
                "times": [],
                "levels": [],
                "bounds": bounds,
                "crs": str(src.crs) if src.crs else None,
                "isGeoreferenced": bounds is not None,
                "warnings": [] if bounds else ["GeoTIFF 缺少 CRS 或 bounds，地图叠加能力不可用。"],
            }

    def _read_raster_grid(self, path: Path, *, variable: str | None) -> MeteorologicalGrid:
        rasterio = _rasterio()
        with rasterio.open(path) as src:
            band_index = _band_index_from_variable(variable, src.count)
            data, bounds, lat, lon = _read_raster_band_as_wgs84(src, band_index=band_index, max_size=4096)
            tags = src.tags(band_index)
            return MeteorologicalGrid(
                data=data,
                variable=f"band_{band_index}",
                unit=tags.get("units") or tags.get("unit"),
                long_name=tags.get("long_name") or tags.get("description") or f"Band {band_index}",
                time_value=None,
                level_value=None,
                lat=lat,
                lon=lon,
                bounds=bounds,
                source_kind="raster",
            )

    def _inspect_hdf5(self, path: Path, *, filename: str | None) -> dict[str, Any]:
        h5py = _h5py()
        variables: list[dict[str, Any]] = []
        with h5py.File(path, "r") as handle:
            def visit(name: str, obj: Any) -> None:
                if not hasattr(obj, "shape") or not hasattr(obj, "dtype"):
                    return
                if len(obj.shape) < 2 or not _is_numeric_dtype(obj.dtype):
                    return
                variables.append(
                    {
                        "name": name,
                        "dimensions": [f"dim_{index}" for index in range(len(obj.shape))],
                        "shape": [int(item) for item in obj.shape],
                        "dataType": str(obj.dtype),
                        "unit": _decode_attr(obj.attrs.get("units") or obj.attrs.get("unit")),
                        "longName": _decode_attr(obj.attrs.get("long_name") or obj.attrs.get("description")),
                        "timeCount": 0,
                        "levelCount": 0,
                        "mapReady": False,
                        "analysisReady": True,
                        "preferredBackend": "h5py",
                        "backends": [{"name": "h5py", "analysisReady": True, "mapReady": False, "bounds": None}],
                    }
                )
            handle.visititems(visit)
        if not variables:
            raise ValueError("HDF5 文件中没有可识别的二维数值数据集。")
        return {
            "filename": filename or path.name,
            "format": "HDF5",
            "engine": "h5py",
            "variables": variables,
            "coordinates": {"latitude": None, "longitude": None, "time": None, "level": None},
            "times": [],
            "levels": [],
            "bounds": None,
            "isGeoreferenced": False,
            "warnings": ["该 HDF5 文件未按 CF 坐标约定暴露经纬度；可查看变量与统计，但不能直接叠加地图。"],
        }

    def _read_hdf5_grid(self, path: Path, *, variable: str | None, xarray_error: Exception | None = None) -> MeteorologicalGrid:
        h5py = _h5py()
        selected_name: str | None = None
        selected_data = None
        selected_attrs: dict[str, Any] = {}
        with h5py.File(path, "r") as handle:
            def visit(name: str, obj: Any) -> None:
                nonlocal selected_name, selected_data, selected_attrs
                if selected_data is not None:
                    return
                if not hasattr(obj, "shape") or not hasattr(obj, "dtype"):
                    return
                if len(obj.shape) < 2 or not _is_numeric_dtype(obj.dtype):
                    return
                if variable and name != variable:
                    return
                raw = _np().asarray(obj[()], dtype="float64")
                while raw.ndim > 2:
                    raw = raw[0]
                if raw.ndim != 2:
                    return
                selected_name = name
                selected_data = raw
                selected_attrs = {str(key): value for key, value in obj.attrs.items()}

            handle.visititems(visit)

        if selected_data is None or selected_name is None:
            suffix = f"：{variable}" if variable else ""
            raise ValueError(f"HDF5 文件中没有可统计的二维数值数据集{suffix}")
        data = _normalize_missing_values(selected_data, selected_attrs)
        long_name = _decode_attr(selected_attrs.get("long_name") or selected_attrs.get("description"))
        if xarray_error is not None:
            long_name = long_name or f"h5py backend after CF/xarray read error: {xarray_error}"
        return MeteorologicalGrid(
            data=data,
            variable=selected_name,
            unit=_decode_attr(selected_attrs.get("units") or selected_attrs.get("unit")),
            long_name=long_name,
            time_value=None,
            level_value=None,
            lat=None,
            lon=None,
            bounds=None,
            source_kind="hdf5",
        )

    def _inspect_radar(self, path: Path, *, filename: str | None) -> dict[str, Any]:
        decoded = decode_radar_bz2(path)
        variables = []
        for product in decoded.products.values():
            variables.append(
                {
                    "name": product.name,
                    "dimensions": ["elevation", "azimuth", "range"],
                    "shape": [int(item) for item in product.data.shape],
                    "dataType": str(product.data.dtype),
                    "unit": product.unit,
                    "longName": product.long_name,
                    "valueRange": _finite_range(product.data),
                    "timeCount": len(product.elevations),
                    "levelCount": 0,
                    "mapReady": True,
                    "analysisReady": True,
                    "preferredBackend": "radar",
                    "backends": [{"name": "radar", "analysisReady": True, "mapReady": True, "bounds": decoded.bounds}],
                    "elevations": product.elevations,
                }
            )
        return {
            "filename": filename or path.name,
            "format": "Radar BZ2 Raw",
            "engine": "gis_meteorology.radar",
            "variables": variables,
            "coordinates": {"latitude": "generated_lat", "longitude": "generated_lon", "time": "elevation_index", "level": None},
            "times": [f"{value:.2f}°" for value in next(iter(decoded.products.values())).elevations],
            "levels": [],
            "bounds": decoded.bounds,
            "isGeoreferenced": True,
            "radar": {
                "latitude": decoded.latitude,
                "longitude": decoded.longitude,
                "heightM": decoded.height_m,
                "radarType": decoded.radar_type,
                "rangeKm": decoded.range_km,
            },
            "warnings": ["雷达原始径向数据已按站点和量程转换为近似 WGS84 笛卡尔网格，用于第一版地图叠加与统计。"],
        }

    def _read_radar_grid(self, path: Path, *, variable: str | None, elevation_index: int | None) -> MeteorologicalGrid:
        decoded = decode_radar_bz2(path)
        data, lat, lon, product, selected_index = radar_product_to_grid(decoded, variable=variable, elevation_index=elevation_index)
        elevation_value = product.elevations[selected_index] if selected_index < len(product.elevations) else None
        return MeteorologicalGrid(
            data=data,
            variable=product.name,
            unit=product.unit,
            long_name=product.long_name,
            time_value=f"{elevation_value:.2f}°" if elevation_value is not None else None,
            level_value=None,
            lat=lat,
            lon=lon,
            bounds=decoded.bounds,
            source_kind="radar_bz2",
        )


def _open_xarray_dataset(xr: Any, path: Path, suffix: str) -> tuple[Any, str]:
    engines: list[str | None]
    if suffix in {".grib", ".grb", ".grb2"}:
        engines = ["cfgrib"]
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
    # runtime 的内容寻址对象可以没有扩展名；原始上传文件名是格式识别事实。
    # 如果真实路径已经有扩展名，则以路径为准，避免 filename 元数据覆盖磁盘事实。
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


def _extract_time_values(ds: Any, *, limit: int = 48) -> list[str]:
    time_name = _find_time_coord(ds)
    if not time_name:
        return []
    values = _np().asarray(ds[time_name].values).ravel()[:limit]
    return [str(item) for item in values.tolist()]


def _extract_level_values(ds: Any, *, limit: int = 48) -> list[str]:
    level_name = _find_level_coord(ds)
    if not level_name:
        return []
    values = _np().asarray(ds[level_name].values).ravel()[:limit]
    unit = _attr_text(ds[level_name], "units")
    return [f"{item} {unit}" if unit else str(item) for item in values.tolist()]


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


def _data_uses_coords(data_array: Any, lat_name: str, lon_name: str) -> bool:
    dims = set(str(item) for item in data_array.dims)
    return (lat_name in dims and lon_name in dims) or (
        any(str(dim).casefold() in {"lat", "latitude", "y"} for dim in dims)
        and any(str(dim).casefold() in {"lon", "longitude", "x"} for dim in dims)
    )


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
        if is_time:
            index = int(time_index or 0)
        elif is_level:
            index = int(level_index or 0)
        else:
            index = 0
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


def _thin_selected_data_array_for_render(selected: Any, *, max_size: int) -> Any:
    # xarray 渲染路径的预读取降采样。
    #
    # 只在地图渲染中按 stride 读取展示尺寸所需像元；统计路径保持完整数组。
    if selected.ndim != 2:
        return selected
    max_size = max(1, int(max_size or 1024))
    height, width = (int(item) for item in selected.shape[-2:])
    stride = max(1, int(math.ceil(max(height / max_size, width / max_size))))
    if stride <= 1:
        return selected
    row_dim, col_dim = selected.dims[-2], selected.dims[-1]
    return selected.isel({row_dim: slice(None, None, stride), col_dim: slice(None, None, stride)})


def _is_time_coord(name: Any, coord: Any | None) -> bool:
    normalized = str(name).casefold()
    standard_name = str(getattr(coord, "attrs", {}).get("standard_name", "")).casefold() if coord is not None else ""
    axis = str(getattr(coord, "attrs", {}).get("axis", "")).casefold() if coord is not None else ""
    return "time" in normalized or "datetime" in normalized or standard_name == "time" or axis == "t"


def _is_level_coord(name: Any, coord: Any | None) -> bool:
    normalized = str(name).casefold()
    attrs = getattr(coord, "attrs", {}) if coord is not None else {}
    standard_name = str(attrs.get("standard_name", "")).casefold()
    axis = str(attrs.get("axis", "")).casefold()
    positive = str(attrs.get("positive", "")).casefold()
    units = str(attrs.get("units", "")).casefold()
    known_names = {"level", "lev", "pressure", "isobaric", "height", "depth", "altitude", "elevation"}
    return (
        normalized in known_names
        or axis == "z"
        or bool(positive)
        or standard_name in {"air_pressure", "height", "depth", "altitude", "geopotential_height"}
        or units in {"pa", "hpa", "millibar", "mbar"}
    )


def _matching_dim_count(data_array: Any, matcher: Any) -> int:
    for dim in data_array.dims:
        coord = data_array.coords.get(dim)
        if matcher(dim, coord):
            return int(data_array.sizes[dim])
    return 0


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


def _sample_data_array_stats(data_array: Any) -> list[float] | None:
    try:
        selected, _time_value, _level_value = _select_2d_data_array(data_array, time_index=0, level_index=0)
        return _finite_range(_normalize_missing_values(_np().asarray(selected.values, dtype="float64"), data_array.attrs))
    except Exception:
        return None


def _report_variables(metadata: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    raw_variables = metadata.get("variables")
    if not isinstance(raw_variables, list):
        return []
    variables = [item for item in raw_variables if isinstance(item, dict)]
    return variables[: max(1, int(limit or 12))]


def now_report_timestamp() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def _raster_bounds_wgs84(src: Any) -> list[float] | None:
    if not src.bounds:
        return None
    if not src.crs:
        return None
    try:
        if str(src.crs).upper() not in {"EPSG:4326", "OGC:CRS84"}:
            transform_bounds = _rasterio_warp().transform_bounds
            west, south, east, north = transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
        else:
            west, south, east, north = src.bounds
        return [float(west), float(south), float(east), float(north)]
    except Exception:
        return None


def _raster_band_range(src: Any, band_index: int) -> list[float] | None:
    try:
        data = src.read(band_index, masked=True)
        values = data.compressed() if hasattr(data, "compressed") else _finite_values(data)
        if len(values) == 0:
            return None
        return [float(values.min()), float(values.max())]
    except Exception:
        return None


def _read_raster_band_as_wgs84(src: Any, *, band_index: int, max_size: int) -> tuple[Any, list[float] | None, Any | None, Any | None]:
    np = _np()
    max_size = max(1, int(max_size or 1024))
    if src.crs and str(src.crs).upper() not in {"EPSG:4326", "OGC:CRS84"}:
        warp = _rasterio_warp()
        transform_mod = _rasterio_transform()
        resampling = _rasterio_resampling().bilinear
        transform, width, height = warp.calculate_default_transform(src.crs, "EPSG:4326", src.width, src.height, *src.bounds)
        scale = max(width / max_size, height / max_size, 1)
        out_width = max(1, int(math.ceil(width / scale)))
        out_height = max(1, int(math.ceil(height / scale)))
        if out_width != width or out_height != height:
            transform = transform * transform.scale(width / out_width, height / out_height)
        destination = np.full((out_height, out_width), np.nan, dtype="float64")
        warp.reproject(
            source=_rasterio().band(src, band_index),
            destination=destination,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=transform,
            dst_crs="EPSG:4326",
            dst_nodata=np.nan,
            resampling=resampling,
        )
        west, south, east, north = transform_mod.array_bounds(out_height, out_width, transform)
        bounds = [float(west), float(south), float(east), float(north)]
        lat = np.linspace(float(north), float(south), out_height)
        lon = np.linspace(float(west), float(east), out_width)
        return destination, bounds, lat, lon

    scale = max(src.width / max_size, src.height / max_size, 1)
    out_width = max(1, int(math.ceil(src.width / scale)))
    out_height = max(1, int(math.ceil(src.height / scale)))
    data = src.read(
        band_index,
        masked=True,
        out_shape=(out_height, out_width),
        resampling=_rasterio_resampling().bilinear,
    )
    values = data.filled(np.nan) if hasattr(data, "filled") else np.asarray(data, dtype="float64")
    values = values.astype("float64")
    if src.nodata is not None:
        values[values == src.nodata] = np.nan
    bounds = _raster_bounds_wgs84(src)
    lat = lon = None
    if bounds:
        west, south, east, north = bounds
        lat = np.linspace(float(north), float(south), out_height)
        lon = np.linspace(float(west), float(east), out_width)
    return values, bounds, lat, lon


def _select_subdataset(subdatasets: list[str], variable: str | None) -> str | None:
    if not subdatasets:
        return None
    if not variable:
        return subdatasets[0]
    normalized = variable.casefold()
    for subdataset in subdatasets:
        if _subdataset_variable_name(subdataset).casefold() == normalized:
            return subdataset
    return None


def _subdataset_variable_name(subdataset: str) -> str:
    candidate = subdataset.rsplit(":", 1)[-1].strip().strip('"').strip("'")
    if "/" in candidate:
        candidate = candidate.rsplit("/", 1)[-1]
    return candidate or "variable"


def _subdataset_ref_id(subdataset: str) -> str:
    return f"subdataset:{hashlib.sha1(subdataset.encode('utf-8')).hexdigest()[:16]}"


def _band_index_from_variable(variable: str | None, count: int) -> int:
    if not variable:
        return 1
    normalized = variable.casefold().replace("band_", "")
    try:
        index = int(normalized)
    except ValueError as exc:
        raise ValueError(f"GeoTIFF 变量名应为 band_N：{variable}") from exc
    if index < 1 or index > count:
        raise ValueError(f"GeoTIFF 波段超出范围：{variable}")
    return index


def _normalize_missing_values(data: Any, attrs: dict[str, Any]) -> Any:
    np = _np()
    result = np.asarray(data, dtype="float64")
    for key in ("_FillValue", "missing_value"):
        if key not in attrs:
            continue
        missing = np.asarray(attrs[key]).ravel()
        for value in missing:
            result[result == float(value)] = np.nan
    return result


def _downsample_grid_for_render(data: Any, lat: Any | None, lon: Any | None, *, max_size: int) -> tuple[Any, Any | None, Any | None]:
    np = _np()
    values = np.asarray(data, dtype="float64")
    if values.ndim != 2:
        return values, lat, lon
    max_size = max(1, int(max_size or 1024))
    stride = max(1, int(math.ceil(max(values.shape[0] / max_size, values.shape[1] / max_size))))
    if stride <= 1:
        return values, lat, lon
    sampled = values[::stride, ::stride]
    sampled_lat = _sample_coord_for_stride(lat, stride, axis=0, target_shape=values.shape)
    sampled_lon = _sample_coord_for_stride(lon, stride, axis=1, target_shape=values.shape)
    return sampled, sampled_lat, sampled_lon


def _sample_coord_for_stride(coord: Any | None, stride: int, *, axis: int, target_shape: tuple[int, int]) -> Any | None:
    if coord is None:
        return None
    np = _np()
    values = np.asarray(coord)
    if values.ndim == 1:
        return values[::stride]
    if values.ndim == 2 and values.shape == target_shape:
        return values[::stride, ::stride]
    return coord


def _orient_grid_for_map(data: Any, lat: Any | None, lon: Any | None, bounds: list[float]) -> tuple[Any, list[float]]:
    np = _np()
    result = np.asarray(data, dtype="float64")
    if lat is not None:
        lat_values = np.asarray(lat).ravel()
        if lat_values.size > 1 and float(lat_values[0]) < float(lat_values[-1]):
            result = np.flipud(result)
    if lon is not None:
        lon_values = np.asarray(lon).ravel()
        if lon_values.size > 1 and float(lon_values[0]) > float(lon_values[-1]):
            result = np.fliplr(result)
    return result, bounds


def _orient_grid_for_contours(data: Any, lat: Any, lon: Any) -> tuple[Any, Any, Any]:
    np = _np()
    result = np.asarray(data, dtype="float64")
    lat_values = np.asarray(lat, dtype="float64").ravel()
    lon_values = np.asarray(lon, dtype="float64").ravel()
    if lat_values.size > 1 and lat_values[0] > lat_values[-1]:
        lat_values = lat_values[::-1]
        result = np.flipud(result)
    if lon_values.size > 1 and lon_values[0] > lon_values[-1]:
        lon_values = lon_values[::-1]
        result = np.fliplr(result)
    return result, lat_values, lon_values


def _colorize_grid(data: Any) -> Any:
    np = _np()
    Image = _pil_image()
    values = np.asarray(data, dtype="float64")
    finite = np.isfinite(values)
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    if not finite.any():
        return Image.fromarray(rgba, mode="RGBA")
    vmin = float(np.nanmin(values))
    vmax = float(np.nanmax(values))
    if math.isclose(vmin, vmax):
        normalized = np.zeros(values.shape, dtype="float64")
    else:
        normalized = np.clip((values - vmin) / (vmax - vmin), 0, 1)
    palette = np.asarray(
        [
            [49, 54, 149],
            [69, 117, 180],
            [116, 173, 209],
            [171, 217, 233],
            [224, 243, 248],
            [254, 224, 144],
            [253, 174, 97],
            [244, 109, 67],
            [215, 48, 39],
            [165, 0, 38],
        ],
        dtype="float64",
    )
    # 空值像元保持透明，不参与调色板索引计算。
    #
    # 雷达极坐标转方形图时外圈天然是 NaN；先把这些位置压到 0，
    # 再通过 alpha 通道隐藏，避免 NumPy 将 NaN cast 成越界整数。
    scaled = np.where(finite, normalized, 0.0) * (len(palette) - 1)
    low = np.floor(scaled).astype(int)
    high = np.clip(low + 1, 0, len(palette) - 1)
    fraction = (scaled - low)[..., None]
    rgb = palette[low] * (1 - fraction) + palette[high] * fraction
    rgba[..., :3] = rgb.astype(np.uint8)
    rgba[..., 3] = np.where(finite, 210, 0).astype(np.uint8)
    return Image.fromarray(rgba, mode="RGBA")


def _finite_values(data: Any) -> Any:
    np = _np()
    values = np.asarray(data, dtype="float64")
    return values[np.isfinite(values)]


def _mask_grid_to_area(data: Any, lat: Any | None, lon: Any | None, area: dict[str, Any] | None) -> Any:
    if area is None:
        return data
    np = _np()
    values = np.asarray(data, dtype="float64")
    if values.size == 0:
        return values
    if lat is None or lon is None:
        raise ValueError("按分析区域裁剪气象网格需要经纬度坐标。")
    lat_array = np.asarray(lat, dtype="float64")
    lon_array = np.asarray(lon, dtype="float64")
    if lat_array.ndim == 1 and lon_array.ndim == 1:
        if values.shape[-2:] != (lat_array.size, lon_array.size):
            raise ValueError("分析区域裁剪要求网格形状与一维经纬度坐标匹配。")
        lon_grid, lat_grid = np.meshgrid(lon_array, lat_array)
    elif lat_array.ndim == 2 and lon_array.ndim == 2 and lat_array.shape == values.shape and lon_array.shape == values.shape:
        lat_grid, lon_grid = lat_array, lon_array
    else:
        raise ValueError("当前仅支持带一维或二维经纬度坐标的气象网格按分析区域裁剪。")
    area_geom = _area_union(area)
    mask = intersects_xy(area_geom, lon_grid, lat_grid)
    return np.where(mask, values, np.nan)


def _area_union(area: dict[str, Any]) -> Any:
    shapes = []
    for feature in area.get("features", []):
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        if not isinstance(geometry, dict):
            continue
        geom = shape(geometry)
        if not geom.is_valid:
            geom = geom.buffer(0)
        if not geom.is_empty:
            shapes.append(geom)
    if not shapes:
        raise ValueError("分析区域没有可用面几何。")
    return unary_union(shapes)


def _geometry_to_features(geometry: Any, *, properties: dict[str, Any]) -> list[dict[str, Any]]:
    if geometry.is_empty:
        return []
    if geometry.geom_type in {"LineString", "MultiLineString", "Polygon", "MultiPolygon", "Point", "MultiPoint"}:
        return [{"type": "Feature", "properties": dict(properties), "geometry": mapping(geometry)}]
    features: list[dict[str, Any]] = []
    for item in getattr(geometry, "geoms", []):
        features.extend(_geometry_to_features(item, properties=properties))
    return features


def _finite_range(data: Any) -> list[float] | None:
    values = _finite_values(data)
    if values.size == 0:
        return None
    return [float(values.min()), float(values.max())]


def _crop_grid_by_bbox(data: Any, lat: Any | None, lon: Any | None, bbox: list[float] | None) -> Any:
    cropped, _lat, _lon = _crop_grid_with_coords_by_bbox(data, lat, lon, bbox)
    return cropped


def _crop_grid_with_coords_by_bbox(data: Any, lat: Any | None, lon: Any | None, bbox: list[float] | None) -> tuple[Any, Any | None, Any | None]:
    if not bbox or lat is None or lon is None:
        return data, lat, lon
    np = _np()
    lat_array = np.asarray(lat, dtype="float64")
    lon_array = np.asarray(lon, dtype="float64")
    if lat_array.ndim != 1 or lon_array.ndim != 1:
        return data, lat, lon
    lat_values = lat_array.ravel()
    lon_values = lon_array.ravel()
    west, south, east, north = bbox
    row_mask = (lat_values >= south) & (lat_values <= north)
    col_mask = (lon_values >= west) & (lon_values <= east)
    if not row_mask.any() or not col_mask.any():
        return np.asarray([], dtype="float64").reshape(0, 0), lat_values[:0], lon_values[:0]
    return np.asarray(data)[row_mask, :][:, col_mask], lat_values[row_mask], lon_values[col_mask]


def _require_1d_lat_lon(grid: MeteorologicalGrid) -> tuple[Any, Any]:
    return _require_1d_lat_lon_values(grid.data, grid.lat, grid.lon)


def _require_1d_lat_lon_values(data: Any, lat: Any | None, lon: Any | None) -> tuple[Any, Any]:
    np = _np()
    if lat is None or lon is None:
        raise ValueError("该变量没有经纬度坐标，无法生成 GeoJSON。")
    lat_array = np.asarray(lat, dtype="float64")
    lon_array = np.asarray(lon, dtype="float64")
    if lat_array.ndim != 1 or lon_array.ndim != 1:
        raise ValueError("当前仅支持一维经纬度坐标网格生成 GeoJSON。")
    lat = lat_array.ravel()
    lon = lon_array.ravel()
    if np.asarray(data).shape[-2:] != (lat.size, lon.size):
        raise ValueError("当前仅支持一维经纬度坐标网格生成 GeoJSON。")
    return lat, lon


def _coord_edges(values: Any) -> Any:
    np = _np()
    coords = np.asarray(values, dtype="float64")
    if coords.size == 1:
        return np.asarray([coords[0] - 0.5, coords[0] + 0.5])
    middle = (coords[:-1] + coords[1:]) / 2
    first = coords[0] - (middle[0] - coords[0])
    last = coords[-1] + (coords[-1] - middle[-1])
    return np.concatenate([[first], middle, [last]])


def _compare(data: Any, threshold: float, operator: str) -> Any:
    np = _np()
    values = np.asarray(data, dtype="float64")
    if operator in {">", "gt"}:
        return values > threshold
    if operator in {"<", "lt"}:
        return values < threshold
    if operator in {"<=", "lte"}:
        return values <= threshold
    if operator in {"==", "eq"}:
        return values == threshold
    return values >= threshold


def _is_numeric_dtype(dtype: Any) -> bool:
    return _np().issubdtype(dtype, _np().number)


def _attr_text(data_array: Any, key: str) -> str | None:
    return _decode_attr(getattr(data_array, "attrs", {}).get(key))


def _decode_attr(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return f"bytes:0x{value.hex()}"
    return str(value)


def _format_label(suffix: str) -> str:
    if suffix in {".grib", ".grb", ".grb2"}:
        return "GRIB"
    if suffix in {".h5", ".hdf5"}:
        return "HDF5"
    return "NetCDF"


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


def _rasterio_transform() -> Any:
    import rasterio.transform
    return rasterio.transform


def _rasterio_resampling() -> Any:
    from rasterio.enums import Resampling
    return Resampling


def _h5py() -> Any:
    import h5py
    return h5py


def _pil_image() -> Any:
    from PIL import Image
    return Image


def _contourpy() -> Any:
    import contourpy
    return contourpy
