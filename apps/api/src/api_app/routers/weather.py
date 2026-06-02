# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据路由 (v1)
#
#   文件:       weather.py
#
#   日期:       2026年05月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 提供气象数据上传、解析任务查询、数据集检查和派生分析结果生成接口。

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile

from gis_common.ids import make_id
from gis_weather import is_supported_weather_file
from ..config import settings
from ..dependencies import _format_component_error, get_store
from ..models import WeatherContoursRequest, WeatherRenderRequest, WeatherReportRequest, WeatherStatsRequest, WeatherThresholdRequest
from ..platform_store import PostgresPlatformStore
from ..weather_core import contours_weather_artifact, render_weather_artifact, report_weather_artifact, threshold_weather_artifact, weather_stats

router = APIRouter(tags=["weather"])


@router.post("/api/v1/weather/datasets")
async def upload_weather_dataset(
    request: Request,
    session_id: Annotated[str, Form(alias="sessionId")],
    thread_id: Annotated[str | None, Form(alias="threadId")] = None,
    file: UploadFile = File(...),
    store: PostgresPlatformStore = Depends(get_store),
):
    if not thread_id:
        raise HTTPException(status_code=400, detail="上传气象数据需要指定 threadId，请先在会话中创建或选择对话线程。")
    filename = Path(file.filename or "weather-data").name
    if not is_supported_weather_file(filename):
        raise HTTPException(status_code=400, detail="仅支持上传 .nc/.nc4/.tif/.tiff/.grib/.grb/.grb2/.h5/.hdf5/.bz2 气象或雷达数据。")
    dataset_id = make_id("weather")
    target_dir = settings.resolved_runtime_root / "weather" / "threads" / thread_id / "datasets" / dataset_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / filename
    await _stream_upload_to_path(file, target_path, max_bytes=settings.weather_upload_max_bytes)
    relative_path = str(target_path.relative_to(settings.resolved_runtime_root))
    dataset = store.create_weather_dataset(
        dataset_id=dataset_id,
        session_id=session_id,
        thread_id=thread_id,
        filename=filename,
        storage_relative_path=relative_path,
        metadata={"uploadedFilename": filename, "sizeBytes": target_path.stat().st_size},
    )
    store.update_session(session_id, latest_weather_dataset_id=dataset_id)
    return {"dataset": dataset, "job": None}


@router.get("/api/v1/weather/jobs/{job_id}")
async def get_weather_job(job_id: str, store: PostgresPlatformStore = Depends(get_store)):
    return store.get_weather_job(job_id)


@router.get("/api/v1/weather/datasets")
async def list_weather_datasets(
    session_id: str = Query(..., alias="sessionId"),
    thread_id: str | None = Query(None, alias="threadId"),
    store: PostgresPlatformStore = Depends(get_store),
):
    if not thread_id:
        return []
    return store.list_weather_datasets(session_id=session_id, thread_id=thread_id)


@router.get("/api/v1/weather/datasets/{dataset_id}")
async def get_weather_dataset(dataset_id: str, thread_id: str | None = Query(None, alias="threadId"), store: PostgresPlatformStore = Depends(get_store)):
    if not thread_id:
        raise HTTPException(status_code=400, detail="缺少 threadId 参数，无法查询气象数据集。")
    return store.get_weather_dataset(dataset_id, thread_id=thread_id)


@router.post("/api/v1/weather/datasets/{dataset_id}/render")
async def render_weather_dataset(
    dataset_id: str,
    payload: WeatherRenderRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    try:
        artifact, render_payload = render_weather_artifact(
            store=store,
            weather_service=request.app.state.weather_service,
            dataset_id=dataset_id,
            thread_id=payload.thread_id,
            run_id=payload.run_id,
            variable=payload.variable,
            time_index=payload.time_index,
            level_index=payload.level_index,
            bbox=payload.bbox,
            result_name=payload.result_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Weather service", f"render '{dataset_id}'", exc)) from exc
    return {"artifact": artifact, "payload": render_payload}


@router.post("/api/v1/weather/datasets/{dataset_id}/stats")
async def stats_weather_dataset(
    dataset_id: str,
    payload: WeatherStatsRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    try:
        return weather_stats(
            store=store,
            weather_service=request.app.state.weather_service,
            dataset_id=dataset_id,
            thread_id=payload.thread_id,
            variable=payload.variable,
            time_index=payload.time_index,
            level_index=payload.level_index,
            bbox=payload.bbox,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Weather service", f"stats '{dataset_id}'", exc)) from exc


@router.post("/api/v1/weather/datasets/{dataset_id}/threshold")
async def threshold_weather_dataset(
    dataset_id: str,
    payload: WeatherThresholdRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    try:
        artifact, result = threshold_weather_artifact(
            store=store,
            weather_service=request.app.state.weather_service,
            dataset_id=dataset_id,
            thread_id=payload.thread_id,
            run_id=payload.run_id,
            threshold=payload.threshold,
            operator=payload.operator,
            variable=payload.variable,
            time_index=payload.time_index,
            level_index=payload.level_index,
            bbox=payload.bbox,
            result_name=payload.result_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Weather service", f"threshold '{dataset_id}'", exc)) from exc
    return {"artifact": artifact, "payload": result}


@router.post("/api/v1/weather/datasets/{dataset_id}/contours")
async def contours_weather_dataset(
    dataset_id: str,
    payload: WeatherContoursRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    try:
        artifact, result = contours_weather_artifact(
            store=store,
            weather_service=request.app.state.weather_service,
            dataset_id=dataset_id,
            thread_id=payload.thread_id,
            run_id=payload.run_id,
            levels=payload.levels,
            variable=payload.variable,
            time_index=payload.time_index,
            level_index=payload.level_index,
            bbox=payload.bbox,
            result_name=payload.result_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Weather service", f"contours '{dataset_id}'", exc)) from exc
    return {"artifact": artifact, "payload": result}


@router.post("/api/v1/weather/datasets/{dataset_id}/report")
async def report_weather_dataset(
    dataset_id: str,
    payload: WeatherReportRequest,
    request: Request,
    store: PostgresPlatformStore = Depends(get_store),
):
    try:
        artifact, result = report_weather_artifact(
            store=store,
            weather_service=request.app.state.weather_service,
            dataset_id=dataset_id,
            thread_id=payload.thread_id,
            run_id=payload.run_id,
            llm_interpretation=payload.llm_interpretation,
            result_name=payload.result_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_format_component_error("Weather service", f"report '{dataset_id}'", exc)) from exc
    return {"artifact": artifact, "payload": result}


async def _stream_upload_to_path(file: UploadFile, target_path: Path, *, max_bytes: int) -> None:
    # 大文件上传边界。
    #
    # 气象文件可能达到数百 MB，不能复用普通图层上传的内存拼接路径；
    # 这里边读边写，并在超过限制时删除半成品。
    total = 0
    try:
        with target_path.open("wb") as handle:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(status_code=413, detail=f"上传文件过大，当前气象数据限制为 {max_bytes // (1024 * 1024)} MB。")
                handle.write(chunk)
    except Exception:
        target_path.unlink(missing_ok=True)
        raise
