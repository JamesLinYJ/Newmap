# +-------------------------------------------------------------------------
#
#   地理智能平台 - PostGIS 图层目录实现
#
#   文件:       postgis_catalog.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 实现基于 PostGIS 的图层目录、空间查询和结果图层落库逻辑。

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
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
            self._create_metadata_table(cur)

    def list_layers(self, *, include_inactive: bool = True, session_id: str | None = None) -> list[LayerDescriptor]:
        with self._connect() as conn, conn.cursor() as cur:
            self._create_metadata_table(cur)
            conditions: list[str] = []
            params: list[Any] = []
            if not include_inactive:
                conditions.append("coalesce(metadata_json->>'status', 'active') = 'active'")
            if session_id is not None:
                conditions.append(
                    "(metadata_json->>'session_id' = %s OR source_type IN ('managed', 'managed_import'))"
                )
                params.append(session_id)
            where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
            cur.execute(
                f"""
                SELECT layer_key, name, source_type, geometry_type, srid, description, feature_count, tags, metadata_json
                FROM layers_metadata
                {where_sql}
                ORDER BY
                    CASE coalesce(metadata_json->>'status', 'active') WHEN 'active' THEN 0 ELSE 1 END,
                    CASE source_type WHEN 'managed' THEN 0 WHEN 'managed_import' THEN 1 WHEN 'session_upload' THEN 2 WHEN 'upload' THEN 3 ELSE 4 END,
                    name
                """,
                tuple(params),
            )
            rows = cur.fetchall()
        return [self._descriptor_from_row(row) for row in rows]

    def list_active_layers(self) -> list[LayerDescriptor]:
        # agent 规划与 load_layer 默认只面向 active catalog。
        return self.list_layers(include_inactive=False)

    def get_layer_collection(self, layer_key: str) -> dict[str, Any]:
        resolved = self.resolve_layer_key(layer_key)
        self.get_layer_descriptor(resolved, allow_inactive=False)
        table_name = self._lookup_table_name(resolved)
        with self._connect() as conn, conn.cursor() as cur:
            return self._feature_collection_from_query(cur, self._select_feature_collection_sql(table_name))

    def get_layer_descriptor(self, layer_key: str, *, allow_inactive: bool = True) -> LayerDescriptor:
        resolved = self.resolve_layer_key(layer_key)
        with self._connect() as conn, conn.cursor() as cur:
            self._create_metadata_table(cur)
            cur.execute(
                """
                SELECT layer_key, name, source_type, geometry_type, srid, description, feature_count, tags, metadata_json
                FROM layers_metadata
                WHERE layer_key = %s
                """,
                (resolved,),
            )
            row = cur.fetchone()
        if row is None:
            raise KeyError(f"Layer descriptor '{layer_key}' was not found.")
        descriptor = self._descriptor_from_row(row)
        if not allow_inactive and descriptor.status != "active":
            raise KeyError(f"Layer '{layer_key}' is not active.")
        return descriptor

    def search_boundaries(self, name: str) -> list[dict[str, Any]]:
        query = f"%{name.casefold()}%"
        boundary_layers = [
            layer
            for layer in self.list_active_layers()
            if layer.category == "admin_boundary" or "admin_boundary" in layer.tags or "boundary" in layer.analysis_capabilities
        ]
        if not boundary_layers:
            return []

        matches: list[dict[str, Any]] = []
        with self._connect() as conn, conn.cursor() as cur:
            for layer in boundary_layers:
                table_name = self._lookup_table_name(layer.layer_key)
                cur.execute(
                    self._feature_list_sql(table_name, where_sql="""
                        lower(coalesce(properties->>'name', '')) LIKE %s
                        OR lower(coalesce(properties->>'name_en', '')) LIKE %s
                        OR lower(coalesce(properties->>'disambiguation', '')) LIKE %s
                    """),
                    (query, query, query),
                )
                matches.extend(row[0] for row in cur.fetchall())
        return matches

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
        with self.transaction() as conn, conn.cursor() as cur:
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
        with self.transaction() as conn, conn.cursor() as cur:
            # 结果图层可能发生在独立开发数据库或刚初始化的本地环境里。
            #
            # 这里在写结果前再次确保 metadata 表存在，避免地点定位这类轻量查询
            # 明明已经解析成功，却在最终落盘阶段被基础 catalog 表缺失打断。
            self._create_metadata_table(cur)
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

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        """多语句事务上下文：临时关闭 autocommit，统一提交或回滚。"""
        with self._connect() as conn:
            conn.autocommit = False
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

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
        self._create_metadata_table(cur)
        cur.execute("SELECT 1 FROM layers_metadata WHERE layer_key = %s", (layer_key,))
        return cur.fetchone() is not None

    def _lookup_table_name(self, layer_key: str) -> str:
        with self._connect() as conn, conn.cursor() as cur:
            self._create_metadata_table(cur)
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
        # 图层表按当前主 schema 直接创建。
        #
        # 这里不维护旧残留修复逻辑；测试和开发环境都应先通过显式清理
        # 保证 schema 干净，再由主路径幂等建表。
        index_name = f"idx_{table_name}_geom"
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
                sql.Identifier(index_name),
                sql.Identifier(table_name),
            )
                )

    def _create_metadata_table(self, cur) -> None:
        # metadata 根表是整个 catalog 的唯一事实索引。
        #
        # 这里显式加事务级 advisory lock，并在建表前清理可能由中断 DDL 留下的
        # 同名孤儿 composite type，保证测试和本地热重载都只走一条稳定主路径。
        cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("layers_metadata_schema",))
        if self._relation_exists(cur, "layers_metadata"):
            return
        if self._type_exists(cur, "layers_metadata"):
            cur.execute("DROP TYPE IF EXISTS layers_metadata CASCADE")
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

    def _relation_exists(self, cur, relation_name: str) -> bool:
        cur.execute("SELECT to_regclass(%s)", (relation_name,))
        row = cur.fetchone()
        return bool(row and row[0])

    def _type_exists(self, cur, type_name: str) -> bool:
        cur.execute("SELECT to_regtype(%s)", (type_name,))
        row = cur.fetchone()
        return bool(row and row[0])

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
        self._create_metadata_table(cur)
        metadata_payload = {
            "table_name": table_name,
            "category": descriptor.category,
            "status": descriptor.status,
            "analysis_capabilities": descriptor.analysis_capabilities,
            "source_config_summary": descriptor.source_config_summary,
            "session_id": descriptor.session_id,
        }
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
                json.dumps(metadata_payload, ensure_ascii=False),
            ),
        )

    def delete_layer(self, layer_key: str) -> bool:
        resolved = self.resolve_layer_key(layer_key)
        with self._connect() as conn, conn.cursor() as cur:
            self._create_metadata_table(cur)
            cur.execute("SELECT table_name FROM layers_metadata WHERE layer_key = %s", (resolved,))
            row = cur.fetchone()
            if row is None:
                return False
            table_name = row[0]
            cur.execute(sql.SQL("DELETE FROM layers_metadata WHERE layer_key = %s"), (resolved,))
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(sql.Identifier(table_name)))
        return True

    def update_layer_descriptor(self, layer_key: str, **fields: Any) -> LayerDescriptor:
        current = self.get_layer_descriptor(layer_key)
        updated = current.model_copy(update=fields)
        table_name = self._lookup_table_name(updated.layer_key)
        with self._connect() as conn, conn.cursor() as cur:
            self._create_metadata_table(cur)
            self._upsert_metadata(cur, updated, table_name)
        return updated

    def _descriptor_from_row(self, row: tuple[Any, ...]) -> LayerDescriptor:
        metadata = row[8] or {}
        return LayerDescriptor(
            layer_key=row[0],
            name=row[1],
            source_type=row[2],
            geometry_type=row[3],
            srid=row[4],
            description=row[5],
            feature_count=row[6],
            tags=row[7] or [],
            category=str(metadata.get("category") or "general"),
            status=str(metadata.get("status") or "active"),
            analysis_capabilities=[str(item) for item in metadata.get("analysis_capabilities", [])],
            source_config_summary=str(metadata.get("source_config_summary")) if metadata.get("source_config_summary") else None,
            session_id=str(metadata.get("session_id")) if metadata.get("session_id") else None,
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
