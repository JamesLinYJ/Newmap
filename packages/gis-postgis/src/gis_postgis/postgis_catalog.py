# +-------------------------------------------------------------------------
#
#   地理智能平台 - PostGIS 图层目录实现
#
#   文件:       postgis_catalog.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql

from gis_common.geojson import load_geojson, save_geojson
from gis_common.ids import make_id
from shared_types.schemas import LayerDescriptor

from .layer_catalog import LayerCatalog


# PostGISLayerCatalog
#
# PostGIS 后端版图层目录与分析实现。
# 对外保持 LayerCatalog 风格接口，但会把更多工作交给数据库。
class PostGISLayerCatalog(LayerCatalog):
    def __init__(self, data_dir: Path, database_url: str):
        super().__init__(data_dir)
        self.database_url = database_url

    def ensure_schema(self) -> None:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS postgis")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS layers_metadata (
                    layer_key TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    geometry_type TEXT NOT NULL,
                    srid INTEGER NOT NULL DEFAULT 4326,
                    table_name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    feature_count INTEGER,
                    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )

    def bootstrap_builtin_layers(self, force: bool = False) -> None:
        # 内置图层灌库。
        catalog = json.loads((self.catalog_dir / "catalog.json").read_text(encoding="utf-8"))
        with self._connect() as conn, conn.cursor() as cur:
            for entry in catalog["layers"]:
                layer_key = entry["layer_key"]
                table_name = self._table_name_for(layer_key, prefix="layer")
                exists = self._metadata_exists(cur, layer_key)
                if exists and not force:
                    continue
                collection = load_geojson(self.catalog_dir / f"{layer_key}.geojson")
                self._replace_table_collection(cur, table_name, collection)
                descriptor = LayerDescriptor(
                    **entry,
                    feature_count=len(collection["features"]),
                    tags=["builtin", "postgis"],
                )
                self._upsert_metadata(cur, descriptor, table_name)

    def list_layers(self) -> list[LayerDescriptor]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT layer_key, name, source_type, geometry_type, srid, description, feature_count, tags
                FROM layers_metadata
                ORDER BY CASE source_type WHEN 'builtin' THEN 0 WHEN 'upload' THEN 1 ELSE 2 END, name
                """
            )
            rows = cur.fetchall()
        return [
            LayerDescriptor(
                layer_key=row[0],
                name=row[1],
                source_type=row[2],
                geometry_type=row[3],
                srid=row[4],
                description=row[5],
                feature_count=row[6],
                tags=row[7] or [],
            )
            for row in rows
        ]

    def get_layer_collection(self, layer_key: str) -> dict[str, Any]:
        resolved = self.resolve_layer_key(layer_key)
        table_name = self._lookup_table_name(resolved)
        with self._connect() as conn, conn.cursor() as cur:
            return self._feature_collection_from_query(cur, self._select_feature_collection_sql(table_name))

    def get_layer_descriptor(self, layer_key: str) -> LayerDescriptor:
        resolved = self.resolve_layer_key(layer_key)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT layer_key, name, source_type, geometry_type, srid, description, feature_count, tags
                FROM layers_metadata
                WHERE layer_key = %s
                """,
                (resolved,),
            )
            row = cur.fetchone()
        if row is None:
            raise KeyError(f"Layer descriptor '{layer_key}' was not found.")
        return LayerDescriptor(
            layer_key=row[0],
            name=row[1],
            source_type=row[2],
            geometry_type=row[3],
            srid=row[4],
            description=row[5],
            feature_count=row[6],
            tags=row[7] or [],
        )

    def search_boundaries(self, name: str) -> list[dict[str, Any]]:
        query = f"%{name.casefold()}%"
        table_name = self._lookup_table_name("admin_boundaries")
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                self._feature_list_sql(table_name, where_sql="""
                    lower(coalesce(properties->>'name', '')) LIKE %s
                    OR lower(coalesce(properties->>'name_en', '')) LIKE %s
                    OR lower(coalesce(properties->>'disambiguation', '')) LIKE %s
                """),
                (query, query, query),
            )
            rows = cur.fetchall()
        return [row[0] for row in rows]

    def geocode(self, query: str) -> list[dict[str, Any]]:
        matches = self.search_boundaries(query)
        return [
            {
                "label": feature["properties"].get("name"),
                "name_en": feature["properties"].get("name_en"),
                "country": feature["properties"].get("country"),
                "disambiguation": feature["properties"].get("disambiguation"),
                "source": "postgis",
            }
            for feature in matches
        ]

    def register_upload(self, session_id: str, filename: str, payload: bytes) -> LayerDescriptor:
        descriptor = super().register_upload(session_id, filename, payload)
        collection = load_geojson(self.upload_dir / f"{descriptor.layer_key}.geojson")
        table_name = self._table_name_for(descriptor.layer_key, prefix="upload")
        with self._connect() as conn, conn.cursor() as cur:
            self._replace_table_collection(cur, table_name, collection)
            self._upsert_metadata(cur, descriptor, table_name)
        return descriptor.model_copy(update={"tags": [*descriptor.tags, "postgis"]})

    def save_result_layer(self, run_id: str, alias: str, name: str, collection: dict[str, Any]) -> LayerDescriptor:
        safe_alias = re.sub(r"[^a-z0-9_]+", "_", alias.lower())[:32]
        layer_key = f"result_{run_id[-6:]}_{safe_alias}"
        table_name = self._table_name_for(layer_key, prefix="result")
        descriptor = LayerDescriptor(
            layer_key=layer_key,
            name=name,
            source_type="result",
            geometry_type=self._infer_geometry_type(collection),
            srid=4326,
            description=f"运行 {run_id} 的分析结果图层",
            feature_count=len(collection["features"]),
            tags=["result", run_id, "postgis"],
        )
        with self._connect() as conn, conn.cursor() as cur:
            self._replace_table_collection(cur, table_name, collection)
            self._upsert_metadata(cur, descriptor, table_name)
        return descriptor

    def load_layer_collection(
        self,
        layer_key: str,
        *,
        area_name: str | None = None,
        boundary: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        table_name = self._lookup_table_name(self.resolve_layer_key(layer_key))
        where_clauses: list[str] = []
        params: list[Any] = []
        if area_name:
            where_clauses.append("lower(coalesce(properties->>'city', '')) = lower(%s)")
            params.append(area_name)
        if boundary and boundary.get("features"):
            boundary_json = json.dumps(self._union_geometry_feature(boundary)["geometry"], ensure_ascii=False)
            where_clauses.append("ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))")
            params.append(boundary_json)
        where_sql = " AND ".join(where_clauses) if where_clauses else None
        with self._connect() as conn, conn.cursor() as cur:
            return self._feature_collection_from_query(cur, self._select_feature_collection_sql(table_name, where_sql), tuple(params))

    def buffer_collection(self, collection: dict[str, Any], distance_m: float) -> dict[str, Any]:
        temp_table = self._table_name_for(make_id("buffer"), prefix="tmp")
        with self._connect() as conn, conn.cursor() as cur:
            self._create_feature_table(cur, temp_table, temporary=True)
            self._insert_collection(cur, temp_table, collection)
            return self._feature_collection_from_query(
                cur,
                sql.SQL(
                    """
                    WITH centroid AS (
                        SELECT ST_Centroid(ST_Collect(geom)) AS geom FROM {table}
                    ),
                    epsg AS (
                        SELECT CAST(
                            CASE
                                WHEN ST_Y(geom) >= 0 THEN 32600 + FLOOR((ST_X(geom) + 180) / 6) + 1
                                ELSE 32700 + FLOOR((ST_X(geom) + 180) / 6) + 1
                            END AS INTEGER
                        ) AS srid
                        FROM centroid
                    ),
                    buffered AS (
                        SELECT
                            properties,
                            ST_Transform(ST_Buffer(ST_Transform(geom, (SELECT srid FROM epsg)), %s), 4326) AS geom
                        FROM {table}
                    )
                    SELECT json_build_object(
                        'type', 'FeatureCollection',
                        'features', COALESCE(
                            json_agg(
                                json_build_object(
                                    'type', 'Feature',
                                    'properties', properties,
                                    'geometry', ST_AsGeoJSON(geom)::json
                                )
                            ),
                            '[]'::json
                        )
                    )
                    FROM buffered
                    """
                ).format(table=sql.Identifier(temp_table)),
                (distance_m,),
            )

    def intersect_collections(self, left: dict[str, Any], right: dict[str, Any], *, clip: bool = False) -> dict[str, Any]:
        left_table = self._table_name_for(make_id("left"), prefix="tmp")
        right_table = self._table_name_for(make_id("right"), prefix="tmp")
        with self._connect() as conn, conn.cursor() as cur:
            self._create_feature_table(cur, left_table, temporary=True)
            self._create_feature_table(cur, right_table, temporary=True)
            self._insert_collection(cur, left_table, left)
            self._insert_collection(cur, right_table, right)
            geom_expr = (
                "CASE WHEN GeometryType(l.geom) LIKE 'ST_Point%%' THEN l.geom ELSE ST_Intersection(l.geom, r.geom) END"
                if clip
                else "CASE WHEN GeometryType(l.geom) LIKE 'ST_Point%%' THEN l.geom ELSE ST_Intersection(l.geom, r.geom) END"
            )
            return self._feature_collection_from_query(
                cur,
                sql.SQL(
                    f"""
                    WITH right_union AS (
                        SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM {{right_table}}
                    ),
                    intersections AS (
                        SELECT
                            l.properties,
                            {geom_expr} AS geom
                        FROM {{left_table}} AS l
                        CROSS JOIN right_union AS r
                        WHERE ST_Intersects(l.geom, r.geom)
                    )
                    SELECT json_build_object(
                        'type', 'FeatureCollection',
                        'features', COALESCE(
                            json_agg(
                                json_build_object(
                                    'type', 'Feature',
                                    'properties', properties,
                                    'geometry', ST_AsGeoJSON(geom)::json
                                )
                            ) FILTER (WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)),
                            '[]'::json
                        )
                    )
                    FROM intersections
                    """
                ).format(left_table=sql.Identifier(left_table), right_table=sql.Identifier(right_table)),
            )

    def point_in_polygon_collection(self, points: dict[str, Any], polygons: dict[str, Any]) -> dict[str, Any]:
        point_table = self._table_name_for(make_id("points"), prefix="tmp")
        polygon_table = self._table_name_for(make_id("polygons"), prefix="tmp")
        with self._connect() as conn, conn.cursor() as cur:
            self._create_feature_table(cur, point_table, temporary=True)
            self._create_feature_table(cur, polygon_table, temporary=True)
            self._insert_collection(cur, point_table, points)
            self._insert_collection(cur, polygon_table, polygons)
            return self._feature_collection_from_query(
                cur,
                sql.SQL(
                    """
                    WITH poly AS (
                        SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM {polygon_table}
                    ),
                    inside AS (
                        SELECT
                            p.properties || jsonb_build_object('inside', true) AS properties,
                            p.geom
                        FROM {point_table} AS p
                        CROSS JOIN poly
                        WHERE ST_Within(p.geom, poly.geom)
                    )
                    SELECT json_build_object(
                        'type', 'FeatureCollection',
                        'features', COALESCE(
                            json_agg(
                                json_build_object(
                                    'type', 'Feature',
                                    'properties', properties,
                                    'geometry', ST_AsGeoJSON(geom)::json
                                )
                            ),
                            '[]'::json
                        )
                    )
                    FROM inside
                    """
                ).format(point_table=sql.Identifier(point_table), polygon_table=sql.Identifier(polygon_table)),
            )

    def spatial_join_collection(self, points: dict[str, Any], polygons: dict[str, Any]) -> dict[str, Any]:
        point_table = self._table_name_for(make_id("points"), prefix="tmp")
        polygon_table = self._table_name_for(make_id("polygons"), prefix="tmp")
        with self._connect() as conn, conn.cursor() as cur:
            self._create_feature_table(cur, point_table, temporary=True)
            self._create_feature_table(cur, polygon_table, temporary=True)
            self._insert_collection(cur, point_table, points)
            self._insert_collection(cur, polygon_table, polygons)
            return self._feature_collection_from_query(
                cur,
                sql.SQL(
                    """
                    WITH joined AS (
                        SELECT
                            p.properties || jsonb_build_object('join_name', poly.properties->>'name') AS properties,
                            p.geom
                        FROM {point_table} AS p
                        JOIN LATERAL (
                            SELECT properties
                            FROM {polygon_table}
                            WHERE ST_Within(p.geom, geom)
                            LIMIT 1
                        ) AS poly ON TRUE
                    )
                    SELECT json_build_object(
                        'type', 'FeatureCollection',
                        'features', COALESCE(
                            json_agg(
                                json_build_object(
                                    'type', 'Feature',
                                    'properties', properties,
                                    'geometry', ST_AsGeoJSON(geom)::json
                                )
                            ),
                            '[]'::json
                        )
                    )
                    FROM joined
                    """
                ).format(point_table=sql.Identifier(point_table), polygon_table=sql.Identifier(polygon_table)),
            )

    def distance_query_collection(self, source: dict[str, Any], target: dict[str, Any], distance_m: float) -> dict[str, Any]:
        source_table = self._table_name_for(make_id("source"), prefix="tmp")
        target_table = self._table_name_for(make_id("target"), prefix="tmp")
        with self._connect() as conn, conn.cursor() as cur:
            self._create_feature_table(cur, source_table, temporary=True)
            self._create_feature_table(cur, target_table, temporary=True)
            self._insert_collection(cur, source_table, source)
            self._insert_collection(cur, target_table, target)
            return self._feature_collection_from_query(
                cur,
                sql.SQL(
                    """
                    WITH matched AS (
                        SELECT DISTINCT
                            t.properties,
                            t.geom
                        FROM {target_table} AS t
                        JOIN {source_table} AS s
                          ON ST_DWithin(s.geom::geography, t.geom::geography, %s)
                    )
                    SELECT json_build_object(
                        'type', 'FeatureCollection',
                        'features', COALESCE(
                            json_agg(
                                json_build_object(
                                    'type', 'Feature',
                                    'properties', properties,
                                    'geometry', ST_AsGeoJSON(geom)::json
                                )
                            ),
                            '[]'::json
                        )
                    )
                    FROM matched
                    """
                ).format(source_table=sql.Identifier(source_table), target_table=sql.Identifier(target_table)),
                (distance_m,),
            )

    def _connect(self):
        # 数据库连接。
        try:
            return psycopg.connect(self.database_url, autocommit=True, connect_timeout=1)
        except psycopg.OperationalError as exc:
            redacted_url = _redact_database_url(self.database_url)
            raise psycopg.OperationalError(
                f"PostGIS connection failed for '{redacted_url}': {exc.__class__.__name__}: {exc}"
            ) from exc

    def _metadata_exists(self, cur, layer_key: str) -> bool:
        cur.execute("SELECT 1 FROM layers_metadata WHERE layer_key = %s", (layer_key,))
        return cur.fetchone() is not None

    def _lookup_table_name(self, layer_key: str) -> str:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT table_name FROM layers_metadata WHERE layer_key = %s", (layer_key,))
            row = cur.fetchone()
        if row is None:
            raise KeyError(f"Layer '{layer_key}' was not found.")
        return row[0]

    def _replace_table_collection(self, cur, table_name: str, collection: dict[str, Any]) -> None:
        self._create_feature_table(cur, table_name)
        cur.execute(sql.SQL("TRUNCATE TABLE {}").format(sql.Identifier(table_name)))
        self._insert_collection(cur, table_name, collection)

    def _create_feature_table(self, cur, table_name: str, temporary: bool = False) -> None:
        temp_prefix = sql.SQL("TEMP ") if temporary else sql.SQL("")
        cur.execute(
            sql.SQL(
                """
                CREATE {temp_prefix}TABLE IF NOT EXISTS {table_name} (
                    feature_id BIGSERIAL PRIMARY KEY,
                    properties JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                    geom geometry(Geometry, 4326)
                )
                """
            ).format(
                temp_prefix=temp_prefix,
                table_name=sql.Identifier(table_name),
            )
        )
        if not temporary:
            cur.execute(
                sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} USING GIST (geom)").format(
                    sql.Identifier(f"idx_{table_name}_geom"),
                    sql.Identifier(table_name),
                )
            )

    def _insert_collection(self, cur, table_name: str, collection: dict[str, Any]) -> None:
        rows = [
            (
                json.dumps(feature.get("properties", {}), ensure_ascii=False),
                json.dumps(feature.get("geometry"), ensure_ascii=False),
            )
            for feature in collection.get("features", [])
        ]
        if not rows:
            return
        cur.executemany(
            sql.SQL(
                "INSERT INTO {} (properties, geom) VALUES (%s::jsonb, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))"
            ).format(sql.Identifier(table_name)),
            rows,
        )

    def _upsert_metadata(self, cur, descriptor: LayerDescriptor, table_name: str) -> None:
        cur.execute(
            """
            INSERT INTO layers_metadata (
                layer_key, name, source_type, geometry_type, srid, table_name, description, feature_count, tags, metadata_json, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, NOW())
            ON CONFLICT (layer_key) DO UPDATE SET
                name = EXCLUDED.name,
                source_type = EXCLUDED.source_type,
                geometry_type = EXCLUDED.geometry_type,
                srid = EXCLUDED.srid,
                table_name = EXCLUDED.table_name,
                description = EXCLUDED.description,
                feature_count = EXCLUDED.feature_count,
                tags = EXCLUDED.tags,
                metadata_json = EXCLUDED.metadata_json,
                updated_at = NOW()
            """,
            (
                descriptor.layer_key,
                descriptor.name,
                descriptor.source_type,
                descriptor.geometry_type,
                descriptor.srid,
                table_name,
                descriptor.description,
                descriptor.feature_count,
                json.dumps(descriptor.tags, ensure_ascii=False),
                json.dumps({"table_name": table_name}, ensure_ascii=False),
            ),
        )

    def _select_feature_collection_sql(self, table_name: str, where_sql: str | None = None):
        where_clause = sql.SQL(f"WHERE {where_sql}") if where_sql else sql.SQL("")
        return sql.SQL(
            """
            SELECT json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(
                    json_agg(
                        json_build_object(
                            'type', 'Feature',
                            'properties', properties,
                            'geometry', ST_AsGeoJSON(geom)::json
                        )
                    ) FILTER (WHERE geom IS NOT NULL),
                    '[]'::json
                )
            )
            FROM {table_name}
            {where_clause}
            """
        ).format(table_name=sql.Identifier(table_name), where_clause=where_clause)

    def _feature_list_sql(self, table_name: str, where_sql: str):
        return sql.SQL(
            f"""
            SELECT json_build_object(
                'type', 'Feature',
                'properties', properties,
                'geometry', ST_AsGeoJSON(geom)::json
            )
            FROM {{table_name}}
            WHERE {where_sql}
            """
        ).format(table_name=sql.Identifier(table_name))

    def _feature_collection_from_query(self, cur, query, params: tuple[Any, ...] = ()) -> dict[str, Any]:
        cur.execute(query, params)
        row = cur.fetchone()
        return row[0] if row and row[0] else {"type": "FeatureCollection", "features": []}

    def _table_name_for(self, value: str, prefix: str) -> str:
        safe = re.sub(r"[^a-z0-9_]+", "_", value.lower())
        return f"{prefix}_{safe[:48]}"

    def _union_geometry_feature(self, collection: dict[str, Any]) -> dict[str, Any]:
        if not collection.get("features"):
            return {"type": "Feature", "properties": {}, "geometry": None}
        if len(collection["features"]) == 1:
            return collection["features"][0]
        return {
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "GeometryCollection",
                "geometries": [feature["geometry"] for feature in collection["features"]],
            },
        }


def _redact_database_url(database_url: str) -> str:
    try:
        parts = urlsplit(database_url)
    except Exception:
        return "<redacted>"

    hostname = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    username = parts.username or ""
    netloc = f"{username}:***@{hostname}{port}" if username else f"{hostname}{port}"
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))
