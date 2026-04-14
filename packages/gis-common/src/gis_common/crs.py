# +-------------------------------------------------------------------------
#
#   地理智能平台 - 坐标参考与投影工具
#
#   文件:       crs.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from functools import partial
from typing import Any

from pyproj import CRS, Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform


# CRS 与几何转换工具
#
# 提供局部米制投影选择、几何重投影以及 FeatureCollection 级别的坐标转换。
def shape_from_feature(feature: dict[str, Any]):
    return shape(feature["geometry"])


def feature_from_shape(geometry, properties: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": properties or {},
        "geometry": mapping(geometry),
    }


def choose_local_metric_epsg(longitude: float, latitude: float) -> int:
    zone = int((longitude + 180) / 6) + 1
    north = latitude >= 0
    return (32600 if north else 32700) + zone


def transform_geometry(geometry, src_epsg: int, dst_epsg: int):
    if src_epsg == dst_epsg:
        return geometry
    transformer = Transformer.from_crs(CRS.from_epsg(src_epsg), CRS.from_epsg(dst_epsg), always_xy=True)
    return transform(partial(transformer.transform), geometry)


def transform_feature_collection(payload: dict[str, Any], src_epsg: int, dst_epsg: int) -> dict[str, Any]:
    transformed_features = []
    for feature in payload.get("features", []):
        geom = shape_from_feature(feature)
        transformed_geom = transform_geometry(geom, src_epsg, dst_epsg)
        transformed_features.append(feature_from_shape(transformed_geom, dict(feature.get("properties", {}))))
    return {"type": "FeatureCollection", "features": transformed_features}
