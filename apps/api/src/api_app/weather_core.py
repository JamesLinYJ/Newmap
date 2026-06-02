# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据业务核心
#
#   文件:       weather_core.py
#
#   日期:       2026年05月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 封装气象 dataset/job 的解析推进，以及派生 raster/GeoJSON artifact 的持久化。

from __future__ import annotations

from pathlib import Path
from typing import Any

from gis_common.ids import make_id, now_utc
from shared_types.schemas import ArtifactRef

from .platform_store import PostgresPlatformStore


def process_weather_parse_job(store: PostgresPlatformStore, weather_service: Any, job_id: str) -> None:
    # 解析任务推进。
    #
    # worker 已经把 job 从 queued 领取成 running；这里复用懒解析入口，
    # 保留显式后台任务兼容，但上传接口不再自动创建 parse job。
    job = store.get_weather_job(job_id)
    try:
        ensure_weather_dataset_parsed(store, weather_service, job.dataset_id, thread_id=job.thread_id, job_id=job.job_id)
    except ValueError:
        return


def ensure_weather_dataset_parsed(store: PostgresPlatformStore, weather_service: Any, dataset_id: str, *, thread_id: str, job_id: str | None = None):
    # 懒解析入口代理。
    #
    # 状态推进的单一事实源在 PostgresPlatformStore；weather_core 只负责把
    # API/worker 的业务路径统一接到这一条生命周期入口。
    return store.ensure_weather_dataset_parsed(dataset_id, weather_service, thread_id=thread_id, job_id=job_id)


def render_weather_artifact(
    *,
    store: PostgresPlatformStore,
    weather_service: Any,
    dataset_id: str,
    thread_id: str,
    run_id: str | None,
    variable: str | None,
    time_index: int | None,
    level_index: int | None,
    bbox: list[float] | None = None,
    result_name: str | None = None,
) -> tuple[ArtifactRef, dict[str, Any]]:
    dataset = ensure_weather_dataset_parsed(store, weather_service, dataset_id, thread_id=thread_id)
    output_run_id, created_output_run = _ensure_output_run(store, run_id=run_id, session_id=dataset.session_id, title=f"气象热力图：{dataset.filename}")
    artifact_id = make_id("artifact")
    output_path = _weather_output_dir(store, dataset.dataset_id) / f"{artifact_id}.png"
    render_metadata = weather_service.render_heatmap(
        store.resolve_runtime_path(dataset.storage_relative_path),
        output_path=output_path,
        variable=variable,
        time_index=time_index,
        level_index=level_index,
        bbox=bbox,
    )
    artifact = store.save_file_artifact(
        run_id=output_run_id,
        artifact_id=artifact_id,
        artifact_type="raster_png",
        name=result_name or f"{dataset.filename} 热力图",
        source_path=str(output_path),
        suffix=".png",
        metadata={
            **render_metadata,
            "datasetId": dataset.dataset_id,
            "source": "weather_dataset",
            "bbox": bbox,
            "maskApplied": False,
            "imageUrl": f"/api/v1/results/{artifact_id}/file",
        },
    )
    store.add_artifact_to_run(output_run_id, artifact)
    _complete_output_run(store, output_run_id, enabled=created_output_run)
    return artifact, render_metadata


def weather_stats(
    *,
    store: PostgresPlatformStore,
    weather_service: Any,
    dataset_id: str,
    thread_id: str,
    variable: str | None,
    time_index: int | None,
    level_index: int | None,
    bbox: list[float] | None = None,
) -> dict[str, Any]:
    dataset = ensure_weather_dataset_parsed(store, weather_service, dataset_id, thread_id=thread_id)
    return weather_service.stats(
        store.resolve_runtime_path(dataset.storage_relative_path),
        variable=variable,
        time_index=time_index,
        level_index=level_index,
        bbox=bbox,
    )


def threshold_weather_artifact(
    *,
    store: PostgresPlatformStore,
    weather_service: Any,
    dataset_id: str,
    thread_id: str,
    run_id: str | None,
    threshold: float,
    operator: str,
    variable: str | None,
    time_index: int | None,
    level_index: int | None,
    bbox: list[float] | None,
    result_name: str | None,
) -> tuple[ArtifactRef, dict[str, Any]]:
    dataset = ensure_weather_dataset_parsed(store, weather_service, dataset_id, thread_id=thread_id)
    output_run_id, created_output_run = _ensure_output_run(store, run_id=run_id, session_id=dataset.session_id, title=f"气象阈值区：{dataset.filename}")
    collection = weather_service.threshold_geojson(
        store.resolve_runtime_path(dataset.storage_relative_path),
        threshold=threshold,
        operator=operator,
        variable=variable,
        time_index=time_index,
        level_index=level_index,
        bbox=bbox,
    )
    artifact = _save_weather_geojson_artifact(
        store,
        run_id=output_run_id,
        dataset_id=dataset.dataset_id,
        collection=collection,
        name=result_name or f"{dataset.filename} 阈值区",
        operation="threshold",
        extra_metadata={"threshold": threshold, "operator": operator, "levelIndex": level_index, "bbox": bbox},
    )
    _complete_output_run(store, output_run_id, enabled=created_output_run)
    return artifact, {"featureCount": len(collection.get("features", []))}


def contours_weather_artifact(
    *,
    store: PostgresPlatformStore,
    weather_service: Any,
    dataset_id: str,
    thread_id: str,
    run_id: str | None,
    levels: list[float] | None,
    variable: str | None,
    time_index: int | None,
    level_index: int | None,
    bbox: list[float] | None,
    result_name: str | None,
) -> tuple[ArtifactRef, dict[str, Any]]:
    dataset = ensure_weather_dataset_parsed(store, weather_service, dataset_id, thread_id=thread_id)
    output_run_id, created_output_run = _ensure_output_run(store, run_id=run_id, session_id=dataset.session_id, title=f"气象等值线：{dataset.filename}")
    collection = weather_service.contours_geojson(
        store.resolve_runtime_path(dataset.storage_relative_path),
        levels=levels,
        variable=variable,
        time_index=time_index,
        level_index=level_index,
        bbox=bbox,
    )
    artifact = _save_weather_geojson_artifact(
        store,
        run_id=output_run_id,
        dataset_id=dataset.dataset_id,
        collection=collection,
        name=result_name or f"{dataset.filename} 等值线",
        operation="contours",
        extra_metadata={"levels": levels or [], "levelIndex": level_index, "bbox": bbox},
    )
    _complete_output_run(store, output_run_id, enabled=created_output_run)
    return artifact, {"featureCount": len(collection.get("features", []))}


def report_weather_artifact(
    *,
    store: PostgresPlatformStore,
    weather_service: Any,
    dataset_id: str,
    thread_id: str,
    run_id: str | None,
    llm_interpretation: str,
    result_name: str | None,
) -> tuple[ArtifactRef, dict[str, Any]]:
    # DOCX 解读报告。
    #
    # 报告必须包含大模型解读正文；weather_service 负责校验并生成正式文档，
    # 这里只处理运行记录和 artifact 持久化。
    dataset = ensure_weather_dataset_parsed(store, weather_service, dataset_id, thread_id=thread_id)
    output_run_id, created_output_run = _ensure_output_run(store, run_id=run_id, session_id=dataset.session_id, title=f"气象解读报告：{dataset.filename}")
    artifact_id = make_id("artifact")
    output_path = _weather_output_dir(store, dataset.dataset_id) / f"{artifact_id}.docx"
    report_metadata = weather_service.generate_report_docx(
        store.resolve_runtime_path(dataset.storage_relative_path),
        output_path=output_path,
        filename=dataset.filename,
        dataset_id=dataset.dataset_id,
        metadata=dataset.metadata,
        llm_interpretation=llm_interpretation,
    )
    artifact = store.save_file_artifact(
        run_id=output_run_id,
        artifact_id=artifact_id,
        artifact_type="docx_report",
        name=result_name or f"{dataset.filename} 解读报告",
        source_path=str(output_path),
        suffix=".docx",
        metadata={
            **report_metadata,
            "datasetId": dataset.dataset_id,
            "source": "weather_dataset",
            "operation": "docx_report",
            "fileUrl": f"/api/v1/results/{artifact_id}/file",
        },
    )
    store.add_artifact_to_run(output_run_id, artifact)
    _complete_output_run(store, output_run_id, enabled=created_output_run)
    return artifact, report_metadata


def _require_completed_dataset(store: PostgresPlatformStore, dataset_id: str, *, thread_id: str):
    dataset = store.get_weather_dataset(dataset_id, thread_id=thread_id)
    if dataset.status != "completed":
        raise ValueError(f"气象数据集尚未解析完成，当前状态：{dataset.status}")
    return dataset


def _weather_output_dir(store: PostgresPlatformStore, dataset_id: str) -> Path:
    root = store.artifact_store.runtime_root / "weather" / "derived" / dataset_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def _ensure_output_run(store: PostgresPlatformStore, *, run_id: str | None, session_id: str, title: str) -> tuple[str, bool]:
    if run_id:
        return run_id, False
    thread = store.get_or_create_thread_for_session(session_id, title=title)
    run = store.create_run(session_id, title, thread_id=thread.id)
    store.mark_run_running(run.id)
    return run.id, True


def _complete_output_run(store: PostgresPlatformStore, run_id: str, *, enabled: bool) -> None:
    if not enabled:
        return
    run = store.get_run(run_id)
    if run.status == "running":
        store.update_run_state(run_id, status="completed")


def _save_weather_geojson_artifact(
    store: PostgresPlatformStore,
    *,
    run_id: str,
    dataset_id: str,
    collection: dict[str, Any],
    name: str,
    operation: str,
    extra_metadata: dict[str, Any],
) -> ArtifactRef:
    artifact_id = make_id("artifact")
    artifact = store.save_geojson_artifact(
        run_id=run_id,
        artifact_id=artifact_id,
        name=name,
        collection=collection,
        metadata={
            "datasetId": dataset_id,
            "source": "weather_dataset",
            "operation": operation,
            "feature_count": len(collection.get("features", [])),
            "createdAt": now_utc().isoformat(),
            **extra_metadata,
        },
    )
    store.add_artifact_to_run(run_id, artifact)
    return artifact
