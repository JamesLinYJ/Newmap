# +-------------------------------------------------------------------------
#
#   地理智能平台 - 地理位置检索 Provider
#
#   文件:       place_search.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 把地名 / POI 检索收敛成统一 provider 接口，避免空间分析服务里混杂多套
# "本地查一点、远程补一点、异常再吞掉"的临时逻辑。

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ._http import build_ssl_context


@dataclass(frozen=True)
class PlaceSearchConfig:
    provider: str = "nominatim"
    enabled: bool = True
    base_url: str = "https://nominatim.openstreetmap.org"
    user_agent: str = "geo-agent-platform/0.1"
    timeout_ms: int = 8000
    max_candidates: int = 5


class PlaceSearchProvider(Protocol):
    def search(self, query: str) -> list[dict[str, Any]]: ...

    def search_polygon(self, query: str) -> list[dict[str, Any]]: ...

    def reverse(self, latitude: float, longitude: float) -> dict[str, Any]: ...

    def health(self) -> dict[str, Any]: ...


# Nominatim 镜像列表
#
# 当默认 nominatim.openstreetmap.org 不可达时自动尝试这些镜像。
# 按优先级排列，会依次尝试直到成功或全部失败。
_NOMINATIM_FALLBACK_BASE_URLS = [
    "https://nominatim.openstreetmap.org",
    "https://nominatim.articque.com",
    "https://nominatim.geocoding.ai",
]


class NominatimPlaceSearchProvider:
    def __init__(self, config: PlaceSearchConfig):
        self.config = config
        self.base_url = config.base_url.rstrip("/")
        self.headers = {"User-Agent": config.user_agent}
        if config.timeout_ms <= 0:
            raise ValueError("geosearch.timeout_ms 必须大于 0。")
        timeout_s = config.timeout_ms / 1000
        self.timeout = httpx.Timeout(timeout=timeout_s, connect=timeout_s)
        self._ssl_context = build_ssl_context()

    def _make_client(self, base_url: str | None = None) -> httpx.Client:
        # connect 超时限制在 3s 以便快速探测不可达端点并切换镜像。
        return httpx.Client(
            timeout=httpx.Timeout(
                timeout=self.timeout.read,
                connect=min(self.timeout.connect, 3),
            ),
            headers=self.headers,
            http2=False,
            verify=self._ssl_context,
            base_url=base_url or self.base_url,
        )

    def _request_with_retry(self, path, params, parse):
        # 按优先级尝试多个 Nominatim 端点，使用相对路径让 client base_url 生效。
        urls = [self.base_url] + [u for u in _NOMINATIM_FALLBACK_BASE_URLS if u != self.base_url]

        last_error: Exception | None = None
        for base_url in urls:
            for attempt in range(2):
                try:
                    with self._make_client(base_url) as client:
                        response = client.get(path, params=params)
                        response.raise_for_status()
                        return parse(response)
                except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.TimeoutException, json.JSONDecodeError) as exc:
                    last_error = exc
                    if attempt < 1:
                        time.sleep(0.3)
                        continue
                break
        raise last_error  # type: ignore[misc]

    def search(self, query: str) -> list[dict[str, Any]]:
        if not self.config.enabled:
            raise RuntimeError("地理检索能力当前已禁用。")
        return self._request_with_retry(
            "/search",
            params={
                "q": query,
                "format": "jsonv2",
                "limit": self.config.max_candidates,
                "addressdetails": 1,
            },
            parse=self._parse_search_results,
        )

    def search_polygon(self, query: str) -> list[dict[str, Any]]:
        if not self.config.enabled:
            raise RuntimeError("地理检索能力当前已禁用。")
        return self._request_with_retry(
            "/search",
            params={
                "q": query,
                "format": "jsonv2",
                "limit": self.config.max_candidates,
                "polygon_geojson": 1,
                "addressdetails": 1,
            },
            parse=lambda r: r.json() if isinstance(r.json(), list) else [],
        )

    def reverse(self, latitude: float, longitude: float) -> dict[str, Any]:
        if not self.config.enabled:
            raise RuntimeError("地理检索能力当前已禁用。")
        payload = self._request_with_retry(
            "/reverse",
            params={
                "lat": latitude,
                "lon": longitude,
                "format": "jsonv2",
                "zoom": 16,
                "addressdetails": 1,
            },
            parse=lambda r: r.json(),
        )
        return {
            "label": payload.get("display_name"),
            "latitude": latitude,
            "longitude": longitude,
            "address": payload.get("address", {}),
            "source": self.config.provider,
        }

    def health(self) -> dict[str, Any]:
        if not self.config.enabled:
            return {"available": False, "provider": self.config.provider, "error": "disabled"}
        try:
            with self._make_client() as client:
                client.head("/", timeout=3)
        except Exception as exc:
            return {"available": False, "provider": self.config.provider, "error": f"{exc.__class__.__name__}: {exc}"}
        return {"available": True, "provider": self.config.provider}

    def _parse_search_results(self, response: httpx.Response) -> list[dict[str, Any]]:
        payload = response.json()
        if not isinstance(payload, list):
            return []
        return [self._format_match(item) for item in payload]

    def _format_match(self, match: dict[str, Any]) -> dict[str, Any]:
        address = match.get("address") or {}
        return {
            "label": match.get("name") or match.get("display_name"),
            "display_name": match.get("display_name"),
            "country": address.get("country"),
            "latitude": float(match["lat"]) if match.get("lat") else None,
            "longitude": float(match["lon"]) if match.get("lon") else None,
            "boundingbox": match.get("boundingbox"),
            "source": self.config.provider,
        }


def build_place_search_provider(config: PlaceSearchConfig) -> PlaceSearchProvider:
    if config.provider == "nominatim":
        return NominatimPlaceSearchProvider(config)
    raise ValueError(f"不支持的地理检索 provider: {config.provider}")
