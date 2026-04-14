from __future__ import annotations

import json
import sqlite3

from api_app.tool_catalog import ToolCatalogStore, build_descriptor_from_definition, build_registry_tool_descriptors
from tool_registry import build_default_registry


def test_schema_driven_descriptor_uses_pydantic_metadata():
    registry = build_default_registry()
    definition = registry.get_definition("buffer")

    descriptor = build_descriptor_from_definition(definition)
    parameters_by_key = {parameter.key: parameter for parameter in descriptor.parameters}

    assert descriptor.label == "缓冲区分析"
    assert parameters_by_key["input"].label == "输入要素"
    assert parameters_by_key["input"].source == "collection"
    assert parameters_by_key["distance_m"].data_type == "number"
    assert parameters_by_key["distance_m"].required is True


def test_sqlite_catalog_preserves_existing_overrides(tmp_path):
    registry = build_default_registry()
    catalog_store = ToolCatalogStore(tmp_path)
    catalog_store.ensure_schema(registry=registry)

    override_payload = {
        "label": "Buffer Override",
        "description": "来自 SQLite 的覆盖说明。",
        "group": "analysis-lab",
        "tags": ["custom", "buffer"],
        "toolKind": "registry",
        "parameters": {
            "distance_m": {
                "label": "距离上限",
                "defaultValue": 2500,
            }
        },
    }
    with sqlite3.connect(catalog_store.db_path) as connection:
        connection.execute(
            """
            UPDATE tool_catalog_entries
            SET payload_json = ?
            WHERE tool_name = ? AND tool_kind = ?
            """,
            (json.dumps(override_payload, ensure_ascii=False), "buffer", "registry"),
        )
        connection.commit()

    catalog_store.ensure_schema(registry=registry)
    catalog = catalog_store.load_catalog()
    descriptor = next(item for item in build_registry_tool_descriptors(registry, catalog) if item.name == "buffer")
    parameters_by_key = {parameter.key: parameter for parameter in descriptor.parameters}

    assert catalog["tools"]["buffer"]["label"] == "Buffer Override"
    assert descriptor.label == "Buffer Override"
    assert descriptor.group == "analysis-lab"
    assert parameters_by_key["distance_m"].label == "距离上限"
    assert parameters_by_key["distance_m"].default_value == 2500
