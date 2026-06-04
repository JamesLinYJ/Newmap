# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据解读事实包
#
#   文件:       interpretation.py
#
#   日期:       2026年05月26日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 将 NC/气象数据 metadata、统计值和地图候选压缩成可交给大模型的事实包。
# 这里不调用模型、不生成结论，只负责稳定排序、限长和结构化校验。

from __future__ import annotations

import json
from typing import Any


PRIORITY_VARIABLES = ("dbz", "qpf", "qpf_06", "qpf_30", "thunder", "u", "v", "kdp")

INTERPRETATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["summary", "keyFindings", "riskSignals", "methodNotes", "recommendedNextSteps", "reportText"],
    "properties": {
        "summary": {"type": "string"},
        "keyFindings": {"type": "array", "items": {"type": "string"}},
        "riskSignals": {"type": "array", "items": {"type": "string"}},
        "methodNotes": {"type": "array", "items": {"type": "string"}},
        "recommendedNextSteps": {"type": "array", "items": {"type": "string"}},
        "reportText": {"type": "string"},
    },
}


def select_interpretation_variables(
    metadata: dict[str, Any],
    *,
    requested: list[str] | None = None,
    max_variables: int = 8,
) -> list[dict[str, Any]]:
    variables = _metadata_variables(metadata)
    if requested:
        requested_names = {item.casefold() for item in requested if item.strip()}
        variables = [item for item in variables if item["name"].casefold() in requested_names]
    variables.sort(key=lambda item: (_priority_index(item["name"]), item["name"].casefold()))
    return variables[: max(1, int(max_variables or 8))]


def build_interpretation_facts(
    *,
    datasets: list[dict[str, Any]],
    stats_rows: list[dict[str, Any]],
    map_candidates: list[dict[str, Any]],
    focus: str | None = None,
) -> dict[str, Any]:
    return {
        "kind": "meteorological_netcdf_interpretation",
        "mode": "sequence" if len(datasets) > 1 else "single",
        "focus": focus or "",
        "datasetCount": len(datasets),
        "datasets": datasets,
        "variables": _summarize_variables(datasets),
        "statistics": _compact_stats_rows(stats_rows),
        "sequenceSummary": _sequence_summary(stats_rows) if len(datasets) > 1 else {},
        "mapCandidates": map_candidates,
        "warnings": _collect_warnings(datasets, stats_rows),
    }


def build_interpretation_prompt(facts: dict[str, Any]) -> str:
    facts_text = json.dumps(facts, ensure_ascii=False, indent=2)
    return (
        "你是专业气象数据分析师。请基于下面的 NetCDF/气象数据事实生成中文解读。\n"
        "要求：\n"
        "1. 只能使用 facts 中的变量、统计值、范围、时次和警告，不要编造外部事实。\n"
        "2. 如果 mapCandidates 非空，请在 recommendedNextSteps 中说明可手动选择这些候选生成地图图层。\n"
        "3. 如果 mapCandidates 为空，请说明该数据当前仅能统计/解读，不能地图展示。\n"
        "4. reportText 面向正式 DOCX 报告，包含 3 到 6 个自然段，语气专业、克制。\n"
        "5. 只返回符合 schema 的 JSON 对象，不要 Markdown 代码块。\n\n"
        f"facts:\n{facts_text}"
    )


def normalize_interpretation_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {
        "summary": _require_text(payload.get("summary"), "summary"),
        "keyFindings": _string_list(payload.get("keyFindings"), "keyFindings"),
        "riskSignals": _string_list(payload.get("riskSignals"), "riskSignals", allow_empty=True),
        "methodNotes": _string_list(payload.get("methodNotes"), "methodNotes", allow_empty=True),
        "recommendedNextSteps": _string_list(payload.get("recommendedNextSteps"), "recommendedNextSteps"),
        "reportText": _require_text(payload.get("reportText"), "reportText"),
    }
    if len(normalized["reportText"]) < 20:
        raise ValueError("模型生成的气象解读正文过短。")
    return normalized


def build_map_candidates(
    *,
    datasets: list[dict[str, Any]],
    stats_rows: list[dict[str, Any]],
    max_candidates: int = 12,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int | None, int | None, str]] = set()
    if not datasets:
        return []

    latest = max(datasets, key=lambda item: int(item.get("sequenceIndex") or 0))
    for variable in _map_ready_variables(latest):
        _append_candidate(
            candidates,
            seen,
            dataset=latest,
            variable=variable,
            reason="最新时次可地图展示",
            max_candidates=max_candidates,
        )

    by_variable: dict[str, dict[str, Any]] = {}
    for row in stats_rows:
        stats = row.get("stats") if isinstance(row.get("stats"), dict) else {}
        max_value = stats.get("max")
        if max_value is None:
            continue
        try:
            numeric_max = float(max_value)
        except (TypeError, ValueError):
            continue
        variable_name = str(row.get("variable") or "")
        current = by_variable.get(variable_name)
        if current is None or numeric_max > float(current["max"]):
            by_variable[variable_name] = {**row, "max": numeric_max}

    dataset_by_id = {str(item["datasetId"]): item for item in datasets}
    for variable_name, row in sorted(by_variable.items(), key=lambda item: (_priority_index(item[0]), item[0].casefold())):
        dataset = dataset_by_id.get(str(row.get("datasetId")))
        if dataset is None:
            continue
        variable = next((item for item in _map_ready_variables(dataset) if item["name"] == variable_name), None)
        if variable is None:
            continue
        _append_candidate(
            candidates,
            seen,
            dataset=dataset,
            variable=variable,
            reason=f"{variable_name} 峰值时次，可用于定位高值区",
            max_candidates=max_candidates,
        )
    return candidates[:max_candidates]


def _metadata_variables(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    raw_variables = metadata.get("variables")
    if not isinstance(raw_variables, list):
        return []
    variables: list[dict[str, Any]] = []
    for item in raw_variables:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("variable") or "").strip()
        if not name:
            continue
        variables.append(
            {
                "name": name,
                "unit": item.get("unit"),
                "longName": item.get("longName") or item.get("long_name"),
                "dimensions": item.get("dimensions") or [],
                "shape": item.get("shape") or [],
                "timeCount": int(item.get("timeCount") or 0),
                "levelCount": int(item.get("levelCount") or 0),
                "bounds": item.get("bounds"),
                "mapReady": bool(item.get("mapReady")),
                "analysisReady": bool(item.get("analysisReady", True)),
                "preferredBackend": item.get("preferredBackend"),
            }
        )
    return variables


def _summarize_variables(datasets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for dataset in datasets:
        for variable in dataset.get("selectedVariables", []):
            name = variable["name"]
            if name not in by_name:
                by_name[name] = {
                    "name": name,
                    "unit": variable.get("unit"),
                    "longName": variable.get("longName"),
                    "mapReady": variable.get("mapReady"),
                    "analysisReady": variable.get("analysisReady"),
                    "preferredBackend": variable.get("preferredBackend"),
                }
    return list(by_name.values())


def _compact_stats_rows(stats_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for row in stats_rows:
        item = {
            "datasetId": row.get("datasetId"),
            "filename": row.get("filename"),
            "sequenceIndex": row.get("sequenceIndex"),
            "variable": row.get("variable"),
        }
        if row.get("error"):
            item["error"] = row["error"]
        else:
            stats = row.get("stats") if isinstance(row.get("stats"), dict) else {}
            item["stats"] = {
                key: stats.get(key)
                for key in ("unit", "count", "min", "max", "mean", "median", "p90", "timeValue", "levelValue")
                if stats.get(key) is not None
            }
        compact.append(item)
    return compact


def _sequence_summary(stats_rows: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for variable in sorted({str(row.get("variable")) for row in stats_rows if row.get("variable")}):
        rows = [row for row in stats_rows if row.get("variable") == variable and isinstance(row.get("stats"), dict)]
        if not rows:
            continue
        rows.sort(key=lambda item: int(item.get("sequenceIndex") or 0))
        max_row = _row_with_extreme(rows, "max", highest=True)
        mean_first = _stat_value(rows[0], "mean")
        mean_last = _stat_value(rows[-1], "mean")
        summary[variable] = {
            "availableSteps": len(rows),
            "firstDatasetId": rows[0].get("datasetId"),
            "lastDatasetId": rows[-1].get("datasetId"),
            "peakDatasetId": max_row.get("datasetId") if max_row else None,
            "peakFilename": max_row.get("filename") if max_row else None,
            "peakMax": _stat_value(max_row, "max") if max_row else None,
            "meanChange": (mean_last - mean_first) if mean_first is not None and mean_last is not None else None,
        }
    return summary


def _row_with_extreme(rows: list[dict[str, Any]], key: str, *, highest: bool) -> dict[str, Any] | None:
    candidates = [(row, _stat_value(row, key)) for row in rows]
    candidates = [(row, value) for row, value in candidates if value is not None]
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: item[1], reverse=highest)[0][0]


def _stat_value(row: dict[str, Any] | None, key: str) -> float | None:
    if row is None:
        return None
    stats = row.get("stats") if isinstance(row.get("stats"), dict) else {}
    value = stats.get(key)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _collect_warnings(datasets: list[dict[str, Any]], stats_rows: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    for dataset in datasets:
        for warning in dataset.get("warnings", []):
            warnings.append(f"{dataset.get('filename')}: {warning}")
    for row in stats_rows:
        if row.get("error"):
            warnings.append(f"{row.get('filename')} / {row.get('variable')}: {row.get('error')}")
    return warnings


def _map_ready_variables(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in dataset.get("selectedVariables", []) if item.get("mapReady")]


def _append_candidate(
    candidates: list[dict[str, Any]],
    seen: set[tuple[str, str, int | None, int | None, str]],
    *,
    dataset: dict[str, Any],
    variable: dict[str, Any],
    reason: str,
    max_candidates: int,
) -> None:
    if len(candidates) >= max_candidates:
        return
    time_index = 0 if int(variable.get("timeCount") or 0) > 1 else None
    level_index = 0 if int(variable.get("levelCount") or 0) > 1 else None
    key = (str(dataset["datasetId"]), str(variable["name"]), time_index, level_index, reason)
    if key in seen:
        return
    seen.add(key)
    label = f"{dataset.get('filename')} / {variable['name']}"
    candidates.append(
        {
            "datasetId": dataset["datasetId"],
            "filename": dataset.get("filename"),
            "variable": variable["name"],
            "timeIndex": time_index,
            "levelIndex": level_index,
            "label": label,
            "reason": reason,
            "unit": variable.get("unit"),
            "bounds": variable.get("bounds") or dataset.get("bounds"),
        }
    )


def _priority_index(name: str) -> int:
    normalized = name.casefold()
    for index, candidate in enumerate(PRIORITY_VARIABLES):
        if normalized == candidate:
            return index
    return len(PRIORITY_VARIABLES) + 1


def _require_text(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"模型解读缺少字段：{field}")
    return text


def _string_list(value: Any, field: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"模型解读字段必须是数组：{field}")
    items = [str(item).strip() for item in value if str(item).strip()]
    if not items and not allow_empty:
        raise ValueError(f"模型解读字段为空：{field}")
    return items[:8]
