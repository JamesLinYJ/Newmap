from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from shapely import from_wkb

from gis_common.geojson import ensure_feature_collection, load_geojson, save_geojson
from gis_common.ids import make_id
from shared_types.schemas import LayerDescriptor


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


class LayerCatalog:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.catalog_dir = data_dir / "catalog"
        self.upload_dir = data_dir / "uploads"
        self.upload_index_dir = self.upload_dir / "index"
        self.upload_index_dir.mkdir(parents=True, exist_ok=True)

    def list_layers(self) -> list[LayerDescriptor]:
        descriptors: list[LayerDescriptor] = []
        catalog = json.loads((self.catalog_dir / "catalog.json").read_text(encoding="utf-8"))
        for entry in catalog["layers"]:
            collection = self.get_layer_collection(entry["layer_key"])
            descriptors.append(
                LayerDescriptor(
                    **entry,
                    feature_count=len(collection.get("features", [])),
                    tags=["builtin"],
                )
            )
        for path in sorted(self.upload_index_dir.glob("*.json")):
            payload = json.loads(path.read_text(encoding="utf-8"))
            descriptors.append(LayerDescriptor(**payload))
        return descriptors

    def resolve_layer_key(self, layer_key_or_name: str) -> str:
        return SEMANTIC_LAYER_ALIASES.get(layer_key_or_name, layer_key_or_name)

    def get_layer_collection(self, layer_key: str) -> dict[str, Any]:
        resolved = self.resolve_layer_key(layer_key)
        builtin_path = self.catalog_dir / f"{resolved}.geojson"
        upload_path = self.upload_dir / f"{resolved}.geojson"
        if builtin_path.exists():
            return load_geojson(builtin_path)
        if upload_path.exists():
            return load_geojson(upload_path)
        raise KeyError(f"Layer '{layer_key}' was not found.")

    def get_layer_descriptor(self, layer_key: str) -> LayerDescriptor:
        resolved = self.resolve_layer_key(layer_key)
        for descriptor in self.list_layers():
            if descriptor.layer_key == resolved:
                return descriptor
        raise KeyError(f"Layer descriptor '{layer_key}' was not found.")

    def search_boundaries(self, name: str) -> list[dict[str, Any]]:
        query = name.casefold()
        boundaries = self.get_layer_collection("admin_boundaries")
        matches = []
        for feature in boundaries["features"]:
            props = feature["properties"]
            haystacks = [props.get("name", ""), props.get("name_en", ""), props.get("disambiguation", "")]
            if any(query in str(value).casefold() for value in haystacks):
                matches.append(feature)
        return matches

    def geocode(self, query: str) -> list[dict[str, Any]]:
        matches = self.search_boundaries(query)
        results = []
        for feature in matches:
            props = feature["properties"]
            results.append(
                {
                    "label": props.get("name"),
                    "name_en": props.get("name_en"),
                    "country": props.get("country"),
                    "disambiguation": props.get("disambiguation"),
                }
            )
        return results

    def register_upload(self, session_id: str, filename: str, payload: bytes) -> LayerDescriptor:
        suffix = Path(filename).suffix.lower()
        if suffix == ".geojson" or suffix == ".json":
            collection = ensure_feature_collection(json.loads(payload.decode("utf-8")))
        elif suffix == ".gpkg":
            collection = self._read_gpkg_features(payload)
        else:
            raise ValueError("仅支持上传 GeoJSON 或 GPKG。")

        layer_key = f"upload_{session_id[-6:]}_{make_id('layer')[-6:]}"
        save_geojson(self.upload_dir / f"{layer_key}.geojson", collection)
        descriptor = LayerDescriptor(
            layer_key=layer_key,
            name=Path(filename).stem,
            source_type="upload",
            geometry_type=self._infer_geometry_type(collection),
            srid=4326,
            description="用户上传图层",
            feature_count=len(collection["features"]),
            tags=["upload", session_id],
        )
        (self.upload_index_dir / f"{layer_key}.json").write_text(
            descriptor.model_dump_json(indent=2),
            encoding="utf-8",
        )
        return descriptor

    def _infer_geometry_type(self, collection: dict[str, Any]) -> str:
        if not collection["features"]:
            return "Unknown"
        return collection["features"][0]["geometry"]["type"]

    def _read_gpkg_features(self, payload: bytes) -> dict[str, Any]:
        temp_path = self.upload_dir / f"{make_id('gpkg')}.gpkg"
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
                geometry = from_wkb(self._gpkg_blob_to_wkb(geom_blob))
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

    def _gpkg_blob_to_wkb(self, blob: bytes) -> bytes:
        flags = blob[3]
        envelope_indicator = (flags >> 1) & 0b111
        envelope_length = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(envelope_indicator, 0)
        header_length = 8 + envelope_length
        return blob[header_length:]

