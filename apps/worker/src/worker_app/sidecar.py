# +-------------------------------------------------------------------------
#
#   地理智能平台 - Python 科学计算 Worker
#
#   文件:       sidecar.py
#
#   日期:       2026年06月08日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

"""只承载 gis_meteorology 科学计算，不保存平台业务状态。"""

from __future__ import annotations

import logging
import os
from pathlib import Path
import sys
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("worker")

# 宿主机开发直接从仓库源码启动 worker；生产镜像仍可使用已安装包。
#
# 把科学计算源码根加入导入路径，避免 /health 假绿而首次工具调用才暴露缺包。
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
GIS_METEOROLOGY_SOURCE = REPOSITORY_ROOT / "packages" / "gis-meteorology" / "src"
if GIS_METEOROLOGY_SOURCE.is_dir() and str(GIS_METEOROLOGY_SOURCE) not in sys.path:
    sys.path.insert(0, str(GIS_METEOROLOGY_SOURCE))

app = FastAPI(title="geo-agent-science-worker", version="0.2.0")
RUNTIME_ROOT = Path(os.environ.get("RUNTIME_ROOT", "runtime")).resolve()


class ToolRequest(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)


@app.post("/tools/{tool_name}")
async def run_meteorology_tool(tool_name: str, request: ToolRequest) -> dict[str, Any]:
    """执行无状态科学计算；所有路径都必须是 runtime 根目录内的相对引用。"""
    try:
        payload = execute_meteorology_tool(tool_name, request.args)
        return {"message": f"{tool_name} 执行完成", "payload": payload, "warnings": payload.get("warnings", [])}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.exception("%s failed", tool_name)
        raise HTTPException(500, str(exc)) from exc


def execute_meteorology_tool(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology import NowcastAnalysisService, NowcastSequenceService, NowcastTextService
    from gis_meteorology.service import MeteorologicalDataService

    service = MeteorologicalDataService()
    if tool_name == "meteorological_inspect":
        source = input_path(args)
        return service.inspect(source, filename=input_filename(args, source))
    if tool_name in {"meteorological_render", "render_nowcast_raster"}:
        source = input_path(args)
        filename = input_filename(args, source)
        output = output_path(args)
        result = service.render_heatmap(
            source,
            output_path=output,
            filename=filename,
            variable=optional_text(args, "variable"),
            time_index=optional_int(args, "time_index"),
            level_index=optional_int(args, "level_index"),
            bbox=optional_number_list(args, "bbox"),
        )
        return {**result, "outputRelativePath": relative_runtime_path(output)}
    if tool_name == "meteorological_stats":
        return service.stats(
            input_path(args),
            filename=input_filename(args),
            variable=optional_text(args, "variable"),
            time_index=optional_int(args, "time_index"),
            level_index=optional_int(args, "level_index"),
            bbox=optional_number_list(args, "bbox"),
        )
    if tool_name == "meteorological_threshold":
        return service.threshold_geojson(
            input_path(args),
            threshold=required_float(args, "threshold"),
            operator=optional_text(args, "operator") or ">=",
            filename=input_filename(args),
            variable=optional_text(args, "variable"),
            time_index=optional_int(args, "time_index"),
            level_index=optional_int(args, "level_index"),
            bbox=optional_number_list(args, "bbox"),
        )
    if tool_name == "meteorological_contour":
        return service.contours_geojson(
            input_path(args),
            levels=optional_number_list(args, "levels"),
            filename=input_filename(args),
            variable=optional_text(args, "variable"),
            time_index=optional_int(args, "time_index"),
            level_index=optional_int(args, "level_index"),
            bbox=optional_number_list(args, "bbox"),
        )
    if tool_name == "meteorological_report":
        source = input_path(args)
        filename = input_filename(args, source)
        output = output_path(args)
        result = service.generate_report_docx(
            source,
            output_path=output,
            filename=filename,
            llm_interpretation=required_text(args, "interpretation_text"),
        )
        return {**result, "outputRelativePath": relative_runtime_path(output)}
    if tool_name == "create_nowcast_sequence":
        sequence = create_nowcast_sequence(args)
        return serialize_nowcast_sequence(sequence)
    if tool_name == "inspect_nowcast_sequence":
        sequence = nowcast_sequence_from_reference(args)
        return NowcastSequenceService().inspect_sequence(sequence)
    if tool_name == "meteorological_precipitation_nowcast":
        sequence = nowcast_sequence_from_reference(args, variable_override=optional_text(args, "variable"))
        analysis = NowcastAnalysisService().analyze(
            sequence,
            area=optional_dict(args, "area"),
            bbox=optional_number_list(args, "bbox"),
            coordinate=optional_dict(args, "coordinate"),
            point_buffer_meters=optional_float(args, "point_buffer_meters") or 1000,
            district_name_field=optional_text(args, "district_name_field"),
        )
        relative_paths = {item.dataset_id: relative_runtime_path(item.path) for item in sequence.datasets}
        analysis["mapCandidates"] = [
            {**candidate, "relativePath": relative_paths.get(str(candidate.get("datasetId") or ""))}
            for candidate in analysis.get("mapCandidates", [])
        ]
        return analysis
    if tool_name == "answer_nowcast_question":
        analysis = args.get("analysis")
        if not isinstance(analysis, dict):
            raise ValueError("analysis 必须是对象")
        return NowcastTextService().build_draft_answer(
            facts=analysis,
            question=required_text(args, "question"),
        )
    if tool_name == "generate_nowcast_forecast_text":
        analysis = args.get("analysis")
        if not isinstance(analysis, dict):
            raise ValueError("analysis 必须是对象")
        return NowcastTextService().build_draft_answer(
            facts=analysis,
            question="生成正式短时临近预报（短临）预报文字",
        )
    if tool_name == "inspect_radar_station_collection":
        from gis_meteorology.third_party.radar_mosaic_agent.adapter import inspect_radar_station_collection

        return inspect_radar_station_collection(referenced_paths(args, "files"))
    if tool_name == "recommend_radar_mosaic_strategy":
        from gis_meteorology.third_party.radar_mosaic_agent.adapter import recommend_radar_mosaic_strategy

        return recommend_radar_mosaic_strategy(
            goal_mode=optional_text(args, "goal_mode") or "quicklook",
            time_strategy=optional_text(args, "time_strategy") or "nearest",
        )
    if tool_name == "render_radar_mosaic":
        from gis_meteorology.third_party.radar_mosaic_agent.adapter import render_radar_mosaic

        output_png = output_path(args, key="output_png_relative_path")
        output_npz = output_path(args, key="output_npz_relative_path")
        output_map_png_value = optional_text(args, "output_map_png_relative_path")
        output_map_png = output_path(args, key="output_map_png_relative_path") if output_map_png_value else None
        result = render_radar_mosaic(
            paths=referenced_paths(args, "files"),
            output_png=output_png,
            output_npz=output_npz,
            output_map_png=output_map_png,
            target_time=required_text(args, "target_time"),
            tolerance_sec=optional_int(args, "tolerance_sec") or 300,
            strategy=optional_text(args, "strategy") or "max",
            product=optional_text(args, "product") or "reflectivity",
            level_index=optional_int(args, "level_index") or 0,
            grid_res_km=optional_float(args, "grid_res_km") or 1.0,
            min_dbz=optional_float(args, "min_dbz") or 5.0,
        )
        return {
            **result,
            "outputPngRelativePath": relative_runtime_path(output_png),
            "outputNpzRelativePath": relative_runtime_path(output_npz),
            **({"outputMapPngRelativePath": relative_runtime_path(output_map_png)} if output_map_png is not None else {}),
        }
    if tool_name == "compare_radar_mosaic_reference":
        from gis_meteorology.third_party.radar_mosaic_agent.adapter import compare_radar_mosaic_reference

        output_png = output_path(args, key="output_png_relative_path")
        output_ref_png = output_path(args, key="output_reference_png_relative_path")
        result = compare_radar_mosaic_reference(
            mosaic_npz=referenced_path({"relativePath": required_text(args, "mosaic_npz_relative_path")}),
            reference_paths=referenced_paths(args, "reference_files"),
            output_png=output_png,
            output_reference_png=output_ref_png,
            target_time=required_text(args, "target_time"),
            level_index=optional_int(args, "level_index") or 0,
            product_label=optional_text(args, "product_label") or "反射率",
            product_unit=optional_text(args, "product_unit") or "dBZ",
            min_display=optional_float(args, "min_display") or 10.0,
        )
        return {
            **result,
            "outputPngRelativePath": relative_runtime_path(output_png),
            "outputReferencePngRelativePath": relative_runtime_path(output_ref_png),
        }
    if tool_name == "render_rainfall_risk_map":
        from gis_meteorology.third_party.rainfall_risk_map.adapter import render_rainfall_risk_map

        output = output_path(args)
        output_geojson_value = optional_text(args, "output_geojson_relative_path")
        output_geojson = output_path(args, key="output_geojson_relative_path") if output_geojson_value else None
        result = render_rainfall_risk_map(
            nc_path=input_path(args),
            output_png=output,
            output_geojson=output_geojson,
            variable=required_text(args, "variable"),
            boundary_path=optional_referenced_path(args, "boundary_relative_path"),
            thresholds=optional_list_of_dicts(args, "thresholds"),
            map_mode=optional_text(args, "map_mode") or "regional",
            aggregation=optional_text(args, "aggregation") or "mean",
            label_field=optional_text(args, "label_field"),
            title=optional_text(args, "title"),
        )
        return {
            **result,
            "outputRelativePath": relative_runtime_path(output),
            **({"outputGeojsonRelativePath": relative_runtime_path(output_geojson)} if output_geojson is not None else {}),
        }
    if tool_name == "generate_area_rainfall_table":
        from gis_meteorology.third_party.short_term_forecast.adapter import generate_area_rainfall_table

        file_items = sequence_items(args)
        nc_paths = [referenced_path(item) for item in file_items]
        nc_names = [referenced_filename(item, source) for item, source in zip(file_items, nc_paths)]
        output_xlsx = output_path(args, key="output_xlsx_relative_path")
        output_png = output_path(args, key="output_png_relative_path")
        result = generate_area_rainfall_table(
            nc_paths=nc_paths,
            nc_names=nc_names,
            boundary_path=referenced_path({"relativePath": required_text(args, "boundary_relative_path")}),
            output_xlsx=output_xlsx,
            output_png=output_png,
            top_n=optional_int(args, "top_n") or 10,
            label_field=optional_text(args, "label_field"),
            style=optional_dict(args, "style"),
        )
        return {
            **result,
            "outputXlsxRelativePath": relative_runtime_path(output_xlsx),
            "outputPngRelativePath": relative_runtime_path(output_png),
        }
    raise ValueError(f"未知科学计算工具：{tool_name}")


def create_nowcast_sequence(args: dict[str, Any]) -> Any:
    from gis_meteorology import NowcastProductProfile, NowcastSequenceService
    from gis_meteorology.service import MeteorologicalDataService

    variable = optional_text(args, "variable")
    datasets = []
    inspector = MeteorologicalDataService()
    for index, item in enumerate(sequence_items(args)):
        source = referenced_path(item)
        filename = referenced_filename(item, source)
        datasets.append({
            "dataset_id": str(item.get("fileId") or item.get("datasetId") or f"dataset_{index + 1}"),
            "filename": filename,
            "path": source,
            "metadata": inspector.inspect(source, filename=filename),
        })
    profile = NowcastProductProfile(precipitation_variables=(variable,)) if variable else NowcastProductProfile()
    return NowcastSequenceService().create_sequence(
        sequence_id=f"sequence_{uuid4().hex}",
        datasets=datasets,
        profile=profile,
    )


def nowcast_sequence_from_reference(args: dict[str, Any], *, variable_override: str | None = None) -> Any:
    from gis_meteorology import NowcastProductProfile, NowcastSequenceService

    raw = args.get("sequence")
    if not isinstance(raw, dict):
        raise ValueError("sequence 必须是对象")
    raw_datasets = raw.get("datasets")
    if not isinstance(raw_datasets, list) or not raw_datasets:
        raise ValueError("sequence.datasets 必须是非空数组")
    datasets = []
    for index, item in enumerate(raw_datasets):
        if not isinstance(item, dict):
            raise ValueError("sequence.datasets 中每一项必须是对象")
        source = referenced_path(item)
        datasets.append({
            "dataset_id": str(item.get("datasetId") or f"dataset_{index + 1}"),
            "filename": str(item.get("filename") or source.name),
            "path": source,
            "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else {},
        })
    variable = variable_override or optional_text(raw, "variable")
    profile = NowcastProductProfile(precipitation_variables=(variable,)) if variable else NowcastProductProfile()
    return NowcastSequenceService().create_sequence(
        sequence_id=str(raw.get("sequenceId") or f"sequence_{uuid4().hex}"),
        datasets=datasets,
        profile=profile,
    )


def serialize_nowcast_sequence(sequence: Any) -> dict[str, Any]:
    payload = sequence.to_payload()
    datasets = []
    for item, raw in zip(sequence.datasets, payload.get("datasets", []), strict=True):
        datasets.append({
            **{key: value for key, value in raw.items() if key != "storagePath"},
            "relativePath": relative_runtime_path(item.path),
        })
    return {**payload, "datasets": datasets}


def sequence_items(args: dict[str, Any]) -> list[dict[str, Any]]:
    items = args.get("files")
    if not isinstance(items, list) or not items:
        raise ValueError("files 必须是非空数组")
    if not all(isinstance(item, dict) for item in items):
        raise ValueError("files 中每一项必须是对象")
    return items


def input_path(args: dict[str, Any]) -> Path:
    return referenced_path({"relativePath": required_text(args, "file_relative_path")})


def input_filename(args: dict[str, Any], source: Path | None = None) -> str | None:
    for key in ("filename", "file_name", "name"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return Path(value.strip()).name
    return source.name if source is not None else None


def output_path(args: dict[str, Any], *, key: str = "output_relative_path") -> Path:
    relative = required_text(args, key)
    target = resolve_runtime_path(relative, must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def optional_referenced_path(args: dict[str, Any], key: str) -> Path | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} 必须是非空字符串")
    return referenced_path({"relativePath": value})


def referenced_paths(args: dict[str, Any], key: str) -> list[Path]:
    items = args.get(key)
    if not isinstance(items, list) or not items:
        raise ValueError(f"{key} 必须是非空文件引用数组")
    paths = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"{key}[{index}] 必须是对象")
        paths.append(referenced_path(item))
    return paths


def referenced_path(value: dict[str, Any]) -> Path:
    relative = value.get("relativePath") or value.get("file_relative_path")
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("文件引用缺少 relativePath")
    return resolve_runtime_path(relative, must_exist=True)


def referenced_filename(value: dict[str, Any], source: Path) -> str:
    for key in ("name", "filename", "fileName"):
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            return Path(raw.strip()).name
    return source.name


def resolve_runtime_path(relative: str, *, must_exist: bool) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute():
        raise ValueError("Worker 禁止接收绝对路径")
    resolved = (RUNTIME_ROOT / candidate).resolve()
    if resolved != RUNTIME_ROOT and RUNTIME_ROOT not in resolved.parents:
        raise ValueError("文件引用越出共享 runtime 根目录")
    if must_exist and not resolved.is_file():
        raise FileNotFoundError(f"文件引用不存在：{relative}")
    return resolved


def relative_runtime_path(value: Path) -> str:
    return value.resolve().relative_to(RUNTIME_ROOT).as_posix()


def required_text(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} 不能为空")
    return value.strip()


def optional_text(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def optional_int(args: dict[str, Any], key: str) -> int | None:
    value = args.get(key)
    return int(value) if value is not None else None


def required_float(args: dict[str, Any], key: str) -> float:
    value = args.get(key)
    if value is None:
        raise ValueError(f"{key} 不能为空")
    return float(value)

def optional_float(args: dict[str, Any], key: str) -> float | None:
    value = args.get(key)
    return float(value) if value is not None else None


def optional_dict(args: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{key} 必须是对象")
    return value


def optional_list_of_dicts(args: dict[str, Any], key: str) -> list[dict[str, Any]] | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError(f"{key} 必须是数组")
    if not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{key} 中每一项必须是对象")
    return value


def optional_number_list(args: dict[str, Any], key: str) -> list[float] | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError(f"{key} 必须是数组")
    return [float(item) for item in value]


@app.get("/health")
async def health():
    try:
        import gis_meteorology  # noqa: F401
        import geopandas  # noqa: F401
        import matplotlib  # noqa: F401
        import numpy  # noqa: F401
        import openpyxl  # noqa: F401
        import pandas  # noqa: F401
        import scipy  # noqa: F401
    except ImportError as exc:
        raise HTTPException(503, f"gis_meteorology 不可用：{exc}") from exc
    return {"status": "ok", "runtimeRoot": str(RUNTIME_ROOT), "gisMeteorologyAvailable": True}
