from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from shared_types.schemas import ArtifactRef


@dataclass
class ToolExecutionResult:
    message: str
    artifact: ArtifactRef | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass
class ExecutionContext:
    run_id: str
    session_id: str
    latest_uploaded_layer_key: str | None
    alias_map: dict[str, dict[str, Any]]
    store: Any
    catalog: Any
    spatial_service: Any
    qgis_runner: Any
    publisher: Any

