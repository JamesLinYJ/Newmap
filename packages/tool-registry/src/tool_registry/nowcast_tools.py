# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临降水工具 Provider
#
#   文件:       nowcast_tools.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 将短临降水领域服务接入标准 ToolProvider。handler 只做 runtime 适配、
# valueRef 解析、artifact 持久化，不承载降水算法本身。

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import Field

from gis_common.ids import make_id
from shared_types.exceptions import NotFoundError
from gis_weather import (
    NOWCAST_ANSWER_SCHEMA,
    NowcastAnalysisService,
    NowcastProductProfile,
    NowcastSequenceService,
    NowcastTextService,
    WeatherDataService,
)

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime
from .providers import ToolManifest
from .registry import ToolDefinition, ToolMetadata
from .value_refs import ToolValueStore, make_value_ref_id, resolve_coordinate_arg, resolve_value_ref, serialize_value_refs_for_model


class CreateNowcastSequenceArgs(ToolArgsModel):
    dataset_set_ref: str | None = Field(None, title="气象数据集集合引用", description="list_meteorological_datasets 产出的 weather_dataset_set valueRef；优先用它或留空使用当前线程全部数据集，避免手抄长 dataset id 列表。", json_schema_extra={"x-ui-source": "text"})
    dataset_ids: list[str] | None = Field(None, title="气象数据集列表", description="确实只需子集时才填写 NC dataset id 列表；当前线程全部数据集请留空或使用 dataset_set_ref。", json_schema_extra={"x-ui-source": "json"})
    profile_id: str | None = Field(None, title="产品 Profile", description="短临产品变量口径配置 ID；默认适配 QPF/dbz/thunder/u/v/kdp。", json_schema_extra={"x-ui-source": "text"})


class InspectNowcastSequenceArgs(ToolArgsModel):
    sequence_ref: str = Field(..., title="短临序列引用", description="create_nowcast_sequence 产出的 sequence valueRef。", json_schema_extra={"x-ui-source": "text"})


class AnalyzeNowcastPrecipitationArgs(ToolArgsModel):
    sequence_ref: str = Field(..., title="短临序列引用", description="create_nowcast_sequence 产出的 sequence valueRef。", json_schema_extra={"x-ui-source": "text"})
    area_ref: str | None = Field(None, title="分析区域引用", description="define_analysis_area 或边界工具产出的 area_ref/collectionRef。", json_schema_extra={"x-ui-source": "collection"})
    district_layer_key: str | None = Field(None, title="区划图层", description="可选区划图层 key；用于区县级预报。", json_schema_extra={"x-ui-source": "layer"})
    district_name_field: str | None = Field(None, title="区划名称字段", description="区县名称字段；不填时自动识别常见字段，歧义则失败。", json_schema_extra={"x-ui-source": "text"})
    coordinate_ref: str | None = Field(None, title="地点坐标引用", description="geocode_place 产出的坐标 valueRef。", json_schema_extra={"x-ui-source": "text"})
    latitude: float | None = Field(None, title="纬度", description="用户原始输入坐标纬度；工具派生坐标应使用 coordinate_ref。", json_schema_extra={"x-ui-source": "number"})
    longitude: float | None = Field(None, title="经度", description="用户原始输入坐标经度；工具派生坐标应使用 coordinate_ref。", json_schema_extra={"x-ui-source": "number"})
    point_buffer_meters: float = Field(1000, title="地点缓冲半径", description="地点问答的空间统计半径，单位米。", ge=100, le=10000, json_schema_extra={"x-ui-source": "number"})
    bbox_ref: str | None = Field(None, title="范围引用", description="bbox valueRef。", json_schema_extra={"x-ui-source": "text"})
    bbox: list[float] | None = Field(None, title="范围 bbox", description="[west,south,east,north]，仅用户原始输入或调试使用。", json_schema_extra={"x-ui-source": "json"})


class AnswerNowcastQuestionArgs(ToolArgsModel):
    nowcast_analysis_ref: str = Field(..., title="短临分析引用", description="analyze_nowcast_precipitation 产出的分析 valueRef。", json_schema_extra={"x-ui-source": "text"})
    question: str = Field(..., title="用户问题", description="例如：接下来天气怎么样？市民中心天气怎么样？", json_schema_extra={"x-ui-source": "text"})


class GenerateNowcastForecastTextArgs(ToolArgsModel):
    nowcast_analysis_ref: str = Field(..., title="短临分析引用", description="analyze_nowcast_precipitation 产出的分析 valueRef。", json_schema_extra={"x-ui-source": "text"})
    style: str = Field("public", title="文本风格", description="public / professional / broadcast。", json_schema_extra={"x-ui-source": "text"})


class RenderNowcastRasterArgs(ToolArgsModel):
    nowcast_map_candidate_ref: str = Field(..., title="短临地图候选引用", description="analyze_nowcast_precipitation 产出的地图候选 valueRef。", json_schema_extra={"x-ui-source": "text"})
    area_ref: str | None = Field(None, title="分析区域引用", description="可选 AOI，用于透明遮罩。", json_schema_extra={"x-ui-source": "collection"})
    result_name: str | None = Field(None, title="结果名称", description="生成地图图层的名称。", json_schema_extra={"x-ui-source": "text"})


async def create_nowcast_sequence(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    datasets = _resolve_weather_datasets(runtime, args.get("dataset_ids"), dataset_set_ref=args.get("dataset_set_ref"))
    service = NowcastSequenceService()
    sequence = service.create_sequence(
        sequence_id=make_id("nowcast_sequence"),
        datasets=[_dataset_to_sequence_input(runtime, dataset) for dataset in datasets],
        profile=NowcastProductProfile(profile_id=str(args.get("profile_id") or "default_qpf_radar")),
    )
    ref = ToolValueStore(runtime, source_tool="create_nowcast_sequence").put(
        kind="nowcast_sequence",
        label=f"短临序列（{len(sequence.datasets)} 时次）",
        value=sequence.to_payload(),
        ref_id=make_value_ref_id("nowcast_sequence", sequence.sequence_id),
        metadata={
            "datasetCount": len(sequence.datasets),
            "variable": sequence.variable,
            "issueTime": sequence.issue_time.isoformat() if sequence.issue_time else None,
        },
    )
    return ToolExecutionResult(
        message=f"已创建短临序列，共 {len(sequence.datasets)} 个时次。",
        payload={"sequence": service.inspect_sequence(sequence), "sequenceRef": ref.ref_id, "valueRefs": serialize_value_refs_for_model([ref])},
        source="nowcast_sequence",
        provenance={"operation": "create_nowcast_sequence", "datasetIds": [item.dataset_id for item in sequence.datasets]},
        feature_count=len(sequence.datasets),
        value_refs=[ref],
    )


async def inspect_nowcast_sequence(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    sequence = _resolve_sequence(runtime, args["sequence_ref"])
    payload = NowcastSequenceService().inspect_sequence(sequence)
    return ToolExecutionResult(
        message=f"短临序列可用：{payload['datasetCount']} 个时次，主降水变量 {payload['variable']}。",
        payload=payload,
        source="nowcast_sequence",
        provenance={"operation": "inspect_nowcast_sequence", "sequenceId": sequence.sequence_id},
        feature_count=payload["datasetCount"],
    )


async def analyze_nowcast_precipitation(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    sequence = _resolve_sequence(runtime, args["sequence_ref"])
    args = _apply_default_district_args(args, runtime)
    area = _resolve_optional_area(runtime, args)
    bbox = _resolve_optional_bbox(runtime, args)
    coordinate = _resolve_optional_coordinate(runtime, args)
    facts = NowcastAnalysisService().analyze(
        sequence,
        area=area,
        bbox=bbox,
        coordinate=coordinate,
        point_buffer_meters=float(args.get("point_buffer_meters") or 1000),
        district_name_field=args.get("district_name_field"),
    )
    values = ToolValueStore(runtime, source_tool="analyze_nowcast_precipitation")
    analysis_ref = values.put(
        kind="nowcast_analysis",
        label="短临降水分析事实",
        value=facts,
        ref_id=make_value_ref_id("nowcast_analysis", sequence.sequence_id, facts.get("scope", {}).get("type")),
        metadata={"sequenceId": sequence.sequence_id, "regionCount": len(facts.get("regions") or [])},
    )
    candidate_refs = [
        values.put(
            kind="nowcast_map_candidate",
            label=str(candidate["label"]),
            value={**candidate, "sequence": sequence.to_payload()},
            ref_id=make_value_ref_id("nowcast_map_candidate", sequence.sequence_id, candidate.get("datasetId"), candidate.get("variable"), candidate.get("reason")),
            metadata={"reason": candidate.get("reason"), "datasetId": candidate.get("datasetId"), "variable": candidate.get("variable")},
        )
        for candidate in facts.get("mapCandidates", [])
    ]
    all_refs = [analysis_ref, *candidate_refs]
    return ToolExecutionResult(
        message=f"已完成短临降水分析，生成 {len(candidate_refs)} 个地图候选。",
        payload={"facts": facts, "nowcastAnalysisRef": analysis_ref.ref_id, "valueRefs": serialize_value_refs_for_model(all_refs)},
        source="nowcast_analysis",
        provenance={"operation": "analyze_nowcast_precipitation", "sequenceId": sequence.sequence_id},
        feature_count=len(facts.get("regions") or []),
        value_refs=all_refs,
    )


async def answer_nowcast_question(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    facts = _resolve_analysis(runtime, args["nowcast_analysis_ref"])
    text_service = NowcastTextService()
    draft = text_service.build_draft_answer(facts=facts, question=str(args["question"]))
    answer = await _call_nowcast_text_model(runtime, facts=facts, question=str(args["question"]), draft=draft)
    values = ToolValueStore(runtime, source_tool="answer_nowcast_question")
    forecast_ref = values.put(
        kind="forecast_text",
        label="短临问答文本",
        value=answer["answer"],
        ref_id=make_value_ref_id("forecast_text", args["nowcast_analysis_ref"], args["question"]),
        metadata={"confidence": answer["confidence"], "question": args["question"]},
    )
    return ToolExecutionResult(
        message=answer["answer"],
        payload={"answer": answer, "forecastTextRef": forecast_ref.ref_id, "valueRefs": serialize_value_refs_for_model([forecast_ref])},
        warnings=answer.get("warnings", []),
        source="nowcast_answer",
        provenance={"operation": "answer_nowcast_question", "analysisRef": args["nowcast_analysis_ref"]},
        value_refs=[forecast_ref],
    )


async def generate_nowcast_forecast_text(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    facts = _resolve_analysis(runtime, args["nowcast_analysis_ref"])
    text_service = NowcastTextService()
    draft = text_service.build_draft_answer(facts=facts, question="生成正式短临预报文字")
    answer = await _call_nowcast_text_model(runtime, facts=facts, question=f"生成{args.get('style') or 'public'}风格正式预报文字", draft=draft)
    ref = ToolValueStore(runtime, source_tool="generate_nowcast_forecast_text").put(
        kind="forecast_text",
        label="短临预报文字",
        value=answer["answer"],
        ref_id=make_value_ref_id("forecast_text", args["nowcast_analysis_ref"], args.get("style") or "public"),
        metadata={"style": args.get("style") or "public", "confidence": answer["confidence"]},
    )
    return ToolExecutionResult(
        message="已生成短临预报文字。",
        payload={"forecastText": answer["answer"], "forecastTextRef": ref.ref_id, "basis": answer["basis"], "valueRefs": serialize_value_refs_for_model([ref])},
        warnings=answer.get("warnings", []),
        source="nowcast_text",
        provenance={"operation": "generate_nowcast_forecast_text"},
        value_refs=[ref],
    )


async def render_nowcast_raster(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
    candidate = resolve_value_ref(runtime, str(args["nowcast_map_candidate_ref"]), expected_kinds={"nowcast_map_candidate"}).value
    sequence = NowcastSequenceService().sequence_from_payload(candidate["sequence"])
    dataset = next((item for item in sequence.datasets if item.dataset_id == candidate["datasetId"]), None)
    if dataset is None:
        raise ValueError(f"短临地图候选引用的数据集不存在：{candidate['datasetId']}")
    area = _resolve_optional_area(runtime, args)
    artifact_id = make_id("artifact")
    output_dir = runtime.store.runtime_root / "weather" / "nowcast" / sequence.sequence_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{artifact_id}.png"
    render_payload = _weather_service(runtime).render_heatmap(
        dataset.path,
        output_path=output_path,
        variable=str(candidate["variable"]),
        area=area,
    )
    artifact = runtime.store.platform_store.save_file_artifact(
        run_id=runtime.context.run_id,
        artifact_id=artifact_id,
        artifact_type="raster_png",
        name=str(args.get("result_name") or candidate.get("label") or "短临降水图"),
        source_path=str(output_path),
        suffix=".png",
        metadata={
            **render_payload,
            "source": "nowcast",
            "sequenceId": sequence.sequence_id,
            "datasetId": dataset.dataset_id,
            "mapCandidateRef": args["nowcast_map_candidate_ref"],
            "maskApplied": area is not None,
            "imageUrl": f"/api/v1/results/{artifact_id}/file",
        },
    )
    return ToolExecutionResult(
        message=f"已生成短临地图图层：{artifact.name}。",
        artifact=artifact,
        payload=render_payload,
        source="nowcast_map",
        provenance={"operation": "render_nowcast_raster", "sequenceId": sequence.sequence_id, "datasetId": dataset.dataset_id},
        geometry_type="Raster",
        feature_count=1,
    )


class NowcastToolProvider:
    @property
    def manifest(self) -> ToolManifest:
        return ToolManifest(
            provider_id="builtin.nowcast",
            name="短临降水工具",
            version="0.1.0",
            owner="Geo Agent Platform",
            description="短临 NC 序列、降水事实分析、问答和地图候选工具。",
            permissions=[],
        )

    def list_definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition("create_nowcast_sequence", create_nowcast_sequence, ToolMetadata("创建短临序列", "把当前线程、dataset_set_ref 或指定子集的 NC 气象数据集组成短临降水序列；当前线程全量数据不要手抄长 dataset id 列表。", "meteorology", ["nowcast", "sequence", "气象"]), CreateNowcastSequenceArgs),
            ToolDefinition("inspect_nowcast_sequence", inspect_nowcast_sequence, ToolMetadata("检查短临序列", "读取短临序列的时次、变量、范围和分析能力，确认是否可用于短临降水预报。", "meteorology", ["nowcast", "inspect", "气象"]), InspectNowcastSequenceArgs),
            ToolDefinition("analyze_nowcast_precipitation", analyze_nowcast_precipitation, ToolMetadata("分析短临降水", "基于短临序列和区划、AOI、bbox 或地点坐标生成降水时间线、趋势、移动方向和地图候选。", "meteorology", ["nowcast", "precipitation", "analysis"]), AnalyzeNowcastPrecipitationArgs),
            ToolDefinition("answer_nowcast_question", answer_nowcast_question, ToolMetadata("短临降水问答", "消费短临分析事实回答用户关于未来三小时、地点或区县降雨的问题，输出 forecast_text_ref。", "meteorology", ["nowcast", "qa", "forecast"]), AnswerNowcastQuestionArgs),
            ToolDefinition("render_nowcast_raster", render_nowcast_raster, ToolMetadata("渲染短临降水图", "消费短临地图候选引用生成可叠加地图的 raster_png artifact，不批量渲染全序列。", "meteorology", ["nowcast", "map", "raster"]), RenderNowcastRasterArgs),
        ]


provider = NowcastToolProvider()


def _resolve_weather_datasets(runtime: ToolRuntime, dataset_ids: Any, *, dataset_set_ref: Any = None) -> list[Any]:
    ref_id = str(dataset_set_ref or "").strip()
    if ref_id and dataset_ids:
        raise ValueError("create_nowcast_sequence 的 dataset_set_ref 和 dataset_ids 只能二选一。")
    if ref_id:
        ref = resolve_value_ref(runtime, ref_id, expected_kinds={"weather_dataset_set"})
        dataset_ids = _dataset_ids_from_set_ref(ref.value, ref_id=ref_id)
    if dataset_ids:
        return [_ensure_weather_dataset_parsed(runtime, str(dataset_id)) for dataset_id in dataset_ids]
    datasets = runtime.store.platform_store.list_weather_datasets(session_id=runtime.context.session_id, thread_id=runtime.context.thread_id)
    if not datasets:
        raise ValueError("当前线程没有可用短临 NC 数据集，请先上传短临产品。")
    return [_ensure_weather_dataset_parsed(runtime, item.dataset_id) for item in datasets]


def _dataset_ids_from_set_ref(value: Any, *, ref_id: str) -> list[str]:
    if isinstance(value, dict):
        raw_ids = value.get("datasetIds") or value.get("dataset_ids")
    else:
        raw_ids = value
    if not isinstance(raw_ids, list):
        raise ValueError(f"气象数据集集合引用不是 dataset id 列表：{ref_id}")
    dataset_ids = [str(item).strip() for item in raw_ids if str(item).strip()]
    if not dataset_ids:
        raise ValueError(f"气象数据集集合引用为空：{ref_id}")
    return dataset_ids


def _ensure_weather_dataset_parsed(runtime: ToolRuntime, dataset_id: str):
    method = getattr(runtime.store.platform_store, "ensure_weather_dataset_parsed", None)
    try:
        if callable(method):
            return method(dataset_id, _weather_service(runtime), thread_id=runtime.context.thread_id)
        dataset = runtime.store.platform_store.get_weather_dataset(dataset_id, thread_id=runtime.context.thread_id)
        if getattr(dataset, "status", "completed") != "completed":
            raise ValueError(f"气象数据集尚未解析完成：{dataset_id}")
        return dataset
    except NotFoundError:
        raise ValueError(f"气象数据集 {dataset_id} 不存在，请先使用 list_meteorological_datasets 查看当前可用的气象数据集。") from None


def _dataset_to_sequence_input(runtime: ToolRuntime, dataset: Any) -> dict[str, Any]:
    return {
        "dataset_id": dataset.dataset_id,
        "filename": dataset.filename,
        "path": _weather_dataset_path(runtime, dataset.storage_relative_path),
        "metadata": dataset.metadata,
    }


def _resolve_sequence(runtime: ToolRuntime, ref_id: str):
    payload = resolve_value_ref(runtime, ref_id, expected_kinds={"nowcast_sequence"}).value
    return NowcastSequenceService().sequence_from_payload(payload)


def _resolve_analysis(runtime: ToolRuntime, ref_id: str) -> dict[str, Any]:
    value = resolve_value_ref(runtime, ref_id, expected_kinds={"nowcast_analysis"}).value
    if not isinstance(value, dict):
        raise ValueError(f"短临分析引用不是结构化 facts：{ref_id}")
    return value


# 默认区划注入
#
# 全市/区县短临问答如果没有显式 AOI、bbox 或地点，就优先使用运行时配置
# 或 catalog 中唯一可识别的杭州区划，避免让模型每轮重新猜 layer_key。
def _apply_default_district_args(args: dict[str, Any], runtime: ToolRuntime) -> dict[str, Any]:
    if _has_explicit_analysis_scope(args):
        return args
    default = _resolve_default_district_layer(runtime)
    if default is None:
        return args
    updated = dict(args)
    updated.setdefault("district_layer_key", default["layer_key"])
    if default.get("name_field"):
        updated.setdefault("district_name_field", default["name_field"])
    return updated


def _has_explicit_analysis_scope(args: dict[str, Any]) -> bool:
    return any(
        args.get(key)
        for key in (
            "area_ref",
            "district_layer_key",
            "coordinate_ref",
            "latitude",
            "longitude",
            "bbox_ref",
            "bbox",
        )
    )


def _resolve_default_district_layer(runtime: ToolRuntime) -> dict[str, str] | None:
    configured = _configured_default_district_layer(runtime)
    if configured is not None:
        return configured
    lister = getattr(runtime.store.layer_repository, "list_active_layers", None)
    if not callable(lister):
        return None
    candidates = [_default_layer_payload(layer) for layer in lister() if _looks_like_hangzhou_district_layer(layer)]
    candidates = [item for item in candidates if item is not None]
    return candidates[0] if len(candidates) == 1 else None


def _configured_default_district_layer(runtime: ToolRuntime) -> dict[str, str] | None:
    getter = getattr(runtime.store.platform_store, "get_runtime_config", None)
    if not callable(getter):
        return None
    config = getter()
    nowcast = getattr(config, "nowcast", None)
    layer_key = str(getattr(nowcast, "district_layer_key", "") or "").strip()
    if not layer_key:
        return None
    name_field = str(getattr(nowcast, "district_name_field", "") or "").strip()
    return {"layer_key": layer_key, "name_field": name_field}


def _looks_like_hangzhou_district_layer(layer: Any) -> bool:
    haystack = " ".join(
        str(item or "")
        for item in (
            getattr(layer, "layer_key", ""),
            getattr(layer, "name", ""),
            getattr(layer, "description", ""),
            getattr(layer, "category", ""),
            " ".join(getattr(layer, "tags", []) or []),
            " ".join(getattr(layer, "analysis_capabilities", []) or []),
        )
    ).casefold()
    has_city = "杭州" in haystack or "hangzhou" in haystack
    has_boundary_semantics = any(token in haystack for token in ("区划", "区县", "边界", "boundary", "district", "admin"))
    return has_city and has_boundary_semantics and str(getattr(layer, "status", "active") or "active") == "active"


def _default_layer_payload(layer: Any) -> dict[str, str] | None:
    layer_key = str(getattr(layer, "layer_key", "") or "").strip()
    if not layer_key:
        return None
    return {"layer_key": layer_key, "name_field": _infer_district_name_field_from_descriptor(layer)}


def _infer_district_name_field_from_descriptor(layer: Any) -> str:
    available = {_property_name(item) for item in (getattr(layer, "property_schema", []) or [])}
    for candidate in ("name", "district_name", "区县", "区县名", "县名", "行政区"):
        if candidate in available:
            return candidate
    return ""


def _property_name(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("name") or "").strip()
    return str(getattr(item, "name", "") or "").strip()


def _resolve_optional_area(runtime: ToolRuntime, args: dict[str, Any]) -> dict[str, Any] | None:
    area_ref = str(args.get("area_ref") or "").strip()
    if area_ref:
        if area_ref in runtime.state.alias_map:
            return runtime.state.alias_map[area_ref]
        getter = getattr(runtime.store.platform_store, "get_artifact_collection", None)
        if callable(getter):
            return getter(area_ref)
        raise ValueError(f"分析区域引用不存在：{area_ref}")
    layer_key = str(args.get("district_layer_key") or "").strip()
    if layer_key:
        return runtime.store.spatial_service.load_layer(layer_key)
    return None


def _resolve_optional_bbox(runtime: ToolRuntime, args: dict[str, Any]) -> list[float] | None:
    bbox_ref = str(args.get("bbox_ref") or "").strip()
    if bbox_ref:
        value = resolve_value_ref(runtime, bbox_ref, expected_kinds={"bbox"}).value
        return [float(item) for item in value]
    bbox = args.get("bbox")
    return [float(item) for item in bbox] if bbox else None


def _resolve_optional_coordinate(runtime: ToolRuntime, args: dict[str, Any]) -> dict[str, Any] | None:
    has_ref = bool(str(args.get("coordinate_ref") or "").strip())
    has_raw = args.get("latitude") is not None and args.get("longitude") is not None
    if not has_ref and not has_raw:
        return None
    lat, lng, label = resolve_coordinate_arg(runtime, args, ref_key="coordinate_ref", lat_key="latitude", lng_key="longitude")
    return {"lat": lat, "lng": lng, "label": label}


async def _call_nowcast_text_model(runtime: ToolRuntime, *, facts: dict[str, Any], question: str, draft: dict[str, Any]) -> dict[str, Any]:
    model_registry = runtime.store.model_registry
    if model_registry is None or not runtime.context.model_provider:
        raise ValueError("当前工具运行时没有模型注册表或模型 provider，无法生成短临预报文字。")
    try:
        adapter = model_registry.resolve_provider(runtime.context.model_provider)
        if hasattr(adapter, "is_configured") and not adapter.is_configured():
            raise ValueError(f"模型 provider '{getattr(adapter, 'provider', runtime.context.model_provider)}' 尚未配置。")
        prompt = NowcastTextService().build_prompt(facts=facts, question=question, draft=draft)
        payload = await adapter.structured(
            prompt,
            schema=NOWCAST_ANSWER_SCHEMA,
            model=runtime.context.model_name or getattr(adapter, "default_model", None),
            temperature=0.1,
            request_timeout=120,
        )
        return NowcastTextService().normalize_model_answer(payload)
    except Exception as exc:
        raise ValueError(f"短临预报文字模型生成失败：{exc}") from exc


def _weather_service(runtime: ToolRuntime):
    return runtime.store.weather_service or WeatherDataService()


def _weather_dataset_path(runtime: ToolRuntime, relative_path: str) -> Path:
    resolver = getattr(runtime.store.platform_store, "resolve_runtime_path", None)
    if callable(resolver):
        return resolver(relative_path)
    return (runtime.store.runtime_root / relative_path).resolve()
