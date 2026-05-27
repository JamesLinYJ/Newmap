# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象工具 Provider
#
#   文件:       weather_tools.py
#
#   日期:       2026年05月27日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 将气象数据检查、渲染、统计、阈值、等值线、解读和报告工具接入标准
# ToolProvider。handler 只做 runtime 适配、valueRef 解析、artifact 持久化，
# 不承载气象算法本身。

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import Field

from gis_common.ids import make_id
from gis_weather import (
    INTERPRETATION_SCHEMA,
    WeatherDataService,
    build_interpretation_facts,
    build_interpretation_prompt,
    build_map_candidates,
    normalize_interpretation_payload,
    select_interpretation_variables,
)
from gis_weather.report import write_weather_report_docx

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime
from .charting import render_stat_chart
from .providers import ToolManifest
from .registry import ToolDefinition, ToolMetadata
from .value_refs import (
    ToolValueStore,
    make_value_ref_id,
    remember_value_ref,
    resolve_numeric_arg,
    resolve_value_ref,
    serialize_value_refs_for_model,
)

# ── Args models ───────────────────────────────────────────────────────────

class InspectMeteorologicalDatasetArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="需要检查的气象数据集 ID。", json_schema_extra={"x-ui-source": "text"})


class RenderMeteorologicalRasterArgs(ToolArgsModel):
    map_candidate_ref: str | None = Field(None, title="地图候选引用", description="interpret_meteorological_dataset 产出的地图候选 valueRef。", json_schema_extra={"x-ui-source": "text"})
    dataset_id: str | None = Field(None, title="气象数据集", description="需要渲染的数据集 ID。", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量名", description="要渲染的变量名。", json_schema_extra={"x-ui-source": "text"})
    variable_ref: str | None = Field(None, title="变量引用", description="inspect_meteorological_dataset 产出的变量 valueRef。", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间片", description="要渲染的时间片序号。", json_schema_extra={"x-ui-source": "number"})
    time_index_ref: str | None = Field(None, title="时间片引用", description="inspect_meteorological_dataset 产出的时间片 valueRef。", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层", description="要渲染的高度层序号。", json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", description="inspect_meteorological_dataset 产出的 level valueRef。", json_schema_extra={"x-ui-source": "text"})
    area_ref: str | None = Field(None, title="分析区域引用", description="define_analysis_area 产出的 area_ref。", json_schema_extra={"x-ui-source": "collection"})
    bbox_ref: str | None = Field(None, title="范围引用", description="bbox valueRef。", json_schema_extra={"x-ui-source": "text"})
    bbox: list[float] | None = Field(None, title="范围 bbox", description="[west,south,east,north]。", json_schema_extra={"x-ui-source": "json"})
    result_name: str | None = Field(None, title="结果名称", description="生成图层的名称。", json_schema_extra={"x-ui-source": "text"})


class InterpretMeteorologicalDatasetArgs(ToolArgsModel):
    dataset_id: str | None = Field(None, title="气象数据集", description="单个数据集 ID。", json_schema_extra={"x-ui-source": "text"})
    dataset_ids: list[str] | None = Field(None, title="数据集列表", description="序列数据集 ID 列表，最多 36 个。", json_schema_extra={"x-ui-source": "json"})
    variables: list[str] | None = Field(None, title="变量列表", description="要解读的变量列表；为空时自动选择。", json_schema_extra={"x-ui-source": "json"})
    variable_refs: list[str] | None = Field(None, title="变量引用", description="inspect_meteorological_dataset 产出的变量 valueRef 列表。", json_schema_extra={"x-ui-source": "json"})
    focus: str | None = Field(None, title="解读焦点", description="例如 降雨、温度、风力。", json_schema_extra={"x-ui-source": "text"})
    max_datasets: int = Field(6, title="数据集上限", description="序列解读最多使用的数据集数。", ge=1, le=36, json_schema_extra={"x-ui-source": "number"})


class MeteorologicalStatsArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="需要统计的数据集 ID。", json_schema_extra={"x-ui-source": "text"})
    variable_ref: str | None = Field(None, title="变量引用", description="inspect_meteorological_dataset 产出的变量 valueRef。", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量名", description="要统计的变量名。", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", description="inspect_meteorological_dataset 产出的时间片 valueRef。", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间片", description="要统计的时间片序号。", json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", description="inspect_meteorological_dataset 产出的 level valueRef。", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层", description="要统计的高度层序号。", json_schema_extra={"x-ui-source": "number"})
    bbox_ref: str | None = Field(None, title="范围引用", description="bbox valueRef。", json_schema_extra={"x-ui-source": "text"})
    bbox: list[float] | None = Field(None, title="范围 bbox", description="[west,south,east,north]。", json_schema_extra={"x-ui-source": "json"})
    area_ref: str | None = Field(None, title="分析区域引用", description="define_analysis_area 产出的 area_ref。", json_schema_extra={"x-ui-source": "collection"})


class MeteorologicalThresholdArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="需要阈值处理的数据集 ID。", json_schema_extra={"x-ui-source": "text"})
    variable_ref: str | None = Field(None, title="变量引用", description="变量 valueRef。", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量名", description="变量名。", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", description="时间片 valueRef。", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间片", description="时间片序号。", json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", description="inspect_meteorological_dataset 产出的 level valueRef。", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层", description="要统计的高度层序号。", json_schema_extra={"x-ui-source": "number"})
    threshold: float | None = Field(None, title="阈值", description="分析阈值。", json_schema_extra={"x-ui-source": "number"})
    threshold_ref: str | None = Field(None, title="阈值引用", description="statistic valueRef。", json_schema_extra={"x-ui-source": "text"})
    operator: str = Field(">=", title="比较运算符", description=">=, >, <=, <, ==", json_schema_extra={"x-ui-source": "text"})
    bbox_ref: str | None = Field(None, title="范围引用", description="bbox valueRef。", json_schema_extra={"x-ui-source": "text"})
    bbox: list[float] | None = Field(None, title="范围 bbox", description="[west,south,east,north]。", json_schema_extra={"x-ui-source": "json"})
    area_ref: str | None = Field(None, title="分析区域引用", description="define_analysis_area 产出的 area_ref。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})
    result_name: str | None = Field(None, title="结果名称", description="结果图层名称。", json_schema_extra={"x-ui-source": "text"})


class MeteorologicalContoursArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="需要等值线处理的数据集 ID。", json_schema_extra={"x-ui-source": "text"})
    variable_ref: str | None = Field(None, title="变量引用", description="变量 valueRef。", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量名", description="变量名。", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", description="时间片 valueRef。", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间片", description="时间片序号。", json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", description="inspect_meteorological_dataset 产出的 level valueRef。", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层", description="要统计的高度层序号。", json_schema_extra={"x-ui-source": "number"})
    levels: list[float] | None = Field(None, title="等值线级别", description="等值线值列表。", json_schema_extra={"x-ui-source": "json"})
    area_ref: str | None = Field(None, title="分析区域引用", description="define_analysis_area 产出的 area_ref。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})
    result_name: str | None = Field(None, title="结果名称", description="结果图层名称。", json_schema_extra={"x-ui-source": "text"})


class GenerateMeteorologicalReportArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="数据集 ID。", json_schema_extra={"x-ui-source": "text"})
    interpretation_ref: str = Field(..., title="解读引用", description="interpret_meteorological_dataset 产出的 llm_interpretation valueRef。", json_schema_extra={"x-ui-source": "text"})
    result_name: str | None = Field(None, title="报告名称", description="报告文件名。", json_schema_extra={"x-ui-source": "text"})


class ListMeteorologicalDatasetsArgs(ToolArgsModel):
    """无参数工具的空 args model，满足 Provider 校验契约。"""

# ── Handlers ──────────────────────────────────────────────────────────────

async def list_meteorological_datasets(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    datasets = runtime.store.platform_store.list_weather_datasets(
        session_id=runtime.context.session_id,
        thread_id=runtime.context.thread_id,
    )
    return ToolExecutionResult(
        message=f"当前线程可用气象数据集 {len(datasets)} 个。" if datasets else "当前线程没有气象数据集。",
        payload={"datasets": [_dataset_summary(item) for item in datasets]},
        source="weather_catalog",
        feature_count=len(datasets),
    )


async def inspect_meteorological_dataset(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
    refs = _register_meteorological_dataset_refs(runtime, dataset)
    return ToolExecutionResult(
        message=f"已检查 {dataset.filename}，可用变量 {len(_extract_meteorological_variables(dataset.metadata))} 个。",
        payload={"dataset": _dataset_summary(dataset), "valueRefs": serialize_value_refs_for_model(refs)},
        source="weather_inspect",
        value_refs=refs,
    )


async def render_meteorological_raster(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    map_candidate_ref = str(args.get("map_candidate_ref") or "").strip()
    variable, time_index, level_index = None, None, None
    dataset_id = str(args.get("dataset_id") or "")
    candidate = None

    if map_candidate_ref:
        candidate = resolve_value_ref(runtime, map_candidate_ref, expected_kinds={"meteorological_map_candidate", "nowcast_map_candidate"}).value
        dataset_id = str(candidate.get("datasetId") or dataset_id)
        variable = str(candidate.get("variable") or "")
        time_index = int(candidate.get("timeIndex") or 0) if candidate.get("timeIndex") is not None else None

    if not dataset_id:
        raise ValueError("render_meteorological_raster 需要 dataset_id 或 map_candidate_ref。")
    dataset = _ensure_weather_dataset_parsed(runtime, dataset_id)
    if variable is None:
        variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
    time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref") if time_index is None or not candidate else time_index
    level_index = _resolve_optional_int_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref") if level_index is None else level_index

    area = _resolve_optional_area(runtime, args)
    bbox_ref = str(args.get("bbox_ref") or "").strip()
    if bbox_ref:
        bbox = [float(item) for item in resolve_value_ref(runtime, bbox_ref, expected_kinds={"bbox"}).value]
    else:
        bbox = [float(item) for item in args["bbox"]] if args.get("bbox") else None

    artifact_id = make_id("artifact")
    output_dir = runtime.store.runtime_root / "weather" / "render" / runtime.context.run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{artifact_id}.png"
    render_result = _weather_service(runtime).render_heatmap(
        _weather_dataset_path(runtime, dataset.storage_relative_path),
        output_path=output_path,
        variable=variable,
        time_index=time_index,
        level_index=level_index,
        area=area,
        bbox=bbox,
    )
    artifact = runtime.store.platform_store.save_file_artifact(
        run_id=runtime.context.run_id,
        artifact_id=artifact_id,
        artifact_type="raster_png",
        name=str(args.get("result_name") or f"{dataset.filename} {variable or 'render'}"),
        source_path=str(output_path),
        suffix=".png",
        metadata={"source": "weather", "datasetId": dataset.dataset_id, "variable": variable, "imageUrl": f"/api/v1/results/{artifact_id}/file", **render_result},
    )
    return ToolExecutionResult(
        message=f"已生成气象图层：{artifact.name}。",
        artifact=artifact,
        payload=render_result,
        source="weather_render",
        provenance={"operation": "render_meteorological_raster", "datasetId": dataset.dataset_id},
        geometry_type="Raster",
        feature_count=1,
    )


async def interpret_meteorological_dataset(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    datasets = _resolve_interpretation_datasets(runtime, args)
    requested_variables = _resolve_interpretation_variables(runtime, args)
    stats_rows = _collect_interpretation_stats(runtime, datasets=datasets, requested_variables=requested_variables)
    facts_datasets = [
        _dataset_to_interpretation_facts(dataset, sequence_index=sequence_index, requested_variables=requested_variables)
        for sequence_index, dataset in enumerate(datasets)
    ]
    map_candidates = build_map_candidates(datasets=facts_datasets, stats_rows=stats_rows, max_candidates=12)
    facts = build_interpretation_facts(datasets=facts_datasets, stats_rows=stats_rows, map_candidates=map_candidates, focus=str(args.get("focus") or "").strip() or None)
    interpretation = await _call_meteorological_interpretation_model(runtime, facts)
    value_refs = _register_meteorological_interpretation_refs(runtime, datasets=datasets, interpretation=interpretation, map_candidates=map_candidates)
    map_message = f"已生成 {len(map_candidates)} 个可选地图候选。" if map_candidates else "该数据当前没有可地图展示的候选。"
    return ToolExecutionResult(
        message=f"已完成 NC 气象数据解读。{map_message}",
        payload={"interpretation": interpretation, "mapCandidates": map_candidates, "datasetCount": len(datasets), "valueRefs": serialize_value_refs_for_model(value_refs)},
        source="weather_interpretation",
        provenance={"operation": "interpret_meteorological_dataset", "datasetIds": [d.dataset_id for d in datasets]},
        feature_count=len(map_candidates),
        value_refs=value_refs,
    )


async def meteorological_stats(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
    variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
    time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
    level_index = _resolve_optional_int_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref")
    bbox = _resolve_optional_bbox_value_arg(runtime, args)
    area = _resolve_optional_area(runtime, args)
    stats = _weather_service(runtime).stats(_weather_dataset_path(runtime, dataset.storage_relative_path), variable=variable, time_index=time_index, level_index=level_index, bbox=bbox, area=area)
    refs = _register_meteorological_stats_refs(runtime, dataset=dataset, variable=variable, stats=stats)
    return ToolExecutionResult(
        message=f"已完成 {dataset.filename} / {variable} 统计。",
        payload={"stats": stats, "valueRefs": serialize_value_refs_for_model(refs)},
        source="weather_stats",
        provenance={"operation": "meteorological_stats", "datasetId": dataset.dataset_id, "variable": variable},
        value_refs=refs,
    )


async def meteorological_threshold_area(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    from .registry import _persist_collection, _result_with_collection_metadata
    dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
    variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
    time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
    level_index = _resolve_optional_int_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref")
    threshold = resolve_numeric_arg(runtime, args, value_key="threshold", ref_key="threshold_ref")
    collection = _weather_service(runtime).threshold_geojson(
        _weather_dataset_path(runtime, dataset.storage_relative_path),
        threshold=float(threshold),
        operator=str(args.get("operator") or ">="),
        variable=variable,
        time_index=time_index,
        level_index=level_index,
    )
    artifact = await _persist_collection(runtime, alias=args.get("alias", "meteorological_threshold"), name=str(args.get("result_name") or f"{dataset.filename} 阈值区"), collection=collection, is_intermediate=True)
    metadata_patch = {"datasetId": dataset.dataset_id, "source": "meteorological_dataset", "operation": "threshold", "threshold": float(threshold), "thresholdRef": args.get("threshold_ref"), "operator": str(args.get("operator") or ">="), "variable": variable, "timeIndex": time_index}
    if hasattr(runtime.store.platform_store, "update_artifact_metadata"):
        artifact = runtime.store.platform_store.update_artifact_metadata(artifact.artifact_id, **metadata_patch)
    else:
        artifact = artifact.model_copy(update={"metadata": {**artifact.metadata, **metadata_patch}})
    return ToolExecutionResult(
        message=f"已生成气象阈值区，共 {len(collection.get('features', []))} 个要素。",
        artifact=artifact,
        collection=collection,
        source="meteorological_dataset",
        used_query=dataset.dataset_id,
        provenance={"datasetId": dataset.dataset_id, "operation": "threshold"},
    )


async def meteorological_contours(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    from .registry import _persist_collection
    dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
    variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
    time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
    collection = _weather_service(runtime).contours_geojson(_weather_dataset_path(runtime, dataset.storage_relative_path), levels=args.get("levels"), variable=variable, time_index=time_index)
    artifact = await _persist_collection(runtime, alias=args.get("alias", "meteorological_contours"), name=str(args.get("result_name") or f"{dataset.filename} 等值线"), collection=collection, is_intermediate=True)
    metadata_patch = {"datasetId": dataset.dataset_id, "source": "meteorological_dataset", "operation": "contours", "levels": args.get("levels") or []}
    if hasattr(runtime.store.platform_store, "update_artifact_metadata"):
        artifact = runtime.store.platform_store.update_artifact_metadata(artifact.artifact_id, **metadata_patch)
    else:
        artifact = artifact.model_copy(update={"metadata": {**artifact.metadata, **metadata_patch}})
    return ToolExecutionResult(
        message=f"已生成气象等值线，共 {len(collection.get('features', []))} 个要素。",
        artifact=artifact,
        collection=collection,
        source="meteorological_dataset",
        used_query=dataset.dataset_id,
        provenance={"datasetId": dataset.dataset_id, "operation": "contours"},
    )


async def generate_meteorological_report(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
    interpretation_text = ""
    if str(args.get("interpretation_ref") or "").strip():
        interpretation_text = str(resolve_value_ref(runtime, str(args["interpretation_ref"]), expected_kinds={"llm_interpretation"}).value)
    artifact_id = make_id("artifact")
    output_dir = runtime.store.runtime_root / "weather" / "reports" / runtime.context.run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{artifact_id}.docx"
    report = write_weather_report_docx(
        output_path=output_path,
        dataset_id=dataset.dataset_id,
        filename=dataset.filename,
        metadata=dataset.metadata,
        stats_rows=[],
        llm_interpretation=interpretation_text,
        generated_at=dataset.updated_at.isoformat() if hasattr(dataset, 'updated_at') else None,
    )
    artifact = runtime.store.platform_store.save_file_artifact(
        run_id=runtime.context.run_id,
        artifact_id=artifact_id,
        artifact_type="report_docx",
        name=str(args.get("result_name") or f"{dataset.filename} 报告"),
        source_path=str(output_path),
        suffix=".docx",
        metadata={"source": "weather_report", "datasetId": dataset.dataset_id},
    )
    return ToolExecutionResult(
        message=f"已生成气象解读报告：{artifact.name}。",
        artifact=artifact,
        payload=report,
        source="weather_report",
        provenance={"operation": "generate_meteorological_report", "datasetId": dataset.dataset_id},
    )

# ── Provider ──────────────────────────────────────────────────────────────

class WeatherToolProvider:
    @property
    def manifest(self) -> ToolManifest:
        return ToolManifest(
            provider_id="builtin.weather",
            name="气象数据工具",
            version="0.1.0",
            owner="Geo Agent Platform",
            description="气象数据检查、渲染、统计、阈值、等值线、解读和报告工具。",
            permissions=[],
        )

    def list_definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition("list_meteorological_datasets", list_meteorological_datasets, ToolMetadata("列出气象数据集", "列出当前线程可用的 NC/GRIB/GeoTIFF/HDF5/雷达气象数据集。", "meteorology", ["气象", "catalog"]), ListMeteorologicalDatasetsArgs),
            ToolDefinition("inspect_meteorological_dataset", inspect_meteorological_dataset, ToolMetadata("检查气象数据集", "读取气象数据集的变量、维度、时间/高度层和地理范围，并登记 variable/bbox/time/level valueRef。", "meteorology", ["气象", "inspect"]), InspectMeteorologicalDatasetArgs),
            ToolDefinition("render_meteorological_raster", render_meteorological_raster, ToolMetadata("渲染气象图层", "把气象变量渲染成可叠加地图的 raster_png 图层。支持按 area、bbox、时间片和高度层裁剪。", "visualization", ["气象", "render", "raster"]), RenderMeteorologicalRasterArgs),
            ToolDefinition("interpret_meteorological_dataset", interpret_meteorological_dataset, ToolMetadata("解读气象数据", "用大模型解读气象数据集或序列，生成 interpretations_ref 和地图候选引用。", "meteorology", ["气象", "interpret", "llm"]), InterpretMeteorologicalDatasetArgs),
            ToolDefinition("meteorological_stats", meteorological_stats, ToolMetadata("气象统计", "统计气象变量在指定范围或时间片上的 count/min/max/mean/median/p90。", "meteorology", ["气象", "stats"]), MeteorologicalStatsArgs),
            ToolDefinition("meteorological_threshold_area", meteorological_threshold_area, ToolMetadata("气象阈值区域", "筛选气象变量满足阈值条件的网格区域，输出 GeoJSON 要素集合。", "meteorology", ["气象", "threshold", "geojson"]), MeteorologicalThresholdArgs),
            ToolDefinition("meteorological_contours", meteorological_contours, ToolMetadata("气象等值线", "生成气象变量的等值线 GeoJSON。", "meteorology", ["气象", "contour", "geojson"]), MeteorologicalContoursArgs),
            ToolDefinition("generate_meteorological_report", generate_meteorological_report, ToolMetadata("生成气象报告", "基于解读结果和统计生成 .docx 格式气象报告文件。", "output", ["气象", "report", "docx"]), GenerateMeteorologicalReportArgs),
        ]


weather_provider = WeatherToolProvider()

# ── Helpers ───────────────────────────────────────────────────────────────

def _weather_service(runtime: ToolRuntime):
    return runtime.store.weather_service or WeatherDataService()


def _weather_dataset_path(runtime: ToolRuntime, relative_path: str) -> Path:
    resolver = getattr(runtime.store.platform_store, "resolve_runtime_path", None)
    if callable(resolver):
        return resolver(relative_path)
    return (runtime.store.runtime_root / relative_path).resolve()


def _ensure_weather_dataset_parsed(runtime: ToolRuntime, dataset_id: str):
    method = getattr(runtime.store.platform_store, "ensure_weather_dataset_parsed", None)
    if callable(method):
        return method(dataset_id, _weather_service(runtime))
    dataset = runtime.store.platform_store.get_weather_dataset(dataset_id)
    if getattr(dataset, "status", "completed") != "completed":
        raise ValueError(f"气象数据集尚未解析完成：{dataset_id}")
    return dataset


def _dataset_summary(dataset: Any) -> dict[str, Any]:
    return {
        "datasetId": dataset.dataset_id,
        "filename": dataset.filename,
        "status": dataset.status,
        "createdAt": dataset.created_at.isoformat() if hasattr(dataset, 'created_at') else None,
        "variableCount": len(_extract_meteorological_variables(dataset.metadata)) if hasattr(dataset, 'metadata') else 0,
    }


def _resolve_tool_value_arg(runtime: ToolRuntime, args: dict[str, Any], *, value_key: str, ref_key: str, expected_kinds: set[str]) -> Any:
    ref = str(args.get(ref_key) or "").strip()
    if ref:
        return resolve_value_ref(runtime, ref, expected_kinds=expected_kinds).value
    val = args.get(value_key)
    if val is not None:
        return val
    raise ValueError(f"气象工具参数缺失：需要 {value_key} 或 {ref_key}。")


def _resolve_optional_int_value_arg(runtime: ToolRuntime, args: dict[str, Any], *, value_key: str, ref_key: str) -> int | None:
    ref = str(args.get(ref_key) or "").strip()
    if ref:
        return int(resolve_value_ref(runtime, ref, expected_kinds={"time_index", "level_index"}).value)
    val = args.get(value_key)
    return int(val) if val is not None else None


def _resolve_optional_bbox_value_arg(runtime: ToolRuntime, args: dict[str, Any]) -> list[float] | None:
    ref = str(args.get("bbox_ref") or "").strip()
    if ref:
        return [float(item) for item in resolve_value_ref(runtime, ref, expected_kinds={"bbox"}).value]
    bbox = args.get("bbox")
    return [float(item) for item in bbox] if bbox else None


def _resolve_optional_area(runtime: ToolRuntime, args: dict[str, Any]) -> dict[str, Any] | None:
    area_ref = str(args.get("area_ref") or "").strip()
    if not area_ref:
        return None
    if area_ref in runtime.state.alias_map:
        return runtime.state.alias_map[area_ref]
    getter = getattr(runtime.store.platform_store, "get_artifact_collection", None)
    if callable(getter):
        return getter(area_ref)
    raise ValueError(f"分析区域引用不存在：{area_ref}")


def _resolve_interpretation_datasets(runtime: ToolRuntime, args: dict[str, Any]) -> list[Any]:
    ids = args.get("dataset_ids") or ([args["dataset_id"]] if args.get("dataset_id") else None)
    if not ids:
        datasets = runtime.store.platform_store.list_weather_datasets(session_id=runtime.context.session_id, thread_id=runtime.context.thread_id)
        ids = [item.dataset_id for item in datasets]
    max_count = int(args.get("max_datasets") or 6)
    datasets = [_ensure_weather_dataset_parsed(runtime, str(dataset_id)) for dataset_id in ids[:max_count]]
    if not datasets:
        raise ValueError("当前线程没有可解读的气象数据集。")
    return datasets


def _resolve_interpretation_variables(runtime: ToolRuntime, args: dict[str, Any]) -> list[str] | None:
    variable_refs = args.get("variable_refs")
    if variable_refs:
        return [str(resolve_value_ref(runtime, ref, expected_kinds={"variable"}).value) for ref in variable_refs]
    requested = args.get("variables")
    if requested:
        return [str(item) for item in requested]
    return None


def _collect_interpretation_stats(runtime: ToolRuntime, *, datasets: list[Any], requested_variables: list[str] | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    max_vars = min(len(requested_variables) if requested_variables else 6, 4)
    for dataset in datasets:
        variables = select_interpretation_variables(dataset.metadata, requested=requested_variables, max_variables=max_vars)
        for var in variables:
            try:
                stats = _weather_service(runtime).stats(_weather_dataset_path(runtime, dataset.storage_relative_path), variable=var)
                rows.append({**stats, "dataset_id": dataset.dataset_id, "filename": dataset.filename})
            except Exception:
                continue
    return rows


def _dataset_to_interpretation_facts(dataset: Any, *, sequence_index: int = 0, requested_variables: list[str] | None = None) -> dict[str, Any]:
    variables = select_interpretation_variables(dataset.metadata, requested=requested_variables, max_variables=6)
    return {
        "datasetId": dataset.dataset_id,
        "filename": dataset.filename,
        "sequenceIndex": sequence_index,
        "variables": variables,
        "metadata": dataset.metadata,
        "createdAt": dataset.created_at.isoformat() if hasattr(dataset, 'created_at') else None,
    }


async def _call_meteorological_interpretation_model(runtime: ToolRuntime, facts: dict[str, Any]) -> dict[str, Any]:
    model_registry = runtime.store.model_registry
    if model_registry is None:
        raise ValueError("当前工具运行时没有模型注册表，无法生成 NC 大模型解读。")
    adapter = model_registry.resolve_provider(runtime.context.model_provider)
    if not adapter.is_configured():
        raise ValueError(f"模型 provider '{adapter.provider}' 尚未配置，无法生成 NC 大模型解读。")
    payload = await adapter.structured(
        build_interpretation_prompt(facts),
        schema=INTERPRETATION_SCHEMA,
        model=runtime.context.model_name or adapter.default_model,
        temperature=0.1,
        request_timeout=120,
    )
    return normalize_interpretation_payload(payload)


def _register_meteorological_dataset_refs(runtime: ToolRuntime, dataset: Any) -> list[Any]:
    store = ToolValueStore(runtime, source_tool="inspect_meteorological_dataset")
    refs: list[Any] = [
        store.put(kind="variable", label=str(var["name"]), value=str(var["name"]), unit=str(var.get("units") or ""), ref_id=make_value_ref_id("variable", dataset.dataset_id, var["name"]), metadata={"dataset_id": dataset.dataset_id, "long_name": str(var.get("long_name") or var["name"])})
        for var in _extract_meteorological_variables(dataset.metadata)
    ]
    bbox = _extract_meteorological_bbox(dataset.metadata)
    if bbox:
        refs.append(store.put(kind="bbox", label="数据地理范围", value=bbox, ref_id=make_value_ref_id("bbox", dataset.dataset_id), metadata={"dataset_id": dataset.dataset_id}))
    for ti in _extract_meteorological_time_indices(dataset.metadata):
        refs.append(store.put(kind="time_index", label=str(ti["label"]), value=ti["index"], ref_id=make_value_ref_id("time", dataset.dataset_id, str(ti["index"])), metadata={"dataset_id": dataset.dataset_id, "value": ti.get("value")}))
    for li in _extract_meteorological_level_indices(dataset.metadata):
        refs.append(store.put(kind="level_index", label=str(li["label"]), value=li["index"], ref_id=make_value_ref_id("level", dataset.dataset_id, str(li["index"])), metadata={"dataset_id": dataset.dataset_id, "value": li.get("value")}))
    return refs


def _register_meteorological_stats_refs(runtime: ToolRuntime, *, dataset: Any, variable: str, stats: dict[str, Any]) -> list[Any]:
    store = ToolValueStore(runtime, source_tool="meteorological_stats")
    return [
        store.put(kind="statistic", label=f"{variable} {key}", value=float(val), unit=stats.get("unit"), ref_id=make_value_ref_id("statistic", dataset.dataset_id, variable, key), metadata={"dataset_id": dataset.dataset_id, "variable": variable, "statistic": key})
        for key, val in stats.items()
        if key in {"count", "min", "max", "mean", "median", "p50", "p90"} and isinstance(val, (int, float))
    ]


def _register_meteorological_interpretation_refs(runtime: ToolRuntime, *, datasets: list[Any], interpretation: dict[str, Any], map_candidates: list[dict[str, Any]]) -> list[Any]:
    store = ToolValueStore(runtime, source_tool="interpret_meteorological_dataset")
    refs: list[Any] = [
        store.put(kind="llm_interpretation", label=f"气象解读 / {datasets[0].filename}", value=interpretation["reportText"], ref_id=make_value_ref_id("interpretation", datasets[0].dataset_id if len(datasets) == 1 else "sequence"), metadata={"variableCount": len(interpretation.get("keyFindings", []))})
    ]
    for candidate in map_candidates:
        refs.append(store.put(kind="meteorological_map_candidate", label=str(candidate["label"]), value=candidate, ref_id=make_value_ref_id("meteorological_map_candidate", candidate.get("datasetId", ""), candidate.get("variable", ""), candidate.get("reason", ""))))
    return refs


def _extract_meteorological_variables(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    variables = metadata.get("variables") or []
    if isinstance(variables, list):
        return [{"name": v.get("name") or v.get("variable") or "", "units": v.get("units") or v.get("unit") or "", "long_name": v.get("long_name") or v.get("longName") or ""} for v in variables]
    if isinstance(variables, dict):
        return [{"name": k, "units": "", "long_name": ""} for k in variables.keys()]
    return []


def _extract_meteorological_bbox(metadata: dict[str, Any]) -> list[float] | None:
    bounds = metadata.get("bounds")
    if isinstance(bounds, dict):
        return [float(bounds[k]) for k in ("west", "south", "east", "north") if k in bounds]
    if isinstance(bounds, list) and len(bounds) == 4:
        return [float(item) for item in bounds]
    return None


def _extract_meteorological_time_indices(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    times = metadata.get("times") or []
    if isinstance(times, list):
        return [{"index": i, "label": str(t.get("value") or f"T{i}"), "value": str(t.get("value") or "")} for i, t in enumerate(times)]
    return []


def _extract_meteorological_level_indices(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    levels = metadata.get("levels") or []
    if isinstance(levels, list):
        return [{"index": i, "label": str(l.get("value") or f"L{i}"), "value": str(l.get("value") or "")} for i, l in enumerate(levels)]
    return []
