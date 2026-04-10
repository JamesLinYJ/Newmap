from __future__ import annotations

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

from .layer_catalog import LayerCatalog


class SpatialAnalysisService:
    def __init__(self, catalog: LayerCatalog, *, nominatim_base_url: str = "https://nominatim.openstreetmap.org"):
        self.catalog = catalog
        self.nominatim_base_url = nominatim_base_url.rstrip("/")
        self._headers = {"User-Agent": "geo-agent-platform/0.1 (codex local demo)"}

    def geocode_place(self, query: str) -> dict[str, Any]:
        local_matches = self.catalog.geocode(query)
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
        matches = self.catalog.search_boundaries(name)
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
        if hasattr(self.catalog, "load_layer_collection"):
            try:
                return self.catalog.load_layer_collection(layer_key, area_name=area_name, boundary=boundary)
            except Exception:
                pass
        collection = self.catalog.get_layer_collection(layer_key)
        if area_name:
            filtered = [
                feature
                for feature in collection["features"]
                if feature.get("properties", {}).get("city") == area_name
            ]
            collection = {"type": "FeatureCollection", "features": filtered}
        if boundary and boundary.get("features"):
            polygons = [shape_from_feature(feature) for feature in boundary["features"]]
            union_polygon = unary_union(polygons)
            filtered = []
            for feature in collection["features"]:
                if shape_from_feature(feature).intersects(union_polygon):
                    filtered.append(feature)
            collection = {"type": "FeatureCollection", "features": filtered}
        return collection

    def buffer(self, collection: dict[str, Any], distance_m: float) -> dict[str, Any]:
        if hasattr(self.catalog, "buffer_collection"):
            try:
                return self.catalog.buffer_collection(collection, distance_m)
            except Exception:
                pass
        if not collection["features"]:
            return {"type": "FeatureCollection", "features": []}
        centroid = unary_union([shape_from_feature(feature) for feature in collection["features"]]).centroid
        metric_epsg = choose_local_metric_epsg(centroid.x, centroid.y)
        projected = transform_feature_collection(collection, 4326, metric_epsg)
        buffered_features = []
        for feature in projected["features"]:
            buffered_features.append(feature_from_shape(shape_from_feature(feature).buffer(distance_m), feature["properties"]))
        return transform_feature_collection({"type": "FeatureCollection", "features": buffered_features}, metric_epsg, 4326)

    def intersect(self, left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
        if hasattr(self.catalog, "intersect_collections"):
            try:
                return self.catalog.intersect_collections(left, right)
            except Exception:
                pass
        if not left["features"] or not right["features"]:
            return {"type": "FeatureCollection", "features": []}
        right_union = unary_union([shape_from_feature(feature) for feature in right["features"]])
        features = []
        for feature in left["features"]:
            geom = shape_from_feature(feature)
            if not geom.intersects(right_union):
                continue
            intersection = geom.intersection(right_union)
            if intersection.is_empty:
                continue
            if geom.geom_type == "Point":
                features.append(feature)
            else:
                features.append(feature_from_shape(intersection, feature["properties"]))
        return {"type": "FeatureCollection", "features": features}

    def clip(self, left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
        if hasattr(self.catalog, "intersect_collections"):
            try:
                return self.catalog.intersect_collections(left, right, clip=True)
            except Exception:
                pass
        return self.intersect(left, right)

    def point_in_polygon(self, points: dict[str, Any], polygons: dict[str, Any]) -> dict[str, Any]:
        if hasattr(self.catalog, "point_in_polygon_collection"):
            try:
                return self.catalog.point_in_polygon_collection(points, polygons)
            except Exception:
                pass
        if not points["features"] or not polygons["features"]:
            return {"type": "FeatureCollection", "features": []}
        polygon_union = unary_union([shape_from_feature(feature) for feature in polygons["features"]])
        features = []
        for feature in points["features"]:
            inside = shape_from_feature(feature).within(polygon_union)
            if inside:
                enriched = dict(feature)
                enriched["properties"] = {**feature.get("properties", {}), "inside": True}
                features.append(enriched)
        return {"type": "FeatureCollection", "features": features}

    def spatial_join(self, points: dict[str, Any], polygons: dict[str, Any]) -> dict[str, Any]:
        if hasattr(self.catalog, "spatial_join_collection"):
            try:
                return self.catalog.spatial_join_collection(points, polygons)
            except Exception:
                pass
        joined_features = []
        for point_feature in points["features"]:
            point_shape = shape_from_feature(point_feature)
            for polygon_feature in polygons["features"]:
                polygon_shape = shape_from_feature(polygon_feature)
                if point_shape.within(polygon_shape):
                    joined_features.append(
                        {
                            "type": "Feature",
                            "properties": {
                                **point_feature.get("properties", {}),
                                "join_name": polygon_feature.get("properties", {}).get("name"),
                            },
                            "geometry": point_feature["geometry"],
                        }
                    )
                    break
        return {"type": "FeatureCollection", "features": joined_features}

    def distance_query(self, source: dict[str, Any], target: dict[str, Any], distance_m: float) -> dict[str, Any]:
        if hasattr(self.catalog, "distance_query_collection"):
            try:
                return self.catalog.distance_query_collection(source, target, distance_m)
            except Exception:
                pass
        if not source["features"] or not target["features"]:
            return {"type": "FeatureCollection", "features": []}
        centroid = unary_union([shape_from_feature(feature) for feature in source["features"]]).centroid
        metric_epsg = choose_local_metric_epsg(centroid.x, centroid.y)
        source_projected = transform_feature_collection(source, 4326, metric_epsg)
        target_projected = transform_feature_collection(target, 4326, metric_epsg)
        source_union = unary_union([shape_from_feature(feature) for feature in source_projected["features"]]).buffer(distance_m)
        features = []
        for index, feature in enumerate(target_projected["features"]):
            geom = shape_from_feature(feature)
            if geom.intersects(source_union):
                original_geom = shape_from_feature(target["features"][index])
                features.append(feature_from_shape(original_geom, target["features"][index]["properties"]))
        return {"type": "FeatureCollection", "features": features}

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
        try:
            with httpx.Client(timeout=15, headers=self._headers) as client:
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
        except Exception:
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
