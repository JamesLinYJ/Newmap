# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临降水分析服务
#
#   文件:       nowcast.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 将连续短临 NC 产品转换成可审计的降水事实：序列时次、区域统计、
# 起止雨、增强减弱、移动方向、地图候选和问答 facts。这里不读取 Agent 历史。

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from shapely.geometry import Point, mapping, shape

from .readers import GridQuery, WeatherReaderFacade, coord_edges, finite_values


NOWCAST_ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["answer", "basis", "confidence", "warnings"],
    "properties": {
        "answer": {"type": "string"},
        "basis": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


@dataclass(frozen=True)
class NowcastProductProfile:
    # 短临产品变量口径。
    #
    # 变量名不写死在 Agent 中；不同产品可替换 profile。
    profile_id: str = "default_qpf_radar"
    precipitation_variables: tuple[str, ...] = ("QPF", "QPF_30", "QPF_06")
    reflectivity_variables: tuple[str, ...] = ("dbz",)
    thunder_variables: tuple[str, ...] = ("thunder",)
    wind_u_variables: tuple[str, ...] = ("u",)
    wind_v_variables: tuple[str, ...] = ("v",)
    rain_thresholds_mm: dict[str, float] = field(default_factory=lambda: {"none": 0.1, "light": 2.5, "moderate": 8.0, "heavy": 16.0})
    rain_coverage_threshold: float = 0.02
    peak_candidate_limit: int = 12

    def choose_precipitation_variable(self, available: set[str]) -> str:
        by_casefold = {item.casefold(): item for item in available}
        for candidate in self.precipitation_variables:
            if candidate.casefold() in by_casefold:
                return by_casefold[candidate.casefold()]
        raise ValueError(f"短临产品缺少可用降水变量；需要任一变量：{', '.join(self.precipitation_variables)}")

    def choose_optional_variable(self, available: set[str], candidates: tuple[str, ...]) -> str | None:
        by_casefold = {item.casefold(): item for item in available}
        for candidate in candidates:
            if candidate.casefold() in by_casefold:
                return by_casefold[candidate.casefold()]
        return None


@dataclass(frozen=True)
class NowcastDatasetItem:
    dataset_id: str
    filename: str
    path: Path
    metadata: dict[str, Any] = field(default_factory=dict)
    issue_time: datetime | None = None
    valid_time: datetime | None = None
    lead_minutes: int | None = None
    sequence_index: int = 0


@dataclass(frozen=True)
class WeatherSequence:
    sequence_id: str
    datasets: list[NowcastDatasetItem]
    profile: NowcastProductProfile
    variable: str
    bounds: list[float] | None
    issue_time: datetime | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "sequenceId": self.sequence_id,
            "profile": self.profile.profile_id,
            "variable": self.variable,
            "bounds": self.bounds,
            "issueTime": self.issue_time.isoformat() if self.issue_time else None,
            "datasets": [
                {
                    "datasetId": item.dataset_id,
                    "filename": item.filename,
                    "storagePath": str(item.path),
                    "sequenceIndex": item.sequence_index,
                    "issueTime": item.issue_time.isoformat() if item.issue_time else None,
                    "validTime": item.valid_time.isoformat() if item.valid_time else None,
                    "leadMinutes": item.lead_minutes,
                    "metadata": item.metadata,
                }
                for item in self.datasets
            ],
        }


class NowcastSequenceService:
    def __init__(self, *, reader: WeatherReaderFacade | None = None):
        self.reader = reader or WeatherReaderFacade()

    def create_sequence(
        self,
        *,
        sequence_id: str,
        datasets: list[dict[str, Any]],
        profile: NowcastProductProfile | None = None,
    ) -> WeatherSequence:
        profile = profile or NowcastProductProfile()
        items = [self._dataset_item(raw, index) for index, raw in enumerate(datasets)]
        if not items:
            raise ValueError("创建短临序列至少需要一个 NC 数据集。")
        items.sort(key=lambda item: (item.valid_time or datetime.max, item.filename, item.dataset_id))
        normalized = [self._replace_index(item, index) for index, item in enumerate(items)]
        variables = self._available_variables(normalized[0])
        variable = profile.choose_precipitation_variable(variables)
        bounds = normalized[0].metadata.get("bounds") if isinstance(normalized[0].metadata, dict) else None
        issue_time = next((item.issue_time for item in normalized if item.issue_time is not None), None)
        return WeatherSequence(sequence_id=sequence_id, datasets=normalized, profile=profile, variable=variable, bounds=bounds, issue_time=issue_time)

    def inspect_sequence(self, sequence: WeatherSequence) -> dict[str, Any]:
        return {
            "sequenceId": sequence.sequence_id,
            "datasetCount": len(sequence.datasets),
            "variable": sequence.variable,
            "issueTime": sequence.issue_time.isoformat() if sequence.issue_time else None,
            "validTimes": [item.valid_time.isoformat() if item.valid_time else None for item in sequence.datasets],
            "leadMinutes": [item.lead_minutes for item in sequence.datasets],
            "bounds": sequence.bounds,
            "profile": sequence.profile.profile_id,
            "mapReady": bool(sequence.bounds),
            "analysisReady": True,
            "variables": sorted(self._available_variables(sequence.datasets[0])),
        }

    def sequence_from_payload(self, payload: dict[str, Any]) -> WeatherSequence:
        profile = NowcastProductProfile(profile_id=str(payload.get("profile") or "default_qpf_radar"))
        datasets = []
        for item in payload.get("datasets") or []:
            datasets.append(
                {
                    "dataset_id": item.get("datasetId"),
                    "filename": item.get("filename"),
                    "path": Path(str(item.get("storagePath"))),
                    "metadata": item.get("metadata") or {},
                }
            )
        return self.create_sequence(sequence_id=str(payload["sequenceId"]), datasets=datasets, profile=profile)

    def _dataset_item(self, raw: dict[str, Any], index: int) -> NowcastDatasetItem:
        dataset_id = str(raw.get("dataset_id") or raw.get("datasetId") or "").strip()
        filename = str(raw.get("filename") or Path(str(raw.get("path"))).name).strip()
        path = Path(str(raw.get("path") or raw.get("storagePath")))
        if not dataset_id or not filename or not path:
            raise ValueError("短临序列数据集缺少 dataset_id、filename 或 path。")
        issue_time, valid_time = parse_nowcast_times(filename, raw.get("metadata") or {})
        lead_minutes = int((valid_time - issue_time).total_seconds() // 60) if issue_time and valid_time else None
        return NowcastDatasetItem(
            dataset_id=dataset_id,
            filename=filename,
            path=path,
            metadata=dict(raw.get("metadata") or {}),
            issue_time=issue_time,
            valid_time=valid_time,
            lead_minutes=lead_minutes,
            sequence_index=index,
        )

    @staticmethod
    def _replace_index(item: NowcastDatasetItem, index: int) -> NowcastDatasetItem:
        return NowcastDatasetItem(
            dataset_id=item.dataset_id,
            filename=item.filename,
            path=item.path,
            metadata=item.metadata,
            issue_time=item.issue_time,
            valid_time=item.valid_time,
            lead_minutes=item.lead_minutes,
            sequence_index=index,
        )

    def _available_variables(self, item: NowcastDatasetItem) -> set[str]:
        metadata_variables = item.metadata.get("variables") if isinstance(item.metadata, dict) else None
        if isinstance(metadata_variables, list) and metadata_variables:
            return {str(variable.get("name")) for variable in metadata_variables if isinstance(variable, dict) and variable.get("name")}
        index = self.reader.inspect(item.path, filename=item.filename)
        return {str(variable["name"]) for variable in index.variables}


class NowcastAnalysisService:
    def __init__(self, *, reader: WeatherReaderFacade | None = None):
        self.reader = reader or WeatherReaderFacade()

    def analyze(
        self,
        sequence: WeatherSequence,
        *,
        area: dict[str, Any] | None = None,
        bbox: list[float] | None = None,
        coordinate: dict[str, Any] | None = None,
        point_buffer_meters: float = 1000,
        district_name_field: str | None = None,
    ) -> dict[str, Any]:
        scope = build_analysis_scope(area=area, bbox=bbox, coordinate=coordinate, point_buffer_meters=point_buffer_meters, district_name_field=district_name_field)
        regions = scope["regions"]
        timelines = {region["id"]: [] for region in regions}
        centroids: list[dict[str, float | int]] = []
        for item in sequence.datasets:
            for region in regions:
                query = GridQuery(variable=sequence.variable, bbox=region.get("bbox") or bbox, area=region.get("collection"), purpose="nowcast")
                grid = self.reader.read_slice(item.path, query)
                stats = summarize_grid(grid.data, rain_threshold=sequence.profile.rain_thresholds_mm["none"], coverage_threshold=sequence.profile.rain_coverage_threshold)
                timelines[region["id"]].append(
                    {
                        "datasetId": item.dataset_id,
                        "filename": item.filename,
                        "sequenceIndex": item.sequence_index,
                        "validTime": item.valid_time.isoformat() if item.valid_time else None,
                        "leadMinutes": item.lead_minutes,
                        "stats": stats,
                        "rainLevel": classify_rain_level(stats, sequence.profile),
                    }
                )
                if region["id"] == regions[0]["id"]:
                    centroid = high_value_centroid(grid.data, grid.lat, grid.lon, threshold=max(sequence.profile.rain_thresholds_mm["light"], stats.get("p90") or 0))
                    if centroid:
                        centroids.append({"sequenceIndex": item.sequence_index, **centroid})
        region_summaries = [
            {
                "regionId": region["id"],
                "label": region["label"],
                "timeline": timelines[region["id"]],
                "diagnosis": diagnose_timeline(timelines[region["id"]]),
            }
            for region in regions
        ]
        movement = diagnose_movement(centroids)
        map_candidates = build_nowcast_map_candidates(sequence, region_summaries)
        return {
            "kind": "nowcast_precipitation_analysis",
            "sequenceId": sequence.sequence_id,
            "variable": sequence.variable,
            "scope": {key: value for key, value in scope.items() if key != "regions"},
            "regions": region_summaries,
            "movement": movement,
            "mapCandidates": map_candidates,
            "warnings": scope.get("warnings", []),
        }


class NowcastTextService:
    def build_draft_answer(self, *, facts: dict[str, Any], question: str) -> dict[str, Any]:
        regions = facts.get("regions") or []
        warnings = list(facts.get("warnings") or [])
        if not regions:
            return {"answer": "当前短临分析没有可用区域结果。", "basis": [], "confidence": 0.2, "warnings": warnings}
        target = select_region_for_question(regions, question)
        diagnosis = target.get("diagnosis") or {}
        movement = facts.get("movement") or {}
        answer = format_diagnosis_answer(target.get("label") or "当前区域", diagnosis, movement)
        basis = [
            f"分析变量：{facts.get('variable')}",
            f"分析区域：{target.get('label')}",
            f"起雨：{diagnosis.get('onsetLeadMinutes')} 分钟；峰值：{diagnosis.get('peakLeadMinutes')} 分钟；趋势：{diagnosis.get('trend')}",
        ]
        return {"answer": answer, "basis": basis, "confidence": 0.78 if diagnosis.get("hasRain") else 0.72, "warnings": warnings}

    def build_prompt(self, *, facts: dict[str, Any], question: str, draft: dict[str, Any]) -> str:
        facts_text = json.dumps({"question": question, "facts": facts, "draft": draft}, ensure_ascii=False, indent=2)
        return (
            "你是杭州短临降水预报员。请只基于 facts 和 draft 生成中文问答结果。\n"
            "要求：\n"
            "1. 不要编造区县、坐标、雨量、移动方向或时次。\n"
            "2. 如果 facts 中没有区划或地点事实，要说明限制。\n"
            "3. answer 面向市民，简洁自然；basis 保留关键依据。\n"
            "4. 只返回 JSON，字段为 answer、basis、confidence、warnings。\n\n"
            f"{facts_text}"
        )

    def normalize_model_answer(self, payload: dict[str, Any]) -> dict[str, Any]:
        answer = str(payload.get("answer") or "").strip()
        if len(answer) < 4:
            raise ValueError("模型生成的短临回答过短。")
        basis = [str(item) for item in payload.get("basis") or [] if str(item).strip()]
        warnings = [str(item) for item in payload.get("warnings") or [] if str(item).strip()]
        confidence = float(payload.get("confidence", 0.7))
        return {"answer": answer, "basis": basis, "confidence": max(0.0, min(confidence, 1.0)), "warnings": warnings}


def parse_nowcast_times(filename: str, metadata: dict[str, Any]) -> tuple[datetime | None, datetime | None]:
    for issue_key, valid_key in (("issueTime", "validTime"), ("issue_time", "valid_time")):
        if metadata.get(issue_key) and metadata.get(valid_key):
            return _parse_datetime(str(metadata[issue_key])), _parse_datetime(str(metadata[valid_key]))
    match = re.search(r"(\d{12})_(\d{12})", filename)
    if not match:
        return None, None
    return datetime.strptime(match.group(1), "%Y%m%d%H%M"), datetime.strptime(match.group(2), "%Y%m%d%H%M")


def build_analysis_scope(
    *,
    area: dict[str, Any] | None,
    bbox: list[float] | None,
    coordinate: dict[str, Any] | None,
    point_buffer_meters: float,
    district_name_field: str | None,
) -> dict[str, Any]:
    warnings: list[str] = []
    if coordinate is not None:
        lat = float(coordinate["lat"])
        lon = float(coordinate["lng"])
        radius_deg = max(float(point_buffer_meters), 1.0) / 111_320
        polygon = Point(lon, lat).buffer(radius_deg)
        label = str(coordinate.get("label") or "地点")
        collection = _single_feature_collection(mapping(polygon), {"name": label, "kind": "point_buffer"})
        return {
            "type": "coordinate_buffer",
            "label": label,
            "pointBufferMeters": point_buffer_meters,
            "regions": [{"id": "point", "label": label, "collection": collection, "bbox": _geom_bounds(polygon)}],
            "warnings": warnings,
        }
    if area is not None:
        features = area.get("features") if isinstance(area, dict) else None
        if not isinstance(features, list) or not features:
            raise ValueError("短临分析区域必须是非空 FeatureCollection。")
        field = district_name_field or _infer_name_field(features)
        regions = []
        for index, feature in enumerate(features):
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            if not geometry:
                continue
            props = feature.get("properties") or {}
            label = str(props.get(field) or props.get("name") or props.get("NAME") or f"区域{index + 1}")
            geom = shape(geometry)
            regions.append(
                {
                    "id": f"region_{index}",
                    "label": label,
                    "collection": {"type": "FeatureCollection", "features": [feature]},
                    "bbox": _geom_bounds(geom),
                }
            )
        if not regions:
            raise ValueError("短临分析区域没有有效面要素。")
        return {"type": "area", "label": "分析区域", "nameField": field, "regions": regions, "warnings": warnings}
    if bbox is not None:
        west, south, east, north = [float(item) for item in bbox]
        polygon = {
            "type": "Polygon",
            "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        }
        collection = _single_feature_collection(polygon, {"name": "bbox 范围", "kind": "bbox"})
        return {"type": "bbox", "label": "bbox 范围", "regions": [{"id": "bbox", "label": "bbox 范围", "collection": collection, "bbox": bbox}], "warnings": warnings}
    warnings.append("未提供区划、地点或 bbox，按产品完整覆盖范围分析。")
    return {"type": "full_extent", "label": "产品覆盖范围", "regions": [{"id": "full", "label": "产品覆盖范围", "collection": None, "bbox": None}], "warnings": warnings}


def summarize_grid(data: Any, *, rain_threshold: float, coverage_threshold: float) -> dict[str, Any]:
    np = _np()
    values = finite_values(data)
    if values.size == 0:
        return {"count": 0, "rainCoverage": 0.0, "min": None, "max": None, "mean": None, "median": None, "p90": None}
    rain_count = int(np.count_nonzero(values >= rain_threshold))
    coverage = rain_count / max(1, int(values.size))
    if coverage < coverage_threshold:
        effective_values = values
    else:
        effective_values = values[values >= rain_threshold] if rain_count else values
    return {
        "count": int(values.size),
        "rainCoverage": float(coverage),
        "min": float(values.min()),
        "max": float(values.max()),
        "mean": float(values.mean()),
        "median": float(np.percentile(effective_values, 50)),
        "p90": float(np.percentile(effective_values, 90)),
    }


def classify_rain_level(stats: dict[str, Any], profile: NowcastProductProfile) -> str:
    p90 = stats.get("p90")
    coverage = float(stats.get("rainCoverage") or 0)
    if p90 is None or coverage < profile.rain_coverage_threshold or float(p90) < profile.rain_thresholds_mm["none"]:
        return "none"
    value = float(p90)
    if value < profile.rain_thresholds_mm["light"]:
        return "light"
    if value < profile.rain_thresholds_mm["moderate"]:
        return "moderate"
    if value < profile.rain_thresholds_mm["heavy"]:
        return "heavy"
    return "storm"


def diagnose_timeline(timeline: list[dict[str, Any]]) -> dict[str, Any]:
    rainy = [item for item in timeline if item.get("rainLevel") != "none"]
    if not rainy:
        return {"hasRain": False, "trend": "no_rain", "summary": "未来三小时不会下雨", "onsetLeadMinutes": None, "peakLeadMinutes": None, "endLeadMinutes": None}
    values = [(item, float((item.get("stats") or {}).get("p90") or 0)) for item in rainy]
    peak_item, peak_value = max(values, key=lambda pair: pair[1])
    first = rainy[0]
    last = rainy[-1]
    first_value = float((first.get("stats") or {}).get("p90") or 0)
    last_value = float((last.get("stats") or {}).get("p90") or 0)
    trend = "continuous"
    if last_value > first_value * 1.25 and last.get("sequenceIndex") != first.get("sequenceIndex"):
        trend = "intensifying"
    elif last_value < first_value * 0.65:
        trend = "weakening"
    if timeline[-1].get("rainLevel") == "none":
        trend = "ending"
    end = next((item for item in timeline[timeline.index(first) :] if item.get("rainLevel") == "none"), None)
    return {
        "hasRain": True,
        "trend": trend,
        "summary": _trend_label(trend),
        "onsetLeadMinutes": first.get("leadMinutes"),
        "peakLeadMinutes": peak_item.get("leadMinutes"),
        "endLeadMinutes": end.get("leadMinutes") if end else None,
        "peakLevel": peak_item.get("rainLevel"),
        "peakP90": peak_value,
    }


def high_value_centroid(data: Any, lat: Any | None, lon: Any | None, *, threshold: float) -> dict[str, float] | None:
    if lat is None or lon is None:
        return None
    np = _np()
    values = np.asarray(data, dtype="float64")
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if values.size == 0 or lat_values.ndim != 1 or lon_values.ndim != 1:
        return None
    mask = np.isfinite(values) & (values >= threshold)
    if not mask.any():
        return None
    rows, cols = np.where(mask)
    weights = values[rows, cols]
    total = weights.sum()
    if total <= 0:
        return None
    return {"lat": float((lat_values[rows] * weights).sum() / total), "lng": float((lon_values[cols] * weights).sum() / total)}


def diagnose_movement(centroids: list[dict[str, float | int]]) -> dict[str, Any]:
    if len(centroids) < 2:
        return {"available": False, "direction": None, "distanceKm": None}
    first = centroids[0]
    last = centroids[-1]
    dlat = float(last["lat"]) - float(first["lat"])
    dlng = float(last["lng"]) - float(first["lng"])
    distance_km = math.hypot(dlat * 111.32, dlng * 111.32 * math.cos(math.radians(float(first["lat"]))))
    if distance_km < 0.5:
        return {"available": True, "direction": "基本稳定", "distanceKm": round(distance_km, 2)}
    direction = _direction_label(dlat, dlng)
    return {"available": True, "direction": direction, "distanceKm": round(distance_km, 2), "from": first, "to": last}


def build_nowcast_map_candidates(sequence: WeatherSequence, region_summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    latest = sequence.datasets[-1]
    candidates.append(_map_candidate(sequence, latest, "最新时次"))
    all_steps = [step for region in region_summaries for step in region.get("timeline", [])]
    rainy_steps = [step for step in all_steps if step.get("rainLevel") != "none"]
    if rainy_steps:
        peak = max(rainy_steps, key=lambda item: float((item.get("stats") or {}).get("p90") or 0))
        peak_dataset = sequence.datasets[int(peak["sequenceIndex"])]
        candidates.append(_map_candidate(sequence, peak_dataset, "降雨峰值时次"))
        onset_dataset = sequence.datasets[int(rainy_steps[0]["sequenceIndex"])]
        candidates.append(_map_candidate(sequence, onset_dataset, "起雨时次"))
    seen: set[tuple[str, str]] = set()
    unique = []
    for item in candidates:
        key = (item["datasetId"], item["variable"])
        if key in seen:
            existing = next(candidate for candidate in unique if (candidate["datasetId"], candidate["variable"]) == key)
            reasons = {str(part).strip() for part in str(existing.get("reason") or "").split(" / ") if str(part).strip()}
            reasons.add(str(item.get("reason") or "").strip())
            existing["reason"] = " / ".join(sorted(reasons))
            continue
        seen.add(key)
        unique.append(item)
    return unique[: sequence.profile.peak_candidate_limit]


def select_region_for_question(regions: list[dict[str, Any]], question: str) -> dict[str, Any]:
    for region in regions:
        label = str(region.get("label") or "")
        if label and label in question:
            return region
    return regions[0]


def format_diagnosis_answer(label: str, diagnosis: dict[str, Any], movement: dict[str, Any]) -> str:
    if not diagnosis.get("hasRain"):
        return f"{label}未来三小时不会下雨，您可以放心出门。"
    onset = diagnosis.get("onsetLeadMinutes")
    peak = diagnosis.get("peakLeadMinutes")
    end = diagnosis.get("endLeadMinutes")
    trend = diagnosis.get("trend")
    parts: list[str] = []
    parts.append(f"{label}{_lead_phrase(onset)}将出现{_rain_level_label(diagnosis.get('peakLevel'))}")
    if peak is not None and peak != onset:
        parts.append(f"{_lead_phrase(peak)}雨量较明显")
    if trend == "ending" and end is not None:
        parts.append(f"{_lead_phrase(end)}后降雨趋于结束")
    elif trend == "weakening":
        parts.append("后续雨势逐步减弱")
    elif trend == "intensifying":
        parts.append("后续雨势有增强趋势")
    else:
        parts.append("未来三小时仍有降雨影响")
    if movement.get("available") and movement.get("direction"):
        parts.append(f"降雨区整体{movement['direction']}移动")
    return "，".join(parts) + "。"


def _map_candidate(sequence: WeatherSequence, dataset: NowcastDatasetItem, reason: str) -> dict[str, Any]:
    label_time = f"{dataset.lead_minutes}分钟" if dataset.lead_minutes is not None else dataset.filename
    return {
        "datasetId": dataset.dataset_id,
        "filename": dataset.filename,
        "sequenceIndex": dataset.sequence_index,
        "validTime": dataset.valid_time.isoformat() if dataset.valid_time else None,
        "leadMinutes": dataset.lead_minutes,
        "variable": sequence.variable,
        "label": f"{label_time} {sequence.variable}",
        "reason": reason,
    }


def _infer_name_field(features: list[dict[str, Any]]) -> str:
    candidates = ("name", "NAME", "Name", "district", "区县", "区县名", "县名", "行政区")
    props_list = [feature.get("properties") or {} for feature in features if isinstance(feature, dict)]
    for candidate in candidates:
        if sum(1 for props in props_list if props.get(candidate)) >= max(1, len(props_list) // 2):
            return candidate
    raise ValueError("区划边界缺少可识别名称字段，请配置 districtNameField。")


def _single_feature_collection(geometry: dict[str, Any], properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": properties, "geometry": geometry}]}


def _geom_bounds(geom: Any) -> list[float]:
    west, south, east, north = geom.bounds
    return [float(west), float(south), float(east), float(north)]


def _parse_datetime(value: str) -> datetime | None:
    text = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%Y%m%d%H%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _trend_label(trend: str) -> str:
    return {"intensifying": "雨势增强", "weakening": "雨势减弱", "ending": "雨势渐停", "continuous": "持续降雨"}.get(trend, "持续降雨")


def _direction_label(dlat: float, dlng: float) -> str:
    north_south = "北" if dlat > 0 else "南" if dlat < 0 else ""
    east_west = "东" if dlng > 0 else "西" if dlng < 0 else ""
    return f"向{east_west}{north_south}" if east_west or north_south else "基本稳定"


def _lead_phrase(minutes: Any) -> str:
    if minutes is None:
        return "未来"
    value = int(minutes)
    if value <= 0:
        return "当前到未来短时"
    return f"{value}分钟后"


def _rain_level_label(level: Any) -> str:
    return {"light": "小雨", "moderate": "中雨", "heavy": "大雨", "storm": "强降雨"}.get(str(level), "降雨")


def _np() -> Any:
    import numpy as np
    return np
