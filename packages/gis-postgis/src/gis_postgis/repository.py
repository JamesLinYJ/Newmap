# +-------------------------------------------------------------------------
#
#   地理智能平台 - PostGIS 图层仓储
#
#   文件:       repository.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
# 模块职责
#
# 在 PostGIS catalog 能力之上补充图层导入、后台管理、上传注册和图层 key 解析等仓储职责。
from __future__ import annotations

import json
import re
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from shapely import from_wkb

from ._gpkg_utils import validate_gpkg_identifier
from gis_common.geojson import ensure_feature_collection
from gis_common.ids import make_id
from shared_types.schemas import LayerDescriptor

from .postgis_catalog import PostGISLayerCatalog


class PostGISLayerRepository(PostGISLayerCatalog):
    def __init__(self, *, database_url: str, seed_dir: Path):
        super().__init__(data_dir=seed_dir.parent, database_url=database_url)
        self.seed_dir = seed_dir.resolve()

    def resolve_layer_key(self, layer_key_or_name: str) -> str:
        candidate = layer_key_or_name.strip()
        if not candidate:
            return candidate
        descriptors = self.list_layers()
        exact = next((descriptor.layer_key for descriptor in descriptors if descriptor.layer_key.casefold() == candidate.casefold()), None)
        if exact:
            return exact
        by_name = [descriptor.layer_key for descriptor in descriptors if descriptor.name.casefold() == candidate.casefold()]
        if len(by_name) == 1:
            return by_name[0]
        return candidate

    def register_upload(self, session_id: str, filename: str, payload: bytes, *, thread_id: str | None = None) -> LayerDescriptor:
        collection = _parse_upload_payload(filename, payload)
        layer_key = f"upload_{session_id[-6:]}_{make_id('layer')[-6:]}"
        table_name = self._table_name_for(layer_key, prefix="upload")
        descriptor = LayerDescriptor(
            layer_key=layer_key,
            name=Path(filename).stem,
            source_type="session_upload",
            geometry_type=self._infer_geometry_type(collection),
            srid=4326,
            description="用户上传图层",
            feature_count=len(collection["features"]),
            category=_infer_layer_category(Path(filename).stem, collection),
            status="active",
            tags=["upload", "session", "postgis"],
            analysis_capabilities=_infer_analysis_capabilities(collection),
            source_config_summary=f"会话上传 · {filename}",
            session_id=session_id,
            thread_id=thread_id,
        )
        with self._connect() as conn, conn.cursor() as cur:
            self._replace_table_collection(cur, table_name, collection)
            self._upsert_metadata(cur, descriptor, table_name)
        return descriptor

    def create_managed_layer(
        self,
        *,
        name: str,
        collection: dict[str, Any],
        description: str = "",
        category: str | None = None,
        tags: list[str] | None = None,
        status: str = "active",
        analysis_capabilities: list[str] | None = None,
        source_type: str = "managed",
        source_config_summary: str | None = None,
    ) -> LayerDescriptor:
        normalized_collection = ensure_feature_collection(collection)
        layer_key = self._build_managed_layer_key(name)
        table_name = self._table_name_for(layer_key, prefix="layer")
        descriptor = LayerDescriptor(
            layer_key=layer_key,
            name=name.strip(),
            source_type=source_type,
            geometry_type=self._infer_geometry_type(normalized_collection),
            srid=4326,
            description=description.strip() or f"{name.strip()} 图层",
            feature_count=len(normalized_collection["features"]),
            category=category or _infer_layer_category(name, normalized_collection),
            status=status,
            tags=list(dict.fromkeys(tags or [])),
            analysis_capabilities=analysis_capabilities or _infer_analysis_capabilities(normalized_collection),
            source_config_summary=source_config_summary,
        )
        with self._connect() as conn, conn.cursor() as cur:
            self._replace_table_collection(cur, table_name, normalized_collection)
            self._upsert_metadata(cur, descriptor, table_name)
        return descriptor

    def import_managed_layer(
        self,
        *,
        filename: str,
        payload: bytes,
        name: str | None = None,
        description: str = "",
        category: str | None = None,
        tags: list[str] | None = None,
        status: str = "active",
        analysis_capabilities: list[str] | None = None,
        source_config_summary: str | None = None,
    ) -> LayerDescriptor:
        collection = _parse_upload_payload(filename, payload)
        return self.create_managed_layer(
            name=name or Path(filename).stem,
            collection=collection,
            description=description,
            category=category,
            tags=tags,
            status=status,
            analysis_capabilities=analysis_capabilities,
            source_type="managed_import",
            source_config_summary=source_config_summary or f"后台导入 · {filename}",
        )

    def update_managed_layer(
        self,
        layer_key: str,
        *,
        name: str | None = None,
        description: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
        status: str | None = None,
        analysis_capabilities: list[str] | None = None,
        source_config_summary: str | None = None,
    ) -> LayerDescriptor:
        fields: dict[str, Any] = {}
        if name is not None:
            fields["name"] = name.strip()
        if description is not None:
            fields["description"] = description.strip()
        if category is not None:
            fields["category"] = category
        if tags is not None:
            fields["tags"] = list(dict.fromkeys(tags))
        if status is not None:
            fields["status"] = status
        if analysis_capabilities is not None:
            fields["analysis_capabilities"] = list(dict.fromkeys(analysis_capabilities))
        if source_config_summary is not None:
            fields["source_config_summary"] = source_config_summary.strip() or None
        return self.update_layer_descriptor(layer_key, **fields)

    def replace_managed_layer_data(
        self,
        layer_key: str,
        *,
        filename: str,
        payload: bytes,
    ) -> LayerDescriptor:
        collection = _parse_upload_payload(filename, payload)
        descriptor = self.get_layer_descriptor(layer_key)
        table_name = self._lookup_table_name(descriptor.layer_key)
        updated = descriptor.model_copy(
            update={
                "geometry_type": self._infer_geometry_type(collection),
                "feature_count": len(collection["features"]),
                "source_config_summary": f"后台替换 · {filename}",
                "analysis_capabilities": _infer_analysis_capabilities(collection),
            }
        )
        with self._connect() as conn, conn.cursor() as cur:
            self._replace_table_collection(cur, table_name, collection)
            self._upsert_metadata(cur, updated, table_name)
        return updated

    def get_layer_collection(self, layer_key: str) -> dict[str, Any]:
        return super().get_layer_collection(self.resolve_layer_key(layer_key))

    def get_layer_descriptor(self, layer_key: str, *, allow_inactive: bool = True) -> LayerDescriptor:
        return super().get_layer_descriptor(self.resolve_layer_key(layer_key), allow_inactive=allow_inactive)

    def search_boundaries(self, name: str) -> list[dict[str, Any]]:
        return super().search_boundaries(name)

    def _build_managed_layer_key(self, name: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")
        if not base:
            base = make_id("layer")
        candidate = base[:48]
        if not any(item.layer_key == candidate for item in self.list_layers()):
            return candidate
        return f"{candidate[:40]}_{make_id('layer')[-6:]}"


def _parse_upload_payload(filename: str, payload: bytes) -> dict[str, Any]:
    suffix = Path(filename).suffix.lower()
    if suffix in {".geojson", ".json"}:
        return ensure_feature_collection(json.loads(payload.decode("utf-8")))
    if suffix == ".gpkg":
        return _read_gpkg_features(payload)
    raise ValueError("仅支持上传 GeoJSON 或 GPKG。")


def _read_gpkg_features(payload: bytes) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".gpkg", delete=False) as tmp:
        temp_path = Path(tmp.name)
        temp_path.write_bytes(payload)
    conn = sqlite3.connect(temp_path)
    try:
        row = conn.execute(
            """
            SELECT c.table_name, g.column_name
            FROM gpkg_contents AS c
            JOIN gpkg_geometry_columns AS g ON c.table_name = g.table_name
            WHERE c.data_type = 'features'
            ORDER BY c.table_name
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            raise ValueError("GPKG 中没有可读取的要素图层。")
        table_name, geom_column = row
        safe_name = validate_gpkg_identifier(table_name)
        columns = [info[1] for info in conn.execute(f"PRAGMA table_info('{safe_name}')").fetchall()]
        records = conn.execute(f"SELECT * FROM '{safe_name}'").fetchall()
        features = []
        geom_idx = columns.index(geom_column)
        for record in records:
            geom_blob = record[geom_idx]
            properties = {column: record[idx] for idx, column in enumerate(columns) if idx != geom_idx}
            geometry = from_wkb(_gpkg_blob_to_wkb(geom_blob))
            features.append(
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": json.loads(json.dumps(geometry.__geo_interface__)),
                }
            )
        return {"type": "FeatureCollection", "features": features}
    finally:
        conn.close()
        temp_path.unlink(missing_ok=True)


def _gpkg_blob_to_wkb(blob: bytes) -> bytes:
    flags = blob[3]
    envelope_indicator = (flags >> 1) & 0b111
    envelope_length = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(envelope_indicator, 0)
    header_length = 8 + envelope_length
    return blob[header_length:]


def _infer_layer_category(name: str, collection: dict[str, Any]) -> str:
    normalized = name.casefold()
    if any(token in normalized for token in ("边界", "boundary", "district", "admin")):
        return "admin_boundary"
    if any(token in normalized for token in ("医院", "hospital", "clinic")):
        return "healthcare"
    if any(token in normalized for token in ("地铁", "metro", "subway", "station", "轨道")):
        return "transport"
    if any(token in normalized for token in ("机场", "airport")):
        return "transport"
    geometry_type = _infer_geometry_type(collection)
    if geometry_type.endswith("Polygon"):
        return "area"
    if geometry_type.endswith("LineString"):
        return "network"
    return "poi"


def _infer_analysis_capabilities(collection: dict[str, Any]) -> list[str]:
    geometry_type = _infer_geometry_type(collection)
    capabilities = ["preview"]
    if geometry_type.endswith("Point"):
        capabilities.extend(["buffer", "distance", "point_query"])
    if geometry_type.endswith("Polygon"):
        capabilities.extend(["clip", "intersect", "boundary"])
    if geometry_type.endswith("LineString"):
        capabilities.extend(["buffer", "network"])
    return list(dict.fromkeys(capabilities))


def _infer_geometry_type(collection: dict[str, Any]) -> str:
    features = collection.get("features", [])
    if not features:
        return "Unknown"
    geometry = features[0].get("geometry") or {}
    return str(geometry.get("type") or "Unknown")
