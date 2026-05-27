# +-------------------------------------------------------------------------
#
#   地理智能平台 - 矢量文件导入解析
#
#   文件:       vector_import.py
#
#   日期:       2026年05月26日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 统一解析用户上传和后台导入的矢量文件。所有非 GeoJSON 来源必须携带
# 可解析 CRS，并在入库前归一到 EPSG:4326，避免后续工具链猜坐标系。

from __future__ import annotations

import io
import json
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from pyproj import CRS
from shapely import from_wkb

from gis_common.crs import transform_feature_collection
from gis_common.geojson import ensure_feature_collection

from ._gpkg_utils import validate_gpkg_identifier

SUPPORTED_VECTOR_SUFFIXES = {".geojson", ".json", ".gpkg", ".zip"}


def parse_vector_upload_payload(filename: str, payload: bytes) -> dict[str, Any]:
    # 上传入口的唯一解析函数。
    #
    # GeoJSON 按 RFC7946 视为 EPSG:4326；GPKG 与 Shapefile 必须从文件内
    # CRS 元数据解析出坐标系，解析失败即停止，不做坐标猜测。
    suffix = Path(filename).suffix.lower()
    if suffix in {".geojson", ".json"}:
        return _read_geojson_features(payload)
    if suffix == ".gpkg":
        return _read_gpkg_features(payload)
    if suffix == ".zip":
        return _read_zipped_shapefile_features(payload)
    supported = "GeoJSON、GPKG 或 ZIP Shapefile"
    raise ValueError(f"仅支持上传 {supported}。")


def _read_geojson_features(payload: bytes) -> dict[str, Any]:
    collection = ensure_feature_collection(json.loads(payload.decode("utf-8")))
    crs = _geojson_crs(collection)
    if crs is None or _is_epsg_4326(crs):
        return collection
    return _normalize_collection_crs(collection, crs)


def _geojson_crs(collection: dict[str, Any]) -> CRS | None:
    raw = collection.get("crs")
    if not isinstance(raw, dict):
        return None
    properties = raw.get("properties")
    if not isinstance(properties, dict):
        return None
    name = properties.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    try:
        return CRS.from_user_input(name)
    except Exception as exc:
        raise ValueError(f"GeoJSON CRS 无法解析：{name}") from exc


def _read_gpkg_features(payload: bytes) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".gpkg", delete=False) as tmp:
        temp_path = Path(tmp.name)
        temp_path.write_bytes(payload)
    conn = sqlite3.connect(temp_path)
    try:
        row = conn.execute(
            """
            SELECT c.table_name, g.column_name, g.srs_id
            FROM gpkg_contents AS c
            JOIN gpkg_geometry_columns AS g ON c.table_name = g.table_name
            WHERE c.data_type = 'features'
            ORDER BY c.table_name
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            raise ValueError("GPKG 中没有可读取的要素图层。")
        table_name, geom_column, srs_id = row
        source_crs = _gpkg_crs(conn, int(srs_id))
        safe_name = validate_gpkg_identifier(table_name)
        columns = [info[1] for info in conn.execute(f"PRAGMA table_info('{safe_name}')").fetchall()]
        records = conn.execute(f"SELECT * FROM '{safe_name}'").fetchall()
        geom_idx = columns.index(geom_column)
        features = []
        for record in records:
            geom_blob = record[geom_idx]
            if geom_blob is None:
                continue
            geometry = from_wkb(_gpkg_blob_to_wkb(geom_blob))
            properties = {column: record[idx] for idx, column in enumerate(columns) if idx != geom_idx}
            features.append(
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": json.loads(json.dumps(geometry.__geo_interface__)),
                }
            )
        collection = {"type": "FeatureCollection", "features": features}
        return _normalize_collection_crs(collection, source_crs)
    finally:
        conn.close()
        temp_path.unlink(missing_ok=True)


def _gpkg_crs(conn: sqlite3.Connection, srs_id: int) -> CRS:
    if srs_id <= 0:
        raise ValueError("GPKG 图层缺少可解析 CRS，无法归一到 EPSG:4326。")
    row = conn.execute(
        """
        SELECT organization, organization_coordsys_id, definition
        FROM gpkg_spatial_ref_sys
        WHERE srs_id = ?
        """,
        (srs_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"GPKG CRS 记录不存在：srs_id={srs_id}")
    organization, organization_coordsys_id, definition = row
    try:
        if isinstance(organization, str) and organization.upper() == "EPSG" and int(organization_coordsys_id) > 0:
            return CRS.from_epsg(int(organization_coordsys_id))
        if isinstance(definition, str) and definition.strip() and definition.upper() not in {"UNDEFINED", "UNKNOWN"}:
            return CRS.from_wkt(definition)
    except Exception as exc:
        raise ValueError(f"GPKG CRS 无法解析：srs_id={srs_id}") from exc
    raise ValueError(f"GPKG CRS 无法解析：srs_id={srs_id}")


def _read_zipped_shapefile_features(payload: bytes) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="newmap_shp_") as temp_dir:
        temp_path = Path(temp_dir)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = _validate_shapefile_zip(archive)
            archive.extractall(temp_path, members=names.values())
        stem = Path(names["shp"]).stem
        shp_path = temp_path / names["shp"]
        prj_path = temp_path / names["prj"]
        source_crs = _shapefile_crs(prj_path)
        collection = _read_shapefile_collection(shp_path, stem=stem)
        return _normalize_collection_crs(collection, source_crs)


def _validate_shapefile_zip(archive: zipfile.ZipFile) -> dict[str, str]:
    # ZIP 只接受单套 shapefile，避免文件夹上传中的多套文件被错误拼接。
    entries: dict[str, str] = {}
    stems: set[str] = set()
    for info in archive.infolist():
        name = info.filename
        path = Path(name)
        if info.is_dir():
            continue
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("ZIP Shapefile 包含非法路径。")
        suffix = path.suffix.lower()
        if suffix not in {".shp", ".shx", ".dbf", ".prj"}:
            continue
        stem = path.with_suffix("").as_posix().casefold()
        stems.add(stem)
        if suffix[1:] in entries:
            raise ValueError("ZIP Shapefile 只能包含一套 .shp/.shx/.dbf/.prj。")
        entries[suffix[1:]] = name
    missing = [item for item in ("shp", "shx", "dbf", "prj") if item not in entries]
    if missing:
        raise ValueError(f"ZIP Shapefile 缺少必要文件：{', '.join('.' + item for item in missing)}。")
    if len(stems) != 1:
        raise ValueError("ZIP Shapefile 只能包含同一文件名 stem 的一套数据。")
    return entries


def _shapefile_crs(prj_path: Path) -> CRS:
    text = prj_path.read_text(encoding="utf-8", errors="ignore").strip()
    if not text:
        raise ValueError("Shapefile .prj 为空，无法归一到 EPSG:4326。")
    try:
        return CRS.from_wkt(text)
    except Exception as exc:
        raise ValueError("Shapefile .prj 无法解析，无法归一到 EPSG:4326。") from exc


def _read_shapefile_collection(shp_path: Path, *, stem: str) -> dict[str, Any]:
    try:
        import shapefile
    except Exception as exc:
        raise RuntimeError("缺少 pyshp 依赖，无法读取 ZIP Shapefile。") from exc

    reader = shapefile.Reader(str(shp_path))
    features = []
    for index, record_shape in enumerate(reader.iterShapeRecords()):
        shape_obj = record_shape.shape
        if shape_obj.shapeType == shapefile.NULL:
            continue
        properties = dict(record_shape.record.as_dict())
        properties.setdefault("_source", stem)
        properties.setdefault("_feature_index", index)
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": json.loads(json.dumps(shape_obj.__geo_interface__)),
            }
        )
    return {"type": "FeatureCollection", "features": features}


def _normalize_collection_crs(collection: dict[str, Any], source_crs: CRS) -> dict[str, Any]:
    epsg = source_crs.to_epsg()
    if _is_epsg_4326(source_crs):
        return collection
    if epsg is None:
        raise ValueError("矢量文件 CRS 不能映射到 EPSG 编码，无法归一到 EPSG:4326。")
    return transform_feature_collection(collection, int(epsg), 4326)


def _is_epsg_4326(crs: CRS) -> bool:
    return crs.to_epsg() == 4326


def _gpkg_blob_to_wkb(blob: bytes) -> bytes:
    flags = blob[3]
    envelope_indicator = (flags >> 1) & 0b111
    envelope_length = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(envelope_indicator, 0)
    header_length = 8 + envelope_length
    return blob[header_length:]
