from __future__ import annotations

from shared_types.schemas import BasemapDescriptor


class BasemapCatalog:
    def __init__(self, *, tianditu_api_key: str | None = None):
        self.tianditu_api_key = tianditu_api_key

    def ensure_schema(self) -> None:
        return None

    def list_basemaps(self) -> list[BasemapDescriptor]:
        basemaps = [
            BasemapDescriptor(
                basemap_key="osm",
                name="OpenStreetMap",
                provider="osm",
                kind="vector",
                attribution="&copy; OpenStreetMap Contributors",
                tile_urls=["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                label_tile_urls=[],
                available=True,
                is_default=True,
            ),
            BasemapDescriptor(
                basemap_key="tianditu_vec",
                name="天地图矢量",
                provider="tianditu",
                kind="vector",
                attribution="&copy; 天地图",
                tile_urls=self._render_templates(_tianditu_templates("vec_w")),
                label_tile_urls=self._render_templates(_tianditu_templates("cva_w")),
                available=bool(self.tianditu_api_key),
                is_default=False,
            ),
            BasemapDescriptor(
                basemap_key="tianditu_img",
                name="天地图影像",
                provider="tianditu",
                kind="imagery",
                attribution="&copy; 天地图",
                tile_urls=self._render_templates(_tianditu_templates("img_w")),
                label_tile_urls=self._render_templates(_tianditu_templates("cia_w")),
                available=bool(self.tianditu_api_key),
                is_default=False,
            ),
        ]
        return basemaps

    def _render_templates(self, templates: list[str]) -> list[str]:
        if not self.tianditu_api_key:
            return []
        return [template.replace("{tk}", self.tianditu_api_key) for template in templates]


def _tianditu_templates(layer_code: str) -> list[str]:
    return [
        (
            f"https://t{subdomain}.tianditu.gov.cn/{layer_code}/wmts"
            "?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
            f"&LAYER={layer_code.split('_', 1)[0]}&STYLE=default&TILEMATRIXSET=w"
            "&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}"
        )
        for subdomain in range(4)
    ]
