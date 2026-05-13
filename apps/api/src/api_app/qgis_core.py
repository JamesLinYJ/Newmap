# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 执行核心
#
#   文件:       qgis_core.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 封装 QGIS Processing/Model 的执行逻辑、输入解析、能力探测和结果持久化，
# 供 router 层和工具执行层共享复用。

from __future__ import annotations

import json
import logging
from json import JSONDecodeError
from pathlib import Path

import httpx
from fastapi import HTTPException
from pydantic import ValidationError
from shared_types.exceptions import NotFoundError

from gis_common.geojson import load_geojson, save_geojson
from gis_common.ids import make_id, now_utc
from shared_types.schemas import ArtifactRef, EventType, RunEvent
from tool_registry import ToolExecutionResult

from .config import settings
from .models import QgisModelRequest, QgisProcessRequest, ToolRunRequest

logger = logging.getLogger(__name__)


def _format_component_error(component: str, action: str, exc: Exception) -> str:
    return f"{component} {action} failed: {exc.__class__.__name__}: {exc}"


def _to_qgis_runtime_path(path: Path) -> str:
    return str(path.resolve())


def _from_qgis_runtime_path(path: Path) -> Path:
    return path.resolve()


def _looks_like_local_path(value: str) -> bool:
    candidate = Path(value)
    return candidate.is_absolute() or value.startswith("./") or value.startswith("../")


def _coerce_json_inputs(value: object) -> dict[str, object]:
    if value in (None, "", {}):
        return {}
    if isinstance(value, dict):
        return {str(key): val for key, val in value.items()}
    if isinstance(value, str):
        parsed = json.loads(value)
        if not isinstance(parsed, dict):
            raise ValueError("inputsJson 必须是 JSON 对象。")
        return {str(key): val for key, val in parsed.items()}
    raise ValueError("inputsJson 必须是 JSON 对象。")


def _coerce_artifact_ref(value: object) -> ArtifactRef | None:
    if not isinstance(value, dict):
        return None
    return ArtifactRef.model_validate(value)


def _response_looks_online(response: httpx.Response) -> bool:
    text = response.text
    if response.is_success:
        return True
    if "ServiceExceptionReport" in text or "WMS_Capabilities" in text or "ows:ExceptionReport" in text:
        return True
    return response.status_code < 500


async def _probe_qgis_server_endpoint(
    client: httpx.AsyncClient,
    candidates: list[tuple[str, dict[str, str] | None]],
) -> httpx.Response:
    last_response: httpx.Response | None = None
    for url, params in candidates:
        response = await client.get(url, params=params)
        if _response_looks_online(response):
            return response
        last_response = response
    if last_response is None:
        raise RuntimeError("QGIS server probe did not issue any HTTP request")
    return last_response


async def qgis_server_capabilities() -> tuple[bool, bool]:
    base_url = (settings.qgis_server_internal_base_url or settings.qgis_server_base_url).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            wms_response = await _probe_qgis_server_endpoint(
                client,
                [(f"{base_url}/ows/", {"SERVICE": "WMS", "REQUEST": "GetCapabilities"})],
            )
            ogc_response = await _probe_qgis_server_endpoint(
                client,
                [
                    (f"{base_url}/ogc/collections", None),
                    (f"{base_url}/ogcapi/collections", None),
                ],
            )
    except Exception as exc:
        logger.warning("QGIS server capability probe failed: %s", _format_component_error("QGIS server", "capability probe", exc))
        return False, False
    qgis_server_available = _response_looks_online(wms_response)
    ogc_available = _response_looks_online(ogc_response) and "ServiceExceptionReport" not in ogc_response.text
    return qgis_server_available, ogc_available


def _resolve_qgis_inputs(
    inputs: dict[str, object],
    store,
    *,
    source_parameter_names: set[str] | None,
    layer_repository,
    spatial_service,
) -> dict[str, object]:
    resolved: dict[str, object] = {}
    runtime_root = settings.resolved_runtime_root
    for key, value in inputs.items():
        if not isinstance(value, str):
            resolved[key] = value
            continue
        if source_parameter_names is not None and key not in source_parameter_names:
            resolved[key] = value
            continue
        if value.startswith("artifact:"):
            artifact_id = value.split(":", 1)[1]
            resolved[key] = _to_qgis_runtime_path(store.get_artifact_geojson_path(artifact_id))
            continue
        try:
            resolved[key] = _to_qgis_runtime_path(store.get_artifact_geojson_path(value))
            continue
        except (HTTPException, NotFoundError):
            pass
        if _looks_like_local_path(value):
            resolved[key] = value
            continue
        try:
            layer_repository.get_layer_descriptor(value)
        except Exception:
            resolved[key] = value
            continue
        resolved[key] = _to_qgis_runtime_path(_materialize_catalog_layer_for_qgis(value, spatial_service, runtime_root))
    return resolved


def _materialize_catalog_layer_for_qgis(layer_key: str, spatial_service, runtime_root: Path) -> Path:
    collection = spatial_service.load_layer(layer_key)
    output_dir = runtime_root / "artifacts" / "qgis-inputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{layer_key}_{make_id('layer')}.geojson"
    save_geojson(output_path, collection)
    return output_path


async def execute_qgis_process(
    payload: QgisProcessRequest,
    *,
    store,
    qgis_runner,
    layer_repository,
    spatial_service,
    source_parameter_names: set[str] | None = None,
):
    health = await qgis_runner.health()
    if not health.get("available"):
        raise HTTPException(status_code=503, detail=health.get("error") or "QGIS runtime process run failed: runtime unavailable")
    output_dir = settings.resolved_runtime_root / "artifacts" / "qgis-process"
    runtime_root = settings.resolved_runtime_root
    inputs = _resolve_qgis_inputs(
        dict(payload.inputs), store,
        source_parameter_names=source_parameter_names,
        layer_repository=layer_repository,
        spatial_service=spatial_service,
    )
    if payload.artifact_id and payload.input_parameter_name:
        inputs[payload.input_parameter_name] = _to_qgis_runtime_path(store.get_artifact_geojson_path(payload.artifact_id))
    if payload.output_parameter_name and payload.output_parameter_name not in inputs:
        suffix = ".geojson" if payload.save_as_artifact else ".gpkg"
        inputs[payload.output_parameter_name] = _to_qgis_runtime_path(output_dir / f"{payload.algorithm_id.replace(':', '_')}_{make_id('output')}{suffix}")
    try:
        result = await qgis_runner.run_processing_algorithm(
            payload.algorithm_id,
            inputs,
            _to_qgis_runtime_path(output_dir),
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("QGIS runtime", f"run process '{payload.algorithm_id}'", exc)) from exc
    return await _maybe_attach_qgis_artifact(
        result=result,
        run_id=payload.run_id,
        save_as_artifact=payload.save_as_artifact,
        result_name=payload.result_name or payload.algorithm_id,
        store=store,
        layer_repository=layer_repository,
    )


async def execute_qgis_model(
    payload: QgisModelRequest,
    *,
    store,
    qgis_runner,
    layer_repository,
    spatial_service,
):
    health = await qgis_runner.health()
    if not health.get("available"):
        raise HTTPException(status_code=503, detail=health.get("error") or "QGIS runtime model run failed: runtime unavailable")
    output_dir = settings.resolved_runtime_root / "artifacts" / "qgis-models"
    runtime_root = settings.resolved_runtime_root
    inputs = _resolve_qgis_inputs(
        dict(payload.inputs), store,
        source_parameter_names=None,
        layer_repository=layer_repository,
        spatial_service=spatial_service,
    )
    if payload.artifact_id and payload.input_parameter_name:
        inputs[payload.input_parameter_name] = _to_qgis_runtime_path(store.get_artifact_geojson_path(payload.artifact_id))
    if payload.output_parameter_name and payload.output_parameter_name not in inputs:
        suffix = ".geojson" if payload.save_as_artifact else ".gpkg"
        inputs[payload.output_parameter_name] = _to_qgis_runtime_path(output_dir / f"{payload.model_name}_{make_id('output')}{suffix}")
    try:
        result = await qgis_runner.run_model(
            payload.model_name,
            inputs,
            _to_qgis_runtime_path(output_dir),
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("QGIS runtime", f"run model '{payload.model_name}'", exc)) from exc
    return await _maybe_attach_qgis_artifact(
        result=result,
        run_id=payload.run_id,
        save_as_artifact=payload.save_as_artifact,
        result_name=payload.result_name or payload.model_name,
        store=store,
        layer_repository=layer_repository,
    )


async def _maybe_attach_qgis_artifact(
    result: dict[str, object],
    *,
    run_id: str | None,
    save_as_artifact: bool,
    result_name: str,
    store,
    layer_repository,
) -> dict[str, object]:
    if not save_as_artifact or not run_id or result.get("status") != "completed":
        return result

    output_path = None
    resolved_outputs = result.get("resolved_outputs", {})
    if isinstance(resolved_outputs, dict):
        for candidate in resolved_outputs.values():
            path = str(candidate)
            if path.endswith(".geojson") or path.endswith(".json"):
                output_path = path
                break
    if output_path is None:
        return result

    collection = load_geojson(_from_qgis_runtime_path(Path(output_path)))
    result_descriptor = layer_repository.save_result_layer(run_id, result_name, result_name, collection)
    artifact = store.save_geojson_artifact(
        run_id=run_id,
        artifact_id=make_id("artifact"),
        name=result_name,
        collection=collection,
        metadata={
            "source": "qgis_process",
            "output_path": output_path,
            "feature_count": len(collection.get("features", [])),
            "result_layer_key": result_descriptor.layer_key,
        },
    )
    store.add_artifact_to_run(run_id, artifact)
    run = store.get_run(run_id)
    store.append_event(
        run_id,
        RunEvent(
            event_id=make_id("evt"),
            run_id=run_id,
            thread_id=run.thread_id,
            type=EventType.ARTIFACT_CREATED,
            message=f"QGIS 输出已保存为结果图层：{artifact.name}",
            timestamp=now_utc(),
            payload=artifact.model_dump(mode="json"),
        ),
    )
    return {**result, "artifact": artifact.model_dump(mode="json")}


async def run_qgis_algorithm_tool(
    payload: ToolRunRequest,
    *,
    run_id: str,
    store,
    qgis_runner,
    layer_repository,
    spatial_service,
) -> ToolExecutionResult:
    tool_args = dict(payload.args)
    available_algorithms = await qgis_runner.list_algorithms()
    algorithm = next((item for item in available_algorithms.get("algorithms", []) if item.get("id") == payload.tool_name), None)
    if algorithm is None:
        raise ValueError(f"未发现 QGIS Processing 算法：{payload.tool_name}")

    source_parameter_names = {
        str(parameter.get("name"))
        for parameter in algorithm.get("parameters", [])
        if str(parameter.get("type") or "") in {"source", "vector", "raster"}
    }
    inputs: dict[str, object] = {}
    for key, value in tool_args.items():
        if key in {"save_as_artifact", "result_name"}:
            continue
        if isinstance(value, str) and value.strip().startswith(("{", "[")):
            try:
                inputs[str(key)] = json.loads(value)
                continue
            except json.JSONDecodeError:
                pass
        inputs[str(key)] = value
    result = await execute_qgis_process(
        QgisProcessRequest(
            algorithmId=payload.tool_name,
            runId=run_id,
            saveAsArtifact=bool(tool_args.get("save_as_artifact", True)),
            resultName=str(tool_args.get("result_name") or f"QGIS 算法：{payload.tool_name}"),
            outputParameterName=str(algorithm.get("output_parameter_name") or "OUTPUT"),
            inputs=inputs,
        ),
        store=store,
        qgis_runner=qgis_runner,
        layer_repository=layer_repository,
        spatial_service=spatial_service,
        source_parameter_names=source_parameter_names,
    )
    if result.get("status") == "failed":
        raise RuntimeError(str(result.get("error") or f"QGIS 算法 {payload.tool_name} 执行失败。"))
    artifact = _coerce_artifact_ref(result.get("artifact"))
    return ToolExecutionResult(message=f"已调用 QGIS 算法 {payload.tool_name}。", artifact=artifact, payload=result)


async def run_qgis_model_tool(
    payload: ToolRunRequest,
    *,
    run_id: str,
    store,
    qgis_runner,
    layer_repository,
    spatial_service,
) -> ToolExecutionResult:
    tool_args = dict(payload.args)
    inputs = _coerce_json_inputs(tool_args.get("inputs_json"))

    overlay_artifact_id = tool_args.get("overlay_artifact_id")
    if overlay_artifact_id:
        inputs["OVERLAY"] = f"artifact:{overlay_artifact_id}"
    if "distance" in tool_args and tool_args["distance"] not in (None, ""):
        inputs["DISTANCE"] = float(tool_args["distance"])

    result = await execute_qgis_model(
        QgisModelRequest(
            modelName=payload.tool_name,
            artifactId=str(tool_args["artifact_id"]),
            runId=run_id,
            saveAsArtifact=bool(tool_args.get("save_as_artifact", True)),
            resultName=str(tool_args.get("result_name") or f"QGIS 模型：{payload.tool_name}"),
            outputParameterName="output",
            inputs=inputs,
        ),
        store=store,
        qgis_runner=qgis_runner,
        layer_repository=layer_repository,
        spatial_service=spatial_service,
    )
    if result.get("status") == "failed":
        raise RuntimeError(str(result.get("error") or f"QGIS 模型 {payload.tool_name} 执行失败。"))
    artifact = _coerce_artifact_ref(result.get("artifact"))
    return ToolExecutionResult(message=f"已调用 QGIS 模型 {payload.tool_name}。", artifact=artifact, payload=result)
