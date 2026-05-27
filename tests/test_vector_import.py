# +-------------------------------------------------------------------------
#
#   地理智能平台 - 矢量导入解析测试
#
#   文件:       test_vector_import.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定 GeoJSON/GPKG/ZIP Shapefile 进入平台前的解析边界。
# Shapefile 必须携带 CRS，不允许后台猜坐标系。

from __future__ import annotations

import io
import zipfile

import pytest
from pyproj import CRS

shapefile = pytest.importorskip("shapefile")

from gis_postgis.vector_import import parse_vector_upload_payload


def test_zipped_shapefile_imports_polygon_with_prj(tmp_path) -> None:
    # ZIP Shapefile 是浏览器上传 shp 的唯一入口。
    #
    # 一套 shp/shx/dbf/prj 必须完整，解析后统一输出 FeatureCollection。
    archive = _make_zipped_shapefile(tmp_path, include_prj=True)

    collection = parse_vector_upload_payload("area.zip", archive)

    assert collection["type"] == "FeatureCollection"
    assert collection["features"][0]["geometry"]["type"] == "Polygon"
    assert collection["features"][0]["properties"]["name"] == "study"


def test_zipped_shapefile_without_prj_fails(tmp_path) -> None:
    archive = _make_zipped_shapefile(tmp_path, include_prj=False)

    with pytest.raises(ValueError, match="缺少必要文件：.prj"):
        parse_vector_upload_payload("area.zip", archive)


def test_unknown_vector_suffix_fails() -> None:
    with pytest.raises(ValueError, match="GeoJSON、GPKG 或 ZIP Shapefile"):
        parse_vector_upload_payload("area.shp", b"not-a-complete-shapefile")


def _make_zipped_shapefile(tmp_path, *, include_prj: bool) -> bytes:
    shp_dir = tmp_path / ("with_prj" if include_prj else "without_prj")
    shp_dir.mkdir()
    shp_path = shp_dir / "area.shp"
    writer = shapefile.Writer(str(shp_path))
    writer.field("name", "C")
    writer.poly([[[120.0, 30.0], [121.0, 30.0], [121.0, 31.0], [120.0, 31.0], [120.0, 30.0]]])
    writer.record("study")
    writer.close()
    if include_prj:
        (shp_dir / "area.prj").write_text(CRS.from_epsg(4326).to_wkt(), encoding="utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in shp_dir.iterdir():
            archive.write(path, arcname=path.name)
    return buffer.getvalue()
