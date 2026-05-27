# +-------------------------------------------------------------------------
#
#   地理智能平台 - 文件图层目录实现
#
#   文件:       layer_catalog.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 定义图层目录抽象与基于文件的基础图层管理能力。

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from gis_common.geojson import load_geojson, save_geojson
from gis_common.ids import make_id
from shared_types.schemas import LayerDescriptor

from .vector_import import parse_vector_upload_payload


def resolve_catalog_layer_key(layer_key_or_name: str, available_keys: list[str] | None = None) -> str:
    # catalog key 解析坚持“精确优先”。
    #
    # 当前仓库尚未发版，不再维护 demo 时代那套“语义别名 -> 旧前缀 key”
    # 的隐式映射规则。agent 若要选层，应先从 catalog 里拿真实 layer_key，
    # 再把精确 key 传进来。
    candidate = layer_key_or_name.strip()
    if not candidate:
        return candidate

    if not available_keys:
        return candidate

    exact_matches = {item.casefold(): item for item in available_keys}
    exact = exact_matches.get(candidate.casefold())
    if exact:
        return exact
    return candidate


# LayerCatalog
#
# 文件目录版图层存储，负责：
# 1. 读取内置 catalog 图层
# 2. 读取用户上传图层
# 3. 提供边界搜索与基础 geocode 支持
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
        return resolve_catalog_layer_key(layer_key_or_name, [descriptor.layer_key for descriptor in self.list_layers()])

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
        matches = []
        boundary_layers = [
            descriptor.layer_key
            for descriptor in self.list_layers()
            if any(
                token in " ".join(
                    [
                        descriptor.name.casefold(),
                        descriptor.description.casefold(),
                        descriptor.category.casefold(),
                        *(item.casefold() for item in descriptor.tags),
                        *(item.casefold() for item in descriptor.analysis_capabilities),
                    ]
                )
                for token in ("boundary", "admin", "行政区", "边界")
            )
        ]
        for layer_key in boundary_layers:
            collection = self.get_layer_collection(layer_key)
            for feature in collection["features"]:
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
        # 上传图层注册。
        collection = parse_vector_upload_payload(filename, payload)

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
