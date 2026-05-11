# +-------------------------------------------------------------------------
#
#   地理智能平台 - 空间分析服务实现
#
#   文件:       service.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 在图层目录之上封装面向分析任务的高层空间分析服务，并把地点检索
# 收敛到独立 provider，而不是继续保留零散 fallback 逻辑。

from __future__ import annotations

from typing import Any

from shapely.ops import unary_union

from gis_common.crs import (
    choose_local_metric_epsg,
    feature_from_shape,
    shape_from_feature,
    transform_feature_collection,
)
from gis_common.geojson import ensure_feature_collection
from shared_types.schemas import RuntimeGeosearchConfig, RuntimePoiConfig

from .place_search import PlaceSearchConfig, PlaceSearchProvider, build_place_search_provider
from .poi_search import PoiSearchConfig, PoiSearchProvider, build_poi_search_provider


# SpatialAnalysisService
#
# 空间分析服务门面。
# 所有分析能力都直接依赖 PostGIS repository，地点检索则统一走 provider。
class SpatialAnalysisService:
    def __init__(
        self,
        layer_repository: Any,
        *,
        place_search_provider: PlaceSearchProvider | None = None,
        poi_search_provider: PoiSearchProvider | None = None,
        geosearch_config: RuntimeGeosearchConfig | None = None,
        poi_config: RuntimePoiConfig | None = None,
        nominatim_base_url: str = "https://nominatim.openstreetmap.org",
    ):
        self.layer_repository = layer_repository
        self._geosearch_config = geosearch_config or RuntimeGeosearchConfig(base_url=nominatim_base_url)
        self._poi_config = poi_config or RuntimePoiConfig()
        self._place_search_provider = place_search_provider or build_place_search_provider(_to_place_search_config(self._geosearch_config))
        self._poi_search_provider = poi_search_provider or build_poi_search_provider(_to_poi_search_config(self._poi_config))

    def geocode_place(self, query: str) -> dict[str, Any]:
        # 先查本地 PostGIS 边界库，再补远程 Nominatim，避免每次查询都走外网。
        local_matches = self.layer_repository.geocode(query)
        remote_matches = self._place_search_provider.search(query)
        deduped = _dedupe_geocode_matches(local_matches + remote_matches)
        return {
            "type": "FeatureCollection",
            "features": [],
            "matches": deduped,
            "provider": self._geosearch_config.provider,
            "query": query,
        }

    def reverse_geocode(self, latitude: float, longitude: float) -> dict[str, Any]:
        return self._place_search_provider.reverse(latitude, longitude)

    def configure_geosearch(self, config: RuntimeGeosearchConfig) -> None:
        # runtime config 更新后允许原地热更新 provider，避免服务重启。
        self._geosearch_config = config
        self._place_search_provider = build_place_search_provider(_to_place_search_config(config))

    def configure_external_poi(self, config: RuntimePoiConfig) -> None:
        self._poi_config = config
        self._poi_search_provider = build_poi_search_provider(_to_poi_search_config(config))

    def geosearch_health(self) -> dict[str, Any]:
        return self._place_search_provider.health()

    def external_poi_health(self) -> dict[str, Any]:
        return self._poi_search_provider.health()

    def load_boundary(self, name: str) -> dict[str, Any]:
        # 行政区优先用本地边界库；只有本地没有时才尝试远程 polygon 候选。
        matches = self.layer_repository.search_boundaries(name)
        if matches:
            return {"type": "FeatureCollection", "features": matches}
        remote_matches = self._search_boundary_candidates(name)
        features = []
        for match in remote_matches:
            feature = _nominatim_match_to_feature(match)
            if feature is not None:
                features.append(feature)
        return {"type": "FeatureCollection", "features": features}

    def load_layer(self, layer_key: str, area_name: str | None = None, boundary: dict[str, Any] | None = None) -> dict[str, Any]:
        # 图层读取先利用仓储做属性级筛选，再在应用层做几何裁剪。
        #
        # 这样数据库仍负责存储和基础查询，但关键空间判断统一由 Shapely 处理，
        # 避免不同 PostGIS 镜像对复杂谓词和 GeoJSON 参数组合表现不稳定。
        collection = self.layer_repository.load_layer_collection(layer_key, area_name=area_name, boundary=None)
        if not boundary or not boundary.get("features"):
            return collection
        boundary_geometry = unary_union([shape_from_feature(feature) for feature in boundary["features"]])
        features = [
            feature
            for feature in collection.get("features", [])
            if shape_from_feature(feature).intersects(boundary_geometry)
        ]
        return {"type": "FeatureCollection", "features": features}

    def search_external_pois(
        self,
        *,
        category: str,
        boundary: dict[str, Any] | None = None,
        anchor: dict[str, Any] | None = None,
        distance_m: float | None = None,
    ) -> dict[str, Any]:
        # 外部 POI 检索是空 catalog 场景的一等能力。
        #
        # 如果提供了 boundary，就按范围查；否则围绕锚点和距离查询。
        bbox = self.geometry_bounds(boundary) if boundary and boundary.get("features") else None
        if bbox is not None and len(bbox) == 4:
            west, south, east, north = bbox
            return self._poi_search_provider.search(category=category, bbox=(west, south, east, north))
        if not anchor or not anchor.get("features"):
            raise ValueError("外部 POI 检索需要边界或地点锚点。")
        bounds = self.geometry_bounds(anchor)
        if not bounds:
            raise ValueError("地点锚点没有可用几何。")
        west, south, east, north = bounds
        latitude = (south + north) / 2
        longitude = (west + east) / 2
        return self._poi_search_provider.search(
            category=category,
            latitude=latitude,
            longitude=longitude,
            radius_m=float(distance_m or 1000),
        )

    def buffer(self, collection: dict[str, Any], distance_m: float) -> dict[str, Any]:
        return self.layer_repository.buffer_collection(collection, distance_m)

    def intersect(self, left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
        return self.layer_repository.intersect_collections(left, right)

    def clip(self, left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
        return self.layer_repository.intersect_collections(left, right, clip=True)

    def point_in_polygon(self, points: dict[str, Any], polygons: dict[str, Any]) -> dict[str, Any]:
        return self.layer_repository.point_in_polygon_collection(points, polygons)

    def spatial_join(self, points: dict[str, Any], polygons: dict[str, Any]) -> dict[str, Any]:
        return self.layer_repository.spatial_join_collection(points, polygons)

    def distance_query(self, source: dict[str, Any], target: dict[str, Any], distance_m: float) -> dict[str, Any]:
        return self.layer_repository.distance_query_collection(source, target, distance_m)

    def geometry_bounds(self, collection: dict[str, Any]) -> list[float] | None:
        # bounds 用于地图定位与结果面板概览，不改变原始几何。
        if not collection["features"]:
            return None
        union = unary_union([shape_from_feature(feature) for feature in collection["features"]])
        return [round(value, 6) for value in union.bounds]

    def normalize_to_4326(self, collection: dict[str, Any], source_epsg: int) -> dict[str, Any]:
        return transform_feature_collection(collection, source_epsg, 4326)

    def metric_warning(self, area_name: str | None) -> str | None:
        # CRS 风险不能靠城市白名单判断。
        #
        # 当前实际缓冲/距离计算会按几何质心选择局部米制投影；
        # 只有缺少明确区域上下文时，才给出泛化复核提示。
        if area_name:
            return None
        return "当前分析会按结果几何自动选择局部米制投影；如果对象跨越很大范围，建议复核 CRS。"

    def _search_boundary_candidates(self, query: str) -> list[dict[str, Any]]:
        return self._place_search_provider.search_polygon(query)


def _to_place_search_config(config: RuntimeGeosearchConfig) -> PlaceSearchConfig:
    return PlaceSearchConfig(
        provider=config.provider,
        enabled=config.enabled,
        base_url=config.base_url,
        user_agent=config.user_agent,
        timeout_ms=config.timeout_ms,
        max_candidates=config.max_candidates,
    )


def _to_poi_search_config(config: RuntimePoiConfig) -> PoiSearchConfig:
    return PoiSearchConfig(
        provider=config.provider,
        enabled=config.enabled,
        base_url=config.base_url,
        user_agent=config.user_agent,
        timeout_ms=config.timeout_ms,
        max_results=config.max_results,
    )


def _dedupe_geocode_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 地理编码结果按"名称 + 坐标"粗粒度去重，避免同一地点被重复展示。
    deduped: list[dict[str, Any]] = []
    seen = set()
    for match in matches:
        key = (
            match.get("label") or match.get("display_name"),
            match.get("latitude") or match.get("lat"),
            match.get("longitude") or match.get("lon"),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(match)
    return deduped


def _nominatim_match_to_feature(match: dict[str, Any]) -> dict[str, Any] | None:
    geometry = match.get("geojson")
    if geometry is None:
        bbox = match.get("boundingbox")
        if bbox and len(bbox) == 4:
            south, north, west, east = [float(value) for value in bbox]
            geometry = {
                "type": "Polygon",
                "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
            }
    if geometry is None:
        return None
    feature = {
        "type": "Feature",
        "properties": {
            "name": match.get("name") or match.get("display_name"),
            "name_en": match.get("display_name"),
            "country": (match.get("address") or {}).get("country"),
            "kind": match.get("type"),
            "source": "nominatim",
            "osm_id": match.get("osm_id"),
        },
        "geometry": geometry,
    }
    return ensure_feature_collection(feature)["features"][0]


