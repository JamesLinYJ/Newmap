# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具值引用黑板
#
#   文件:       value_refs.py
#
#   日期:       2026年05月25日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 统一登记和解析工具派生值。集合与产物继续走 collectionRef/artifactId；
# 坐标、bbox、统计量、变量名和时间片等小值走 valueRef。

from __future__ import annotations

import hashlib
import re
from typing import Any, Iterable

from gis_common.ids import now_utc
from shared_types.schemas import ToolValueRef

from .base import ToolRuntime


def make_value_ref_id(kind: str, *parts: Any) -> str:
    # 引用 ID 需要可读且稳定。
    #
    # slug 便于调试，hash 保证中文、符号或长文本场景下仍能稳定去重。
    raw = ":".join(str(part) for part in (kind, *parts) if part is not None and str(part) != "")
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", raw.lower()).strip("_")[:56] or "value"
    return f"value:{slug}:{digest}"


class ToolValueStore:
    # 当前 run 的值黑板写入器。
    #
    # 工具 handler 只通过这个入口登记值，避免每个工具手写互不兼容的
    # valueRef payload 形状。
    def __init__(self, runtime: ToolRuntime, *, source_tool: str):
        self.runtime = runtime
        self.source_tool = source_tool

    def put(
        self,
        *,
        kind: str,
        label: str,
        value: Any,
        unit: str | None = None,
        ref_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ToolValueRef:
        ref = ToolValueRef(
            ref_id=ref_id or make_value_ref_id(kind, self.source_tool, label),
            kind=kind,
            label=label,
            value=value,
            unit=unit,
            source_tool=self.source_tool,
            metadata=metadata or {},
            created_at=now_utc(),
        )
        remember_value_ref(self.runtime, ref)
        return ref

    def put_many(self, refs: Iterable[ToolValueRef]) -> list[ToolValueRef]:
        remembered: list[ToolValueRef] = []
        for ref in refs:
            remember_value_ref(self.runtime, ref)
            remembered.append(ref)
        return remembered


def remember_value_ref(runtime: ToolRuntime, ref: ToolValueRef) -> ToolValueRef:
    runtime.state.value_map[ref.ref_id] = ref
    runtime.state.latest_value_ref = ref.ref_id
    if ref.kind == "coordinate":
        runtime.state.latest_coordinate_ref = ref.ref_id
    elif ref.kind == "bbox":
        runtime.state.latest_bbox_ref = ref.ref_id
    return ref


def resolve_value_ref(runtime: ToolRuntime, ref_id: str, *, expected_kinds: set[str] | None = None) -> ToolValueRef:
    return resolve_value_ref_from_map(runtime.state.value_map, ref_id, expected_kinds=expected_kinds)


def resolve_value_ref_from_map(
    value_map: dict[str, ToolValueRef],
    ref_id: str,
    *,
    expected_kinds: set[str] | None = None,
) -> ToolValueRef:
    ref = value_map.get(ref_id)
    if ref is None:
        raise ValueError(f"工具值引用不存在：{ref_id}")
    if expected_kinds and ref.kind not in expected_kinds:
        expected = " / ".join(sorted(expected_kinds))
        raise ValueError(f"工具值引用类型不匹配：{ref_id} 是 {ref.kind}，需要 {expected}")
    return ref


def resolve_numeric_arg(
    runtime: ToolRuntime,
    args: dict[str, Any],
    *,
    value_key: str,
    ref_key: str,
    required: bool = True,
) -> float | None:
    ref_id = _extract_ref_id(args.get(ref_key))
    if ref_id:
        value = resolve_value_ref(runtime, ref_id, expected_kinds={"number", "statistic", "threshold"}).value
        return _coerce_numeric(value, ref_id=ref_id)
    if args.get(value_key) is None:
        if required:
            raise ValueError(f"缺少数值参数：{value_key} 或 {ref_key}")
        return None
    return float(args[value_key])


def resolve_coordinate_arg(
    runtime: ToolRuntime,
    args: dict[str, Any],
    *,
    ref_key: str,
    lat_key: str,
    lng_key: str,
    required: bool = True,
) -> tuple[float, float, str | None]:
    ref_id = _extract_ref_id(args.get(ref_key))
    if ref_id:
        ref = resolve_value_ref(runtime, ref_id, expected_kinds={"coordinate"})
        lat, lng, label = _coerce_coordinate_value(ref.value, ref_id=ref_id)
        return lat, lng, label or ref.label
    if args.get(lat_key) is None or args.get(lng_key) is None:
        if required:
            raise ValueError(f"缺少坐标参数：{ref_key} 或 {lat_key}/{lng_key}")
        return 0.0, 0.0, None
    return float(args[lat_key]), float(args[lng_key]), None


def resolve_json_value_refs(runtime: ToolRuntime, value: Any) -> Any:
    return resolve_json_value_refs_from_map(runtime.state.value_map, value)


def resolve_json_value_refs_from_map(value_map: dict[str, ToolValueRef], value: Any) -> Any:
    # JSON 参数中的 {"valueRef": "..."} 是唯一隐式解析形式。
    #
    # 普通字符串不按 valueRef 猜测，避免把业务文本误当引用。
    if isinstance(value, dict):
        ref_id = _extract_structured_ref_id(value)
        if ref_id:
            return resolve_value_ref_from_map(value_map, ref_id).value
        return {key: resolve_json_value_refs_from_map(value_map, item) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_json_value_refs_from_map(value_map, item) for item in value]
    return value


def serialize_value_refs_for_model(refs: Iterable[ToolValueRef]) -> list[dict[str, Any]]:
    # 给模型看的只是一组可传递引用，不暴露真实数值。
    #
    # 真实值留在 runtime.value_map 和 run snapshot 里，由工具层解析。
    payload: list[dict[str, Any]] = []
    for ref in refs:
        payload.append(
            {
                "refId": ref.ref_id,
                "kind": ref.kind,
                "label": ref.label,
                "unit": ref.unit,
                "metadata": ref.metadata,
            }
        )
    return payload


def _extract_ref_id(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        candidate = value.get("valueRef") or value.get("value_ref") or value.get("refId") or value.get("ref_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _extract_structured_ref_id(value: dict[str, Any]) -> str | None:
    ref_keys = {"valueRef", "value_ref", "refId", "ref_id"}
    if not set(value).issubset(ref_keys):
        return None
    return _extract_ref_id(value)


def _coerce_numeric(value: Any, *, ref_id: str) -> float:
    candidate = value.get("value") if isinstance(value, dict) and "value" in value else value
    try:
        return float(candidate)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"工具值引用不是数值：{ref_id}") from exc


def _coerce_coordinate_value(value: Any, *, ref_id: str) -> tuple[float, float, str | None]:
    if isinstance(value, dict):
        lat = value.get("lat", value.get("latitude"))
        lng = value.get("lng", value.get("lon", value.get("longitude")))
        label = value.get("label")
        if lat is not None and lng is not None:
            return float(lat), float(lng), str(label) if label is not None else None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        # 列表坐标按 GeoJSON 常用顺序 [lng, lat] 解析。
        return float(value[1]), float(value[0]), None
    raise ValueError(f"工具值引用不是坐标：{ref_id}")
