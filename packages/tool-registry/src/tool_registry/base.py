# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具运行时基础类型
#
#   文件:       base.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 定义工具元数据、执行结果与运行时上下文的基础数据结构。

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from shared_types.schemas import ArtifactRef, ToolValueRef


# ToolExecutionResult
#
# 单次工具调用的标准返回对象。
@dataclass
class ToolExecutionResult:
    message: str
    artifact: ArtifactRef | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    result_id: str | None = None
    source: str | None = None
    confidence: float | None = None
    used_query: str | None = None
    provenance: dict[str, Any] = field(default_factory=dict)
    crs: dict[str, Any] = field(default_factory=dict)
    geometry_type: str | None = None
    feature_count: int | None = None
    value_refs: list[ToolValueRef] = field(default_factory=list)


@dataclass(frozen=True)
class ToolRuntimeContext:
    # 不可变运行上下文。
    run_id: str
    thread_id: str | None
    session_id: str
    latest_uploaded_layer_key: str | None


@dataclass
class ToolRuntimeState:
    # 当前 run 的可变状态。
    alias_map: dict[str, dict[str, Any]] = field(default_factory=dict)
    value_map: dict[str, ToolValueRef] = field(default_factory=dict)
    latest_collection_ref: str | None = None
    latest_artifact_id: str | None = None
    latest_value_ref: str | None = None
    latest_coordinate_ref: str | None = None
    latest_bbox_ref: str | None = None


@dataclass(frozen=True)
class ToolRuntimeStore:
    # 工具执行可访问的持久化依赖集合。
    platform_store: Any
    layer_repository: Any
    artifact_export_store: Any
    spatial_service: Any
    runtime_root: Path
    weather_service: Any = None


@dataclass
class ToolRuntime:
    # 工具运行时容器。
    context: ToolRuntimeContext
    state: ToolRuntimeState
    store: ToolRuntimeStore


class ToolArgsModel(BaseModel):
    model_config = {"populate_by_name": True}
