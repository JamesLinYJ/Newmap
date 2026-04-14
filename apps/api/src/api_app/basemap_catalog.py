# +-------------------------------------------------------------------------
#
#   地理智能平台 - 底图库目录
#
#   文件:       basemap_catalog.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from shared_types.schemas import BasemapDescriptor


# BasemapCatalog
#
# 底图库目录存储。使用 SQLite 维护底图模板，并根据配置渲染最终瓦片 URL。
class BasemapCatalog:
    def __init__(self, data_dir: Path, *, tianditu_api_key: str | None = None):
        self.data_dir = data_dir
        self.system_dir = data_dir / "system"
        self.system_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.system_dir / "basemaps.sqlite3"
        self.tianditu_api_key = tianditu_api_key

    def ensure_schema(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS basemaps (
                    basemap_key TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    attribution TEXT NOT NULL,
                    tile_templates_json TEXT NOT NULL,
                    label_tile_templates_json TEXT NOT NULL,
                    requires_api_key INTEGER NOT NULL DEFAULT 0,
                    is_default INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.commit()
        self._seed_defaults()

    def list_basemaps(self) -> list[BasemapDescriptor]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT
                    basemap_key,
                    name,
                    provider,
                    kind,
                    attribution,
                    tile_templates_json,
                    label_tile_templates_json,
                    requires_api_key,
                    is_default
                FROM basemaps
                ORDER BY sort_order, basemap_key
                """
            ).fetchall()

        descriptors: list[BasemapDescriptor] = []
        for row in rows:
            (
                basemap_key,
                name,
                provider,
                kind,
                attribution,
                tile_templates_json,
                label_tile_templates_json,
                requires_api_key,
                is_default,
            ) = row
            available = not requires_api_key or bool(self.tianditu_api_key)
            descriptors.append(
                BasemapDescriptor(
                    basemap_key=basemap_key,
                    name=name,
                    provider=provider,
                    kind=kind,
                    attribution=attribution,
                    tile_urls=self._render_templates(json.loads(tile_templates_json), available=available),
                    label_tile_urls=self._render_templates(json.loads(label_tile_templates_json), available=available),
                    available=available,
                    is_default=bool(is_default),
                )
            )
        return descriptors

    def _render_templates(self, templates: list[str], *, available: bool) -> list[str]:
        if not available:
            return []
        api_key = self.tianditu_api_key or ""
        return [template.replace("{tk}", api_key) for template in templates]

    def _seed_defaults(self) -> None:
        basemaps = [
            {
                "basemap_key": "osm",
                "name": "OpenStreetMap",
                "provider": "osm",
                "kind": "vector",
                "attribution": "&copy; OpenStreetMap Contributors",
                "tile_templates_json": json.dumps(
                    ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                    ensure_ascii=False,
                ),
                "label_tile_templates_json": "[]",
                "requires_api_key": 0,
                "is_default": 1,
                "sort_order": 10,
            },
            {
                "basemap_key": "tianditu_vec",
                "name": "天地图矢量",
                "provider": "tianditu",
                "kind": "vector",
                "attribution": "&copy; 天地图",
                "tile_templates_json": json.dumps(_tianditu_templates("vec_w"), ensure_ascii=False),
                "label_tile_templates_json": json.dumps(_tianditu_templates("cva_w"), ensure_ascii=False),
                "requires_api_key": 1,
                "is_default": 0,
                "sort_order": 20,
            },
            {
                "basemap_key": "tianditu_img",
                "name": "天地图影像",
                "provider": "tianditu",
                "kind": "imagery",
                "attribution": "&copy; 天地图",
                "tile_templates_json": json.dumps(_tianditu_templates("img_w"), ensure_ascii=False),
                "label_tile_templates_json": json.dumps(_tianditu_templates("cia_w"), ensure_ascii=False),
                "requires_api_key": 1,
                "is_default": 0,
                "sort_order": 30,
            },
        ]

        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO basemaps (
                    basemap_key,
                    name,
                    provider,
                    kind,
                    attribution,
                    tile_templates_json,
                    label_tile_templates_json,
                    requires_api_key,
                    is_default,
                    sort_order
                )
                VALUES (
                    :basemap_key,
                    :name,
                    :provider,
                    :kind,
                    :attribution,
                    :tile_templates_json,
                    :label_tile_templates_json,
                    :requires_api_key,
                    :is_default,
                    :sort_order
                )
                ON CONFLICT(basemap_key) DO UPDATE SET
                    name=excluded.name,
                    provider=excluded.provider,
                    kind=excluded.kind,
                    attribution=excluded.attribution,
                    tile_templates_json=excluded.tile_templates_json,
                    label_tile_templates_json=excluded.label_tile_templates_json,
                    requires_api_key=excluded.requires_api_key,
                    is_default=excluded.is_default,
                    sort_order=excluded.sort_order
                """,
                basemaps,
            )
            conn.commit()


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
