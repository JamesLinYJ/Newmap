# +-------------------------------------------------------------------------
#
#   地理智能平台 - PostGIS 能力包导出
#
#   文件:       __init__.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 统一导出 PostGIS 图层目录、仓储与空间分析服务能力。

from .layer_catalog import LayerCatalog
from .place_search import NominatimPlaceSearchProvider, PlaceSearchConfig, build_place_search_provider
from .poi_search import OverpassPoiSearchProvider, PoiSearchConfig, build_poi_search_provider
from .postgis_catalog import PostGISLayerCatalog
from .repository import PostGISLayerRepository
from .service import SpatialAnalysisService

__all__ = [
    "LayerCatalog",
    "NominatimPlaceSearchProvider",
    "OverpassPoiSearchProvider",
    "PlaceSearchConfig",
    "PoiSearchConfig",
    "PostGISLayerCatalog",
    "PostGISLayerRepository",
    "SpatialAnalysisService",
    "build_place_search_provider",
    "build_poi_search_provider",
]
