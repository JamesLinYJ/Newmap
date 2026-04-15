from __future__ import annotations

import json
from typing import Any

from shared_types import ToolDescriptor, ToolParameterDescriptor, ToolParameterOption
from tool_registry import ToolDefinition, ToolRegistry

from .postgres import connect_postgres


class ToolCatalogStore:
    def __init__(self, database_url: str):
        self.database_url = database_url

    def ensure_schema(self, *, registry: ToolRegistry) -> None:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_catalog_entries (
                    tool_name TEXT NOT NULL,
                    tool_kind TEXT NOT NULL,
                    payload_json JSONB NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (tool_name, tool_kind)
                )
                """
            )
        self._seed_missing_defaults(registry)

    def load_catalog(self) -> dict[str, Any]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT tool_name, tool_kind, payload_json
                FROM tool_catalog_entries
                ORDER BY sort_order, tool_kind, tool_name
                """
            )
            rows = cur.fetchall()

        catalog: dict[str, Any] = {
            "tools": {},
            "qgisAlgorithms": {},
            "qgisModels": {},
        }
        for tool_name, tool_kind, payload_json in rows:
            payload = payload_json or {}
            if tool_kind == "registry":
                catalog["tools"][tool_name] = payload
            elif tool_kind == "qgis_algorithm":
                catalog["qgisAlgorithms"][tool_name] = payload
            elif tool_kind == "qgis_model_default":
                catalog["qgisModels"]["defaults"] = payload
            elif tool_kind == "qgis_model_override":
                catalog["qgisModels"][tool_name] = payload
        return catalog

    def list_entries(self) -> list[dict[str, Any]]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT tool_name, tool_kind, payload_json, sort_order
                FROM tool_catalog_entries
                ORDER BY sort_order, tool_kind, tool_name
                """
            )
            rows = cur.fetchall()
        return [
            {
                "toolName": tool_name,
                "toolKind": tool_kind,
                "payload": payload_json or {},
                "sortOrder": sort_order,
            }
            for tool_name, tool_kind, payload_json, sort_order in rows
        ]

    def get_entry(self, *, tool_name: str, tool_kind: str) -> dict[str, Any] | None:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT payload_json, sort_order
                FROM tool_catalog_entries
                WHERE tool_name = %s AND tool_kind = %s
                """,
                (tool_name, tool_kind),
            )
            row = cur.fetchone()
        if row is None:
            return None
        payload_json, sort_order = row
        return {
            "toolName": tool_name,
            "toolKind": tool_kind,
            "payload": payload_json or {},
            "sortOrder": sort_order,
        }

    def upsert_entry(
        self,
        *,
        tool_name: str,
        tool_kind: str,
        payload: dict[str, Any],
        sort_order: int | None = None,
    ) -> dict[str, Any]:
        current = self.get_entry(tool_name=tool_name, tool_kind=tool_kind)
        resolved_sort_order = sort_order if sort_order is not None else int(current["sortOrder"]) if current else 0
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO tool_catalog_entries (tool_name, tool_kind, payload_json, sort_order)
                VALUES (%s, %s, %s::jsonb, %s)
                ON CONFLICT (tool_name, tool_kind) DO UPDATE SET
                    payload_json = EXCLUDED.payload_json,
                    sort_order = EXCLUDED.sort_order
                """,
                (tool_name, tool_kind, json.dumps(payload, ensure_ascii=False), resolved_sort_order),
            )
        return self.get_entry(tool_name=tool_name, tool_kind=tool_kind) or {
            "toolName": tool_name,
            "toolKind": tool_kind,
            "payload": payload,
            "sortOrder": resolved_sort_order,
        }

    def delete_entry(self, *, tool_name: str, tool_kind: str) -> bool:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM tool_catalog_entries
                WHERE tool_name = %s AND tool_kind = %s
                """,
                (tool_name, tool_kind),
            )
            deleted = cur.rowcount
        return bool(deleted)

    def _seed_missing_defaults(self, registry: ToolRegistry) -> None:
        rows = []
        for index, definition in enumerate(registry.list_definitions(), start=1):
            if definition.name in {"run_qgis_model", "run_qgis_processing_algorithm"}:
                continue
            rows.append(
                {
                    "tool_name": definition.name,
                    "tool_kind": "registry",
                    "payload_json": json.dumps(
                        {
                            "label": definition.metadata.label,
                            "description": definition.metadata.description,
                            "group": definition.metadata.group,
                            "tags": definition.metadata.tags,
                            "toolKind": definition.metadata.tool_kind,
                            "meta": definition.metadata.meta,
                        },
                        ensure_ascii=False,
                    ),
                    "sort_order": index * 10,
                }
            )

        rows.extend(
            [
                {
                    "tool_name": "__default__",
                    "tool_kind": "qgis_model_default",
                    "payload_json": json.dumps(
                        {
                            "parameters": [
                                ToolParameterDescriptor(key="artifact_id", label="输入结果", data_type="string", source="artifact", required=True).model_dump(mode="json"),
                                ToolParameterDescriptor(
                                    key="inputs_json",
                                    label="附加参数 JSON",
                                    data_type="json",
                                    source="json",
                                    placeholder='例如：{"DISTANCE": 1000}',
                                ).model_dump(mode="json"),
                                ToolParameterDescriptor(key="save_as_artifact", label="保存为结果", data_type="boolean", source="boolean", default_value=True).model_dump(mode="json"),
                                ToolParameterDescriptor(key="result_name", label="结果名称", data_type="string", source="text", placeholder="可选").model_dump(mode="json"),
                            ]
                        },
                        ensure_ascii=False,
                    ),
                    "sort_order": 910,
                },
                {
                    "tool_name": "buffer_and_intersect",
                    "tool_kind": "qgis_model_override",
                    "payload_json": json.dumps(
                        {
                            "parameters": [
                                ToolParameterDescriptor(key="artifact_id", label="输入结果", data_type="string", source="artifact", required=True).model_dump(mode="json"),
                                ToolParameterDescriptor(key="overlay_artifact_id", label="叠加图层", data_type="string", source="artifact", required=True).model_dump(mode="json"),
                                ToolParameterDescriptor(key="distance", label="距离（米）", data_type="number", source="number", default_value=1000).model_dump(mode="json"),
                                ToolParameterDescriptor(key="save_as_artifact", label="保存为结果", data_type="boolean", source="boolean", default_value=True).model_dump(mode="json"),
                                ToolParameterDescriptor(key="result_name", label="结果名称", data_type="string", source="text", default_value="QGIS 模型：buffer_and_intersect").model_dump(mode="json"),
                            ]
                        },
                        ensure_ascii=False,
                    ),
                    "sort_order": 920,
                },
            ]
        )

        with self._connect() as conn, conn.cursor() as cur:
            for row in rows:
                cur.execute(
                    """
                    INSERT INTO tool_catalog_entries (tool_name, tool_kind, payload_json, sort_order)
                    VALUES (%s, %s, %s::jsonb, %s)
                    ON CONFLICT (tool_name, tool_kind) DO NOTHING
                    """,
                    (row["tool_name"], row["tool_kind"], row["payload_json"], row["sort_order"]),
                )

    def _connect(self):
        return connect_postgres(self.database_url)


def build_registry_tool_descriptors(registry: ToolRegistry, catalog: dict[str, Any]) -> list[ToolDescriptor]:
    tool_overrides = catalog.get("tools", {})
    descriptors: list[ToolDescriptor] = []
    for definition in registry.list_definitions():
        if definition.name in {"run_qgis_model", "run_qgis_processing_algorithm"}:
            continue
        override = tool_overrides.get(definition.name, {})
        descriptors.append(build_descriptor_from_definition(definition, override=override))
    return descriptors


def build_descriptor_from_definition(definition: ToolDefinition, *, override: dict[str, Any] | None = None) -> ToolDescriptor:
    override = override or {}
    metadata = definition.metadata
    parameter_overrides = override.get("parameters", {})
    return ToolDescriptor(
        name=definition.name,
        label=str(override.get("label") or metadata.label),
        description=str(override.get("description") or metadata.description),
        group=str(override.get("group") or metadata.group),
        tool_kind=str(override.get("toolKind") or metadata.tool_kind),
        available=bool(override.get("available", True)),
        tags=[str(item) for item in override.get("tags", metadata.tags)],
        parameters=build_parameter_descriptors(definition, parameter_overrides=parameter_overrides),
        meta=dict(override.get("meta", metadata.meta)),
    )


def build_parameter_descriptors(
    definition: ToolDefinition,
    *,
    parameter_overrides: dict[str, Any] | None = None,
) -> list[ToolParameterDescriptor]:
    parameter_overrides = parameter_overrides or {}
    if definition.args_model is None:
        return []

    schema = definition.args_model.model_json_schema()
    required_keys = set(schema.get("required", []))
    properties = schema.get("properties", {})
    descriptors: list[ToolParameterDescriptor] = []
    for key, field_schema in properties.items():
        override = parameter_overrides.get(key, {})
        extra = {
            **(field_schema.get("json_schema_extra") or {}),
            **{item_key: item_value for item_key, item_value in field_schema.items() if item_key.startswith("x-") or item_key == "placeholder"},
        }
        options = [
            ToolParameterOption(label=str(item.get("label", item.get("value", ""))), value=str(item.get("value", "")))
            for item in (override.get("options") or extra.get("options") or [])
        ]
        descriptors.append(
            ToolParameterDescriptor(
                key=key,
                label=str(override.get("label") or field_schema.get("title") or key),
                data_type=_normalize_schema_type(str(field_schema.get("type", "string"))),
                source=str(override.get("source") or extra.get("x-ui-source") or "text"),
                required=bool(key in required_keys),
                description=str(override.get("description") or field_schema.get("description") or "") or None,
                placeholder=str(override.get("placeholder") or extra.get("placeholder") or "") or None,
                default_value=override.get("defaultValue", field_schema.get("default")),
                options=options,
            )
        )
    return descriptors


def build_qgis_algorithm_descriptors(
    algorithms: list[dict[str, Any]],
    *,
    available: bool,
    error: str | None,
    catalog: dict[str, Any],
) -> list[ToolDescriptor]:
    overrides = catalog.get("qgisAlgorithms", {})
    descriptors: list[ToolDescriptor] = []
    for algorithm in algorithms:
        override = overrides.get(algorithm.get("id"), {})
        parameters = []
        parameter_overrides = override.get("parameters", {})
        for parameter in algorithm.get("parameters", []):
            if parameter.get("is_destination"):
                continue
            current_override = parameter_overrides.get(parameter.get("name"), {})
            parameters.append(
                ToolParameterDescriptor(
                    key=str(parameter.get("name")),
                    label=str(current_override.get("label") or parameter.get("description") or parameter.get("name")),
                    data_type=_normalize_qgis_parameter_type(str(parameter.get("type") or "string")),
                    source="collection" if str(parameter.get("type") or "") in {"source", "vector", "raster"} else "text",
                    required=not bool(parameter.get("optional")),
                    description=str(parameter.get("help") or parameter.get("description") or "") or None,
                    default_value=current_override.get("defaultValue", parameter.get("default_value")),
                )
            )
        descriptors.append(
            ToolDescriptor(
                name=str(algorithm.get("id")),
                label=str(override.get("label") or algorithm.get("display_name") or algorithm.get("id")),
                description=str(override.get("description") or algorithm.get("description") or ""),
                group=str(override.get("group") or "qgis"),
                tool_kind="qgis_algorithm",
                available=available,
                tags=[str(item) for item in override.get("tags", algorithm.get("tags") or [])],
                parameters=parameters,
                error=error,
                meta={
                    "providerId": algorithm.get("provider_id"),
                    "providerName": algorithm.get("provider_name"),
                    "outputParameterName": algorithm.get("output_parameter_name"),
                    **dict(override.get("meta", {})),
                },
            )
        )
    return descriptors


def build_qgis_model_descriptors(models: list[str], *, available: bool, error: str | None, catalog: dict[str, Any]) -> list[ToolDescriptor]:
    defaults = catalog.get("qgisModels", {}).get("defaults", {})
    overrides = catalog.get("qgisModels", {})
    descriptors: list[ToolDescriptor] = []
    for model_name in models:
        override = overrides.get(model_name, {})
        parameter_payloads = override.get("parameters") or defaults.get("parameters") or []
        parameters = [ToolParameterDescriptor.model_validate(item) for item in parameter_payloads]
        descriptors.append(
            ToolDescriptor(
                name=model_name,
                label=str(override.get("label") or model_name),
                description=str(override.get("description") or f"QGIS 模型 {model_name}"),
                group=str(override.get("group") or "qgis"),
                tool_kind="qgis_model",
                available=available,
                tags=[str(item) for item in override.get("tags", ["qgis", "model"])],
                parameters=parameters,
                error=error,
                meta=dict(override.get("meta", {})),
            )
        )
    return descriptors


def _normalize_schema_type(value: str) -> str:
    mapping = {
        "string": "string",
        "number": "number",
        "integer": "number",
        "boolean": "boolean",
        "object": "json",
        "array": "json",
    }
    return mapping.get(value, "string")


def _normalize_qgis_parameter_type(value: str) -> str:
    mapping = {
        "distance": "number",
        "number": "number",
        "boolean": "boolean",
        "band": "number",
        "source": "string",
        "vector": "string",
        "raster": "string",
        "string": "string",
    }
    return mapping.get(value, "string")
