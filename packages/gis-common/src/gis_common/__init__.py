# +-------------------------------------------------------------------------
#
#   地理智能平台 - GIS 通用能力包导出
#
#   文件:       __init__.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from .crs import choose_local_metric_epsg, feature_from_shape, shape_from_feature, transform_feature_collection
from .geojson import ensure_feature_collection, load_geojson, save_geojson
from .ids import make_id, now_utc

__all__ = [
    "choose_local_metric_epsg",
    "ensure_feature_collection",
    "feature_from_shape",
    "load_geojson",
    "make_id",
    "now_utc",
    "save_geojson",
    "shape_from_feature",
    "transform_feature_collection",
]
