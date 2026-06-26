from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import sys
import json
import numpy as np
from flask import Flask, jsonify, request, send_from_directory

import radar_mosaic as rm
import mosaic_comparison as mc


PROJECT_ROOT = Path(__file__).resolve().parent
UI_ROOT = PROJECT_ROOT / "ui"
OUTPUT_ROOT = PROJECT_ROOT / "outputs_runtime"
BOUNDARY_SHP = Path(r"D:\ai短临预报智能体\前期培训\任务一\shapefile\浙江省县边界.shp")
REFERENCE_NC_DIRS = [
    PROJECT_ROOT / "雷达过程数据23日1830_50" / "雷达拼图dbz",
    PROJECT_ROOT / "雷达过程数据23日1830_50" / "雷达过程数据23日1830_50" / "雷达拼图dbz",
]
TIME_LABEL_FORMAT = "%Y-%m-%d %H:%M"
EVENT_LOGS: list[dict[str, str]] = []

DATASETS = {
    "default": {
        "label": "默认示例数据",
        "root": PROJECT_ROOT / "data",
        "preview": "/outputs_runtime/mosaic_20260518075048_reflectivity_L1_max_Z9041-Z9573-Z9574.png",
        "default_time": "20260518075048",
    },
    "20260523": {
        "label": "5月23日过程数据",
        "root": PROJECT_ROOT / "data_20260523_1830_50_ready",
        "preview": "/outputs_20260523_test/mosaic_20260523105008_Z9040-Z9041-Z9044-Z9045-Z9050-Z9570-Z9571-Z9572-Z9573-Z9574-Z9575-Z9576-Z9577-Z9578-Z9579-Z9580.png",
        "default_time": "20260523105008",
    },
}

WARMED_UP: dict[str, bool] = {key: False for key in DATASETS}
RECORD_CACHE: dict[str, tuple[list[rm.RadarRecord], dict[str, list[rm.RadarRecord]]]] = {}


app = Flask(__name__, static_folder=str(UI_ROOT), static_url_path="")


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return response


def append_log(message: str) -> None:
    EVENT_LOGS.insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "message": message})
    del EVENT_LOGS[30:]


def dataset_config(dataset_key: str) -> dict[str, Any]:
    return DATASETS.get(dataset_key, DATASETS["default"])


def load_station_records(dataset_key: str) -> tuple[list[rm.RadarRecord], dict[str, list[rm.RadarRecord]]]:
    if dataset_key not in RECORD_CACHE:
        config = dataset_config(dataset_key)
        records = rm.scan_records(config["root"])
        RECORD_CACHE[dataset_key] = (records, rm.group_records_by_station(records))
    return RECORD_CACHE[dataset_key]


def warm_decode_cache(dataset_key: str) -> None:
    if WARMED_UP.get(dataset_key):
        return
    records, station_records = load_station_records(dataset_key)
    # 每个站点只解码最新一个文件（拼图只需要目标时次附近的文件）
    warmed: set[str] = set()
    for station, recs in station_records.items():
        latest = recs[-1]  # 该站最新时次的文件
        path_str = str(latest.path)
        if path_str not in warmed:
            rm.decode_radar_file_cached(path_str)
            warmed.add(path_str)
    if BOUNDARY_SHP.exists():
        rm.load_boundary_data(BOUNDARY_SHP)
    WARMED_UP[dataset_key] = True
    append_log(f"[{dataset_key}] 缓存预热完成（每站1文件，共{len(warmed)}站）")


def latest_station_snapshot(station_records: dict[str, list[rm.RadarRecord]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for station in sorted(station_records):
        record = station_records[station][-1]
        items.append({
            "station": station,
            "latest_time": record.timestamp.strftime(TIME_LABEL_FORMAT),
            "file": record.path.name,
            "status": "normal",
        })
    return items


def list_time_options(records: list[rm.RadarRecord]) -> list[dict[str, str]]:
    unique = sorted({record.timestamp for record in records})
    return [{"value": item.strftime(rm.TIME_FORMAT), "label": item.strftime(TIME_LABEL_FORMAT)} for item in unique]


def recommend_strategy(goal_mode: str, time_strategy: str) -> dict[str, str]:
    if time_strategy == "strict":
        if goal_mode == "smooth": key = "weighted"
        elif goal_mode == "speed": key = "strict"
        else: key = "max"
    else:
        if goal_mode == "smooth": key = "weighted"
        elif goal_mode == "coverage": key = "max"
        else: key = "strict"
    strategies = {
        "max": {"key": "max", "name": "最大反射率拼接", "reason": "适合当前站点规模与业务场景，解释性强，结果稳定。"},
        "weighted": {"key": "weighted", "name": "距离加权拼接", "reason": "更强调重叠区平滑过渡，适合提升图面观感。"},
        "quality": {"key": "quality", "name": "质量评分拼接", "reason": "适合后续接入质量控制和异常剔除后升级成业务方案。"},
        "strict": {"key": "strict", "name": "严格同步拼接", "reason": "更强调业务时间一致性，适合严谨的时次控制。"},
    }
    return strategies[key]


def ensure_runtime_output() -> Path:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    return OUTPUT_ROOT


def run_single_mosaic(
    dataset_key: str, target_time: str, tolerance_sec: int, boundary_mode: str,
    strategy: str = "max", product: str = "reflectivity", level_index: int = 0,
) -> dict[str, Any]:
    records, station_records = load_station_records(dataset_key)
    target_dt = datetime.strptime(target_time, rm.TIME_FORMAT)
    actual_tolerance = tolerance_sec
    if strategy == "strict":
        actual_tolerance = min(tolerance_sec, 120)
    group = rm.build_single_group(station_records, target_dt, actual_tolerance)
    boundary_path = BOUNDARY_SHP if boundary_mode != "none" and BOUNDARY_SHP.exists() else None
    boundary_data = rm.load_boundary_data(boundary_path) if boundary_path is not None else None
    output_dir = ensure_runtime_output()
    rm.process_group(group=group, output_dir=output_dir, grid_res_km=1.0, min_dbz=0.0,
                     boundary_data=boundary_data, extent_mode="boundary", boundary_padding_degree=0.08,
                     strategy=strategy, product=product, level_index=level_index)
    product = rm.normalize_product_key(product)
    stem = rm.build_output_stem(group, product=product, strategy=strategy, level_index=level_index)
    image_path = output_dir / f"{stem}.png"
    npz_path = output_dir / f"{stem}.npz"
    product_config = rm.get_product_config(product)
    append_log(f"[{dataset_key}] 完成时次 {group.target_time.strftime(TIME_LABEL_FORMAT)} "
               f"{product_config.label}拼图，参与站点 {', '.join(sorted({r.station for r in group.records}))}")

    # NC 参考对比（仅当存在匹配的参考文件时运行）
    comparison_result = None
    nc_path = mc.find_reference_nc(target_dt, reference_dirs=REFERENCE_NC_DIRS, tolerance_sec=600)
    if nc_path is not None:
        try:
            mosaic_npz = np.load(npz_path)
            comparison_result = mc.run_comparison(
                grid_lon=mosaic_npz["grid_lon"], grid_lat=mosaic_npz["grid_lat"],
                generated_display=mosaic_npz["mosaic_ref"], target_time=group.target_time,
                output_dir=output_dir, level_index=level_index,
                product_label=product_config.label, product_unit=product_config.unit,
                min_display=float(product_config.min_display), reference_dirs=REFERENCE_NC_DIRS,
            )
            mosaic_npz.close()
            if comparison_result is not None:
                append_log(f"对比完成: 参考={comparison_result['nc_file']}, "
                           f"RMSE={comparison_result['stats']['rmse']:.2f}, "
                           f"相关系数={comparison_result['stats']['correlation']:.3f}")
        except Exception as exc:
            append_log(f"对比失败: {exc}")
    else:
        append_log("无匹配NC参考文件（该时次无对比数据），仅生成拼图")

    return {
        "target_time": group.target_time.strftime(TIME_LABEL_FORMAT),
        "stations": [record.station for record in sorted(group.records, key=lambda x: x.station)],
        "image_url": f"/outputs_runtime/{image_path.name}",
        "npz_url": f"/outputs_runtime/{npz_path.name}",
        "max_delta_sec": group.max_delta_sec, "strategy": strategy, "dataset": dataset_key,
        "time_tolerance_sec": actual_tolerance, "product": product,
        "product_label": product_config.label, "level_index": level_index,
        "comparison": comparison_result,
    }


def algorithm_comparison(goal_mode: str, time_strategy: str) -> list[dict[str, str]]:
    primary = recommend_strategy(goal_mode, time_strategy)["key"]
    items = [
        {"key": "max", "name": "最大反射率拼接", "summary": "稳态基线，解释性强"},
        {"key": "weighted", "name": "距离加权拼接", "summary": "平滑增强，画面过渡更自然"},
        {"key": "quality", "name": "质量评分拼接", "summary": "业务升级方向，适合后续扩展"},
        {"key": "strict", "name": "严格同步拼接", "summary": "时次最严谨，覆盖可能略受限"},
    ]
    for item in items:
        item["recommended"] = "yes" if item["key"] == primary else "no"
    return items


@app.get("/")
def serve_index():
    return send_from_directory(UI_ROOT, "index.html")


@app.get("/api/dashboard")
def api_dashboard():
    dataset_key = request.args.get("dataset", "default") or "default"
    config = dataset_config(dataset_key)
    warm_decode_cache(dataset_key)
    records, station_records = load_station_records(dataset_key)
    latest_time = max(record.timestamp for record in records)
    return jsonify({
        "platform": "雷达拼图智能体决策平台", "dataset": dataset_key,
        "datasets": [{"key": key, "label": value["label"]} for key, value in DATASETS.items()],
        "latest_time": latest_time.strftime(TIME_LABEL_FORMAT),
        "stations": latest_station_snapshot(station_records),
        "time_options": list_time_options(records),
        "default_target_time": config["default_time"],
        "products": rm.product_options(), "preview_image": config["preview"],
        "logs": EVENT_LOGS,
    })


@app.post("/api/recommend")
def api_recommend():
    payload = request.get_json(silent=True) or {}
    goal_mode = payload.get("goal_mode", "coverage")
    time_strategy = payload.get("time_strategy", "strict")
    recommendation = recommend_strategy(goal_mode, time_strategy)
    append_log(f"生成算法建议: {recommendation['name']}")
    return jsonify(recommendation)


@app.post("/api/run-task")
def api_run_task():
    payload = request.get_json(silent=True) or {}
    dataset_key = payload.get("dataset", "default")
    warm_decode_cache(dataset_key)
    target_time = payload.get("target_time")
    if not target_time:
        return jsonify({"error": "target_time is required"}), 400
    tolerance_sec = int(payload.get("time_tolerance_sec", 300))
    boundary_mode = payload.get("boundary_mode", "county")
    strategy = payload.get("strategy", "max")
    product = payload.get("product", "reflectivity")
    level_index = int(payload.get("level_index", 0))
    append_log(f"[{dataset_key}] 开始执行拼图任务: {target_time}")
    result = run_single_mosaic(dataset_key, target_time, tolerance_sec, boundary_mode,
                               strategy=strategy, product=product, level_index=level_index)
    result["logs"] = EVENT_LOGS
    return jsonify(result)


@app.post("/api/compare")
def api_compare():
    payload = request.get_json(silent=True) or {}
    goal_mode = payload.get("goal_mode", "coverage")
    time_strategy = payload.get("time_strategy", "strict")
    items = algorithm_comparison(goal_mode, time_strategy)
    append_log("生成算法对比结果")
    return jsonify({"items": items})


@app.get("/api/logs")
def api_logs():
    return jsonify({"logs": EVENT_LOGS})


@app.get("/outputs_runtime/<path:filename>")
def serve_runtime_output(filename: str):
    return send_from_directory(OUTPUT_ROOT, filename)


@app.get("/outputs_zhejiang_ppt/<path:filename>")
def serve_static_output(filename: str):
    return send_from_directory(PROJECT_ROOT / "outputs_zhejiang_ppt", filename)


@app.get("/outputs_20260523_test/<path:filename>")
def serve_new_dataset_output(filename: str):
    return send_from_directory(PROJECT_ROOT / "outputs_20260523_test", filename)


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5055, debug=False)
