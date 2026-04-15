# +-------------------------------------------------------------------------
#
#   地理智能平台 - 空间分析服务实现
#
#   文件:       service.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import os
import logging
from typing import Any

import httpx
from shapely.ops import unary_union

from gis_common.crs import (
    choose_local_metric_epsg,
    feature_from_shape,
    shape_from_feature,
    transform_feature_collection,
    transform_geometry,
)
from gis_common.geojson import ensure_feature_collection

logger = logging.getLogger(__name__)


# SpatialAnalysisService
#
# 空间分析服务门面。
# 所有分析能力都直接依赖 PostGIS repository。
class SpatialAnalysisService:
    def __init__(self, layer_repository: Any, *, nominatim_base_url: str = "https://nominatim.openstreetmap.org"):
        self.layer_repository = layer_repository
        self.nominatim_base_url = nominatim_base_url.rstrip("/")
        self._headers = {"User-Agent": "geo-agent-platform/0.1 (codex local demo)"}
        self._allow_remote_lookup = os.getenv("GEO_AGENT_ENABLE_REMOTE_LOOKUP", "").lower() in {"1", "true", "yes"}
        if "PYTEST_CURRENT_TEST" in os.environ:
            self._allow_remote_lookup = False

    def geocode_place(self, query: str) -> dict[str, Any]:
        local_matches = self.layer_repository.geocode(query)
        remote_matches = [_format_nominatim_match(item) for item in self._search_nominatim(query)]
        deduped = _dedupe_geocode_matches(local_matches + remote_matches)
        return {"type": "FeatureCollection", "features": [], "matches": deduped}

    def reverse_geocode(self, latitude: float, longitude: float) -> dict[str, Any]:
        with httpx.Client(timeout=15, headers=self._headers) as client:
            response = client.get(
                f"{self.nominatim_base_url}/reverse",
                params={
                    "lat": latitude,
                    "lon": longitude,
                    "format": "jsonv2",
                    "zoom": 16,
                },
            )
            response.raise_for_status()
            payload = response.json()
        return {
            "label": payload.get("display_name"),
            "latitude": latitude,
            "longitude": longitude,
            "address": payload.get("address", {}),
        }

    def load_boundary(self, name: str) -> dict[str, Any]:
        matches = self.layer_repository.search_boundaries(name)
        if matches:
            return {"type": "FeatureCollection", "features": matches}
        remote_matches = self._search_nominatim(name, polygon_geojson=True)
        features = []
        for match in remote_matches:
            feature = _nominatim_match_to_feature(match)
            if feature is not None:
                features.append(feature)
        return {"type": "FeatureCollection", "features": features}

    def load_layer(self, layer_key: str, area_name: str | None = None, boundary: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.layer_repository.load_layer_collection(layer_key, area_name=area_name, boundary=boundary)

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
        if not collection["features"]:
            return None
        union = unary_union([shape_from_feature(feature) for feature in collection["features"]])
        return [round(value, 6) for value in union.bounds]

    def normalize_to_4326(self, collection: dict[str, Any], source_epsg: int) -> dict[str, Any]:
        return transform_feature_collection(collection, source_epsg, 4326)

    def metric_warning(self, area_name: str | None) -> str | None:
        if area_name and area_name in {"上海市", "巴黎", "柏林"}:
            return None
        return "当前分析采用局部投影近似米制计算，跨大范围场景建议复核 CRS。"

    def _search_nominatim(self, query: str, polygon_geojson: bool = False) -> list[dict[str, Any]]:
        # 远程 Nominatim 查询。
        if not self._allow_remote_lookup:
            return []
        try:
            with httpx.Client(timeout=2.5, headers=self._headers) as client:
                response = client.get(
                    f"{self.nominatim_base_url}/search",
                    params={
                        "q": query,
                        "format": "jsonv2",
                        "limit": 5,
                        "polygon_geojson": 1 if polygon_geojson else 0,
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            logger.warning("Remote geocode lookup failed for '%s': %s: %s", query, exc.__class__.__name__, exc)
            return []
        return payload if isinstance(payload, list) else []


def _dedupe_geocode_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
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


def _format_nominatim_match(match: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": match.get("name") or match.get("display_name"),
        "display_name": match.get("display_name"),
        "country": (match.get("address") or {}).get("country"),
        "latitude": float(match["lat"]) if match.get("lat") else None,
        "longitude": float(match["lon"]) if match.get("lon") else None,
        "boundingbox": match.get("boundingbox"),
        "source": "nominatim",
    }


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
