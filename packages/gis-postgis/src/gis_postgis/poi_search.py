# +-------------------------------------------------------------------------
#
#   地理智能平台 - 外部 POI 检索 Provider
#
#   文件:       poi_search.py
#
#   日期:       2026年04月22日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
#
# 模块职责
#
# 统一封装外部 POI 检索能力。当前首版基于 Overpass / OSM，
# 让空 catalog 场景也能围绕地点、范围和类别完成真实查询。

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ._http import build_ssl_context


@dataclass(frozen=True)
class PoiSearchConfig:
    provider: str = "overpass"
    enabled: bool = True
    base_url: str = "https://overpass-api.de/api/interpreter"
    user_agent: str = "geo-agent-platform/0.1"
    timeout_ms: int = 8000
    max_results: int = 200


class PoiSearchProvider(Protocol):
    def search(
        self,
        *,
        category: str,
        bbox: tuple[float, float, float, float] | None = None,
        latitude: float | None = None,
        longitude: float | None = None,
        radius_m: float | None = None,
    ) -> dict[str, Any]: ...

    def health(self) -> dict[str, Any]: ...


# Overpass API 镜像列表
_OVERPASS_FALLBACK_BASE_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


class OverpassPoiSearchProvider:
    def __init__(self, config: PoiSearchConfig):
        self.config = config
        if config.timeout_ms <= 0:
            raise ValueError("external_poi.timeout_ms 必须大于 0。")
        timeout_s = config.timeout_ms / 1000
        self.timeout = httpx.Timeout(timeout=timeout_s, connect=timeout_s)
        self.headers = {"User-Agent": config.user_agent}
        self._ssl_context = build_ssl_context()

    def _make_client(self, base_url: str | None = None) -> httpx.Client:
        return httpx.Client(
            timeout=httpx.Timeout(
                timeout=self.timeout.read,
                connect=min(self.timeout.connect, 3),
            ),
            headers=self.headers,
            http2=False,
            verify=self._ssl_context,
            base_url=base_url or self.config.base_url,
        )

    def _request_with_retry(self, action, parse):
        urls = [self.config.base_url] + [u for u in _OVERPASS_FALLBACK_BASE_URLS if u != self.config.base_url]

        last_error: Exception | None = None
        for base_url in urls:
            for attempt in range(2):
                try:
                    with self._make_client(base_url) as client:
                        response = action(client)
                        response.raise_for_status()
                        return parse(response)
                except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.TimeoutException) as exc:
                    last_error = exc
                    if attempt < 1:
                        time.sleep(0.3)
                        continue
                break
        raise last_error  # type: ignore[misc]

    def search(
        self,
        *,
        category: str,
        bbox: tuple[float, float, float, float] | None = None,
        latitude: float | None = None,
        longitude: float | None = None,
        radius_m: float | None = None,
    ) -> dict[str, Any]:
        if not self.config.enabled:
            raise RuntimeError("外部 POI 检索当前已禁用。")
        selector = _category_selector(category)
        scope = _build_scope(bbox=bbox, latitude=latitude, longitude=longitude, radius_m=radius_m)
        query = f"""
        [out:json][timeout:{max(1, int(self.config.timeout_ms / 1000))}];
        (
          {selector(scope)}
        );
        out center tags {self.config.max_results};
        """
        return self._request_with_retry(
            lambda client: client.post("", content=query.encode("utf-8")),
            lambda response: self._parse_poi_results(response, category),
        )

    def _parse_poi_results(self, response: httpx.Response, category: str) -> dict[str, Any]:
        payload = response.json()
        elements = payload.get("elements", [])
        features = [_element_to_feature(item, category) for item in elements]
        features = [item for item in features if item is not None]
        return {
            "provider": self.config.provider,
            "category": category,
            "count": len(features),
            "collection": {
                "type": "FeatureCollection",
                "features": features,
            },
        }

    def health(self) -> dict[str, Any]:
        if not self.config.enabled:
            return {"available": False, "provider": self.config.provider, "error": "disabled"}
        try:
            with self._make_client() as client:
                client.head("/api/interpreter", timeout=3)
        except Exception as exc:
            return {"available": False, "provider": self.config.provider, "error": f"{exc.__class__.__name__}: {exc}"}
        return {"available": True, "provider": self.config.provider}


def build_poi_search_provider(config: PoiSearchConfig) -> PoiSearchProvider:
    if config.provider == "overpass":
        return OverpassPoiSearchProvider(config)
    raise ValueError(f"不支持的外部 POI provider: {config.provider}")


def _build_scope(
    *,
    bbox: tuple[float, float, float, float] | None,
    latitude: float | None,
    longitude: float | None,
    radius_m: float | None,
) -> str:
    if bbox is not None:
        west, south, east, north = bbox
        return f"({south},{west},{north},{east})"
    if latitude is None or longitude is None or radius_m is None:
        raise ValueError("外部 POI 检索需要边界 bbox 或经纬度 + 半径。")
    return f"(around:{int(radius_m)},{latitude},{longitude})"


def _category_selector(category: str):
    normalized = category.strip().casefold()
    selectors = {
        "hospital": lambda scope: f'nwr["amenity"~"hospital|clinic"]{scope};',
        "healthcare": lambda scope: f'nwr["amenity"~"hospital|clinic|doctors|pharmacy"]{scope};',
        "metro_station": lambda scope: "\n".join(
            [
                f'nwr["railway"="station"]["station"="subway"]{scope};',
                f'nwr["public_transport"="station"]["subway"="yes"]{scope};',
            ]
        ),
        "transport": lambda scope: "\n".join(
            [
                f'nwr["railway"="station"]["station"="subway"]{scope};',
                f'nwr["public_transport"="station"]["subway"="yes"]{scope};',
                f'nwr["aeroway"~"aerodrome|terminal"]{scope};',
            ]
        ),
        "airport": lambda scope: f'nwr["aeroway"~"aerodrome|terminal"]{scope};',
        "school": lambda scope: f'nwr["amenity"~"school|college|university|kindergarten"]{scope};',
        "park": lambda scope: f'nwr["leisure"="park"]{scope};',
        "restaurant": lambda scope: f'nwr["amenity"="restaurant"]{scope};',
        "pharmacy": lambda scope: f'nwr["amenity"="pharmacy"]{scope};',
    }
    return selectors.get(normalized, lambda scope: f'nwr["name"~"{_escape_regex(normalized)}", i]{scope};')


def _escape_regex(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace(".", "\\.")
        .replace("*", "\\*")
        .replace("+", "\\+")
        .replace("?", "\\?")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def _element_to_feature(element: dict[str, Any], category: str) -> dict[str, Any] | None:
    lon = element.get("lon")
    lat = element.get("lat")
    center = element.get("center") or {}
    if lon is None or lat is None:
        lon = center.get("lon")
        lat = center.get("lat")
    if lon is None or lat is None:
        return None
    tags = element.get("tags") or {}
    return {
        "type": "Feature",
        "properties": {
            "osm_id": element.get("id"),
            "osm_type": element.get("type"),
            "name": tags.get("name") or tags.get("name:zh") or tags.get("official_name") or category,
            "category": category,
            "tags": tags,
        },
        "geometry": {
            "type": "Point",
            "coordinates": [float(lon), float(lat)],
        },
    }
