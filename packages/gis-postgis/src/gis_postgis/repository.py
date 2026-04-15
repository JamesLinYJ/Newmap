from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from shapely import from_wkb

from gis_common.geojson import ensure_feature_collection, load_geojson
from gis_common.ids import make_id
from shared_types.schemas import LayerDescriptor

from .postgis_catalog import PostGISLayerCatalog


SEMANTIC_LAYER_ALIASES = {
    "医院": "hospitals",
    "hospital": "hospitals",
    "hospitals": "hospitals",
    "poi": "candidate_sites",
    "候选点": "candidate_sites",
    "候选点位": "candidate_sites",
    "地铁站": "metro_stations",
    "metro": "metro_stations",
    "metro_stations": "metro_stations",
    "行政区": "admin_boundaries",
    "边界": "admin_boundaries",
}


class PostGISLayerRepository(PostGISLayerCatalog):
    def __init__(self, *, database_url: str, seed_dir: Path):
        super().__init__(data_dir=seed_dir.parent, database_url=database_url)
        self.seed_dir = seed_dir.resolve()

    def bootstrap_seed_layers(self, force: bool = False) -> None:
        catalog = json.loads((self.seed_dir / "catalog.json").read_text(encoding="utf-8"))
        with self._connect() as conn, conn.cursor() as cur:
            for entry in catalog["layers"]:
                layer_key = entry["layer_key"]
                table_name = self._table_name_for(layer_key, prefix="layer")
                if self._metadata_exists(cur, layer_key) and not force:
                    continue
                collection = load_geojson(self.seed_dir / f"{layer_key}.geojson")
                self._replace_table_collection(cur, table_name, collection)
                descriptor = LayerDescriptor(
                    **entry,
                    feature_count=len(collection["features"]),
                    tags=["builtin", "postgis"],
                )
                self._upsert_metadata(cur, descriptor, table_name)

    def resolve_layer_key(self, layer_key_or_name: str) -> str:
        return SEMANTIC_LAYER_ALIASES.get(layer_key_or_name, layer_key_or_name)

    def register_upload(self, session_id: str, filename: str, payload: bytes) -> LayerDescriptor:
        collection = _parse_upload_payload(filename, payload)
        layer_key = f"upload_{session_id[-6:]}_{make_id('layer')[-6:]}"
        table_name = self._table_name_for(layer_key, prefix="upload")
        descriptor = LayerDescriptor(
            layer_key=layer_key,
            name=Path(filename).stem,
            source_type="upload",
            geometry_type=self._infer_geometry_type(collection),
            srid=4326,
            description="用户上传图层",
            feature_count=len(collection["features"]),
            tags=["upload", session_id, "postgis"],
        )
        with self._connect() as conn, conn.cursor() as cur:
            self._replace_table_collection(cur, table_name, collection)
            self._upsert_metadata(cur, descriptor, table_name)
        return descriptor

    def get_layer_collection(self, layer_key: str) -> dict[str, Any]:
        return super().get_layer_collection(self.resolve_layer_key(layer_key))

    def get_layer_descriptor(self, layer_key: str) -> LayerDescriptor:
        return super().get_layer_descriptor(self.resolve_layer_key(layer_key))

    def search_boundaries(self, name: str) -> list[dict[str, Any]]:
        return super().search_boundaries(name)


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
        columns = [info[1] for info in conn.execute(f"PRAGMA table_info('{table_name}')").fetchall()]
        records = conn.execute(f"SELECT * FROM '{table_name}'").fetchall()
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
