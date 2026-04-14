# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具目录构建与存储
#
#   文件:       tool_catalog.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from shared_types import ToolDescriptor, ToolParameterDescriptor, ToolParameterOption
from tool_registry import ToolDefinition, ToolRegistry


# ToolCatalogStore
#
# SQLite 目录存储层，只保存工具目录与展示 override，
# 不承载真正的可执行逻辑。
class ToolCatalogStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.system_dir = data_dir / "system"
        self.system_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.system_dir / "tool_catalog.sqlite3"

    def ensure_schema(self, *, registry: ToolRegistry) -> None:
        # SQLite schema 初始化
        #
        # 只保证表存在，并在之后补默认目录项；
        # 不在这里做破坏性迁移，避免本地调试配置被意外覆盖。
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_catalog_entries (
                    tool_name TEXT NOT NULL,
                    tool_kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (tool_name, tool_kind)
                )
                """
            )
            conn.commit()
        self._seed_missing_defaults(registry)

    def load_catalog(self) -> dict[str, Any]:
        # 目录载入
        #
        # 返回的是一份面向构建器的内存视图，而不是最终对外接口结果。
        # registry descriptor、QGIS algorithm descriptor 和 model descriptor
        # 都会在各自阶段把它当作 override 源。
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT tool_name, tool_kind, payload_json
                FROM tool_catalog_entries
                ORDER BY sort_order, tool_kind, tool_name
                """
            ).fetchall()

        catalog: dict[str, Any] = {
            "tools": {},
            "qgisAlgorithms": {},
            "qgisModels": {},
        }
        for tool_name, tool_kind, payload_json in rows:
            payload = json.loads(payload_json)
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
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT tool_name, tool_kind, payload_json, sort_order
                FROM tool_catalog_entries
                ORDER BY sort_order, tool_kind, tool_name
                """
            ).fetchall()
        return [
            {
                "toolName": tool_name,
                "toolKind": tool_kind,
                "payload": json.loads(payload_json),
                "sortOrder": sort_order,
            }
            for tool_name, tool_kind, payload_json, sort_order in rows
        ]

    def get_entry(self, *, tool_name: str, tool_kind: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT payload_json, sort_order
                FROM tool_catalog_entries
                WHERE tool_name = ? AND tool_kind = ?
                """,
                (tool_name, tool_kind),
            ).fetchone()
        if row is None:
            return None
        payload_json, sort_order = row
        return {
            "toolName": tool_name,
            "toolKind": tool_kind,
            "payload": json.loads(payload_json),
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
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO tool_catalog_entries (
                    tool_name,
                    tool_kind,
                    payload_json,
                    sort_order
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(tool_name, tool_kind) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    sort_order = excluded.sort_order
                """,
                (tool_name, tool_kind, json.dumps(payload, ensure_ascii=False), resolved_sort_order),
            )
            conn.commit()
        return self.get_entry(tool_name=tool_name, tool_kind=tool_kind) or {
            "toolName": tool_name,
            "toolKind": tool_kind,
            "payload": payload,
            "sortOrder": resolved_sort_order,
        }

    def delete_entry(self, *, tool_name: str, tool_kind: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                DELETE FROM tool_catalog_entries
                WHERE tool_name = ? AND tool_kind = ?
                """,
                (tool_name, tool_kind),
            )
            conn.commit()
        return bool(cursor.rowcount)

    def _seed_missing_defaults(self, registry: ToolRegistry) -> None:
        # 初始目录 seed
        #
        # 仅补齐缺失项，不覆盖已有 SQLite 记录，
        # 让目录配置可以持续通过管理接口演进。
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

        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT OR IGNORE INTO tool_catalog_entries (
                    tool_name,
                    tool_kind,
                    payload_json,
                    sort_order
                )
                VALUES (
                    :tool_name,
                    :tool_kind,
                    :payload_json,
                    :sort_order
                )
                """,
                rows,
            )
            conn.commit()


def build_registry_tool_descriptors(registry: ToolRegistry, catalog: dict[str, Any]) -> list[ToolDescriptor]:
    # Registry ToolDescriptor 构建。
    #
    # registry 是可执行定义的真相源；SQLite 只在这里覆盖展示和参数细节。
    tool_overrides = catalog.get("tools", {})
    descriptors: list[ToolDescriptor] = []
    for definition in registry.list_definitions():
        if definition.name in {"run_qgis_model", "run_qgis_processing_algorithm"}:
            continue
        override = tool_overrides.get(definition.name, {})
        descriptors.append(build_descriptor_from_definition(definition, override=override))
    return descriptors


def build_descriptor_from_definition(definition: ToolDefinition, *, override: dict[str, Any] | None = None) -> ToolDescriptor:
    # ToolDefinition -> ToolDescriptor
    #
    # 统一把代码中的工具定义投影为前端调试页可以直接消费的结构化描述。
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
    # 参数描述派生
    #
    # 以 Pydantic JSON Schema 为真相源，避免再维护一份手写参数表。
    args_model = definition.args_model
    if args_model is None:
        return []

    parameter_overrides = parameter_overrides or {}
    schema = args_model.model_json_schema(by_alias=True)
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    parameters: list[ToolParameterDescriptor] = []

    for field_name, field in args_model.model_fields.items():
        schema_key = field.alias or field_name
        prop = properties.get(schema_key, {})
        override = parameter_overrides.get(schema_key, parameter_overrides.get(field_name, {}))
        prop_type = _extract_data_type(prop)
        parameters.append(
            ToolParameterDescriptor(
                key=schema_key,
                label=str(override.get("label") or prop.get("title") or schema_key),
                data_type=str(override.get("dataType") or prop_type),
                source=str(override.get("source") or prop.get("x-ui-source") or _default_source(prop_type)),
                required=bool(override.get("required", schema_key in required)),
                description=override.get("description") or prop.get("description"),
                placeholder=override.get("placeholder") or prop.get("x-ui-placeholder") or prop.get("placeholder"),
                default_value=override.get("defaultValue", prop.get("default")),
                options=_extract_options(override.get("options"), prop),
            )
        )

    return parameters


def build_qgis_algorithm_descriptors(
    discovered_algorithms: list[dict[str, Any]],
    *,
    available: bool,
    error: str | None,
    catalog: dict[str, Any],
) -> list[ToolDescriptor]:
    # 动态 QGIS algorithm 描述构建。
    #
    # 先以 qgis-runtime 返回的发现结果为基线，再叠加 SQLite override，
    # 这样算法数量可以随运行时变化，而 UI 仍然能持续被人工打磨。
    algorithm_overrides = catalog.get("qgisAlgorithms", {})
    descriptors: list[ToolDescriptor] = []

    for algorithm in sorted(discovered_algorithms, key=lambda item: str(item.get("display_name") or item.get("id") or "")):
        algorithm_id = str(algorithm.get("id") or "")
        if not algorithm_id:
            continue
        override = algorithm_overrides.get(algorithm_id, {})
        parameters = _build_qgis_algorithm_parameters(algorithm, override.get("parameters"))
        descriptors.append(
            ToolDescriptor(
                name=algorithm_id,
                label=str(override.get("label") or algorithm.get("display_name") or algorithm_id),
                description=str(override.get("description") or algorithm.get("description") or "调用 QGIS Processing 算法。"),
                group=str(override.get("group") or "qgis"),
                tool_kind=str(override.get("toolKind") or "qgis_algorithm"),
                available=bool(override.get("available", available)),
                tags=[str(item) for item in override.get("tags", algorithm.get("tags", ["qgis", "algorithm"]))],
                parameters=parameters,
                error=str(override.get("error") or error) if (override.get("error") or error) else None,
                meta={
                    "providerId": algorithm.get("provider_id"),
                    "providerName": algorithm.get("provider_name"),
                    "groupName": algorithm.get("group"),
                    "outputs": algorithm.get("outputs", []),
                    "outputParameterName": override.get("outputParameterName") or algorithm.get("output_parameter_name"),
                    "algorithmId": algorithm_id,
                    **dict(override.get("meta", {})),
                },
            )
        )
    return descriptors


def build_qgis_model_descriptors(model_names: list[str], *, available: bool, error: str | None, catalog: dict[str, Any]) -> list[ToolDescriptor]:
    # QGIS model3 描述构建。
    qgis_models = catalog.get("qgisModels", {})
    defaults = qgis_models.get("defaults", {})
    default_parameters = [ToolParameterDescriptor.model_validate(item) for item in defaults.get("parameters", [])]
    descriptors: list[ToolDescriptor] = []

    for model_name in sorted(model_names):
        override = qgis_models.get(model_name, {})
        parameters_payload = override.get("parameters")
        parameters = [ToolParameterDescriptor.model_validate(item) for item in parameters_payload] if isinstance(parameters_payload, list) else default_parameters
        descriptors.append(
            ToolDescriptor(
                name=model_name,
                label=str(override.get("label") or f"QGIS 模型 · {model_name}"),
                description=str(override.get("description") or "调用 qgis-runtime 中已发现的模型。"),
                group=str(override.get("group") or "qgis"),
                tool_kind=str(override.get("toolKind") or "qgis_model"),
                available=bool(override.get("available", available)),
                tags=[str(item) for item in override.get("tags", ["qgis", "model"])],
                parameters=parameters,
                error=str(override.get("error") or error) if (override.get("error") or error) else None,
                meta={"modelName": model_name, **dict(override.get("meta", {}))},
            )
        )
    return descriptors


def _extract_data_type(prop: dict[str, Any]) -> str:
    if "enum" in prop:
        return "string"
    if "anyOf" in prop:
        for candidate in prop["anyOf"]:
            candidate_type = candidate.get("type")
            if candidate_type and candidate_type != "null":
                return str(candidate_type)
    return str(prop.get("type") or "string")


def _default_source(data_type: str) -> str:
    return {
        "number": "number",
        "integer": "number",
        "boolean": "boolean",
        "object": "json",
    }.get(data_type, "text")


def _extract_options(override_options: Any, prop: dict[str, Any]) -> list[ToolParameterOption]:
    if isinstance(override_options, list):
        return [ToolParameterOption.model_validate(item) for item in override_options]
    if "enum" not in prop:
        return []
    return [ToolParameterOption(label=str(item), value=str(item)) for item in prop["enum"]]


def _build_qgis_algorithm_parameters(algorithm: dict[str, Any], overrides: Any) -> list[ToolParameterDescriptor]:
    # QGIS 参数自动映射
    #
    # 基于 runtime 返回的原生参数定义生成参数描述，只接受 SQLite 的局部覆盖。
    parameter_overrides = overrides if isinstance(overrides, dict) else {}
    parameters_payload = algorithm.get("parameters", [])
    parameters: list[ToolParameterDescriptor] = []

    for parameter in parameters_payload:
        if parameter.get("is_destination"):
            continue
        key = str(parameter.get("name") or "")
        if not key:
            continue
        override = parameter_overrides.get(key, {})
        param_type = str(parameter.get("type") or "string")
        data_type = str(override.get("dataType") or _map_qgis_parameter_data_type(param_type))
        parameters.append(
            ToolParameterDescriptor(
                key=key,
                label=str(override.get("label") or parameter.get("description") or key),
                data_type=data_type,
                source=str(override.get("source") or _map_qgis_parameter_source(param_type, parameter)),
                required=bool(override.get("required", not bool(parameter.get("optional")))),
                description=str(override.get("description") or parameter.get("help") or parameter.get("description") or ""),
                placeholder=override.get("placeholder"),
                default_value=override.get("defaultValue", parameter.get("default_value")),
                options=_map_qgis_parameter_options(parameter, override.get("options")),
            )
        )

    return _append_common_qgis_execution_parameters(parameters)


def _append_common_qgis_execution_parameters(parameters: list[ToolParameterDescriptor]) -> list[ToolParameterDescriptor]:
    # QGIS 通用执行参数补齐
    #
    # save_as_artifact 和 result_name 不是算法原生参数，
    # 而是平台级执行选项，因此在这里统一补上，避免每个算法重复声明。
    existing = {parameter.key for parameter in parameters}
    result = list(parameters)
    if "save_as_artifact" not in existing:
        result.append(
            ToolParameterDescriptor(
                key="save_as_artifact",
                label="保存为结果",
                data_type="boolean",
                source="boolean",
                default_value=True,
            )
        )
    if "result_name" not in existing:
        result.append(
            ToolParameterDescriptor(
                key="result_name",
                label="结果名称",
                data_type="string",
                source="text",
                placeholder="可选",
            )
        )
    return result


def _map_qgis_parameter_data_type(parameter_type: str) -> str:
    mapping = {
        "boolean": "boolean",
        "distance": "number",
        "number": "number",
        "scale": "number",
        "enum": "string",
        "expression": "string",
        "field": "string",
        "string": "string",
        "crs": "string",
        "extent": "string",
        "source": "string",
        "vector": "string",
        "raster": "string",
        "file": "string",
        "folder": "string",
    }
    return mapping.get(parameter_type, "string")


def _map_qgis_parameter_source(parameter_type: str, parameter: dict[str, Any]) -> str:
    if parameter_type in {"boolean"}:
        return "boolean"
    if parameter_type in {"number", "distance", "scale"}:
        return "number"
    if parameter_type == "enum":
        return "text"
    if parameter_type in {"source", "vector", "raster"}:
        return "collection"
    if parameter_type in {"matrix", "map", "json"}:
        return "json"
    return "text"


def _map_qgis_parameter_options(parameter: dict[str, Any], override_options: Any) -> list[ToolParameterOption]:
    if isinstance(override_options, list):
        return [ToolParameterOption.model_validate(item) for item in override_options]
    options = parameter.get("options")
    if not isinstance(options, list):
        return []
    return [ToolParameterOption(label=str(option), value=str(index)) for index, option in enumerate(options)]
