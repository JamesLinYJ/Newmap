# +-------------------------------------------------------------------------
#
#   地理智能平台 - 共享数据结构定义
#
#   文件:       schemas.py
# 
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


# 命名转换
#
# 后端内部保持 snake_case，接口层统一输出 camelCase。
def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
    )


class EventType(str, Enum):
    # 运行事件类型
    #
    # 用于 API 事件流、持久化事件日志和前端调试页统一消费。
    INTENT_PARSED = "intent.parsed"
    PLAN_READY = "plan.ready"
    STEP_STARTED = "step.started"
    STEP_COMPLETED = "step.completed"
    ARTIFACT_CREATED = "artifact.created"
    WARNING_RAISED = "warning.raised"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"


class ClarificationOption(CamelModel):
    label: str
    description: str


class UserIntent(CamelModel):
    area: str | None = None
    task_type: str | None = None
    distance_m: float | None = None
    publish_requested: bool = False
    target_layers: list[str] = Field(default_factory=list)
    spatial_constraints: list[str] = Field(default_factory=list)
    desired_outputs: list[str] = Field(default_factory=list)
    uncertainty_flags: list[str] = Field(default_factory=list)
    clarification_required: bool = False
    clarification_question: str | None = None
    clarification_options: list[ClarificationOption] = Field(default_factory=list)


class PlanStep(CamelModel):
    id: str
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    reason: str


class ExecutionPlan(CamelModel):
    goal: str
    steps: list[PlanStep] = Field(default_factory=list)


class ToolCall(CamelModel):
    step_id: str
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    status: str
    message: str
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ArtifactRef(CamelModel):
    artifact_id: str
    run_id: str
    artifact_type: str
    name: str
    uri: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentFinalResponse(CamelModel):
    summary: str
    limitations: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)


class LayerDescriptor(CamelModel):
    layer_key: str
    name: str
    source_type: str
    geometry_type: str
    srid: int = 4326
    description: str
    feature_count: int | None = None
    tags: list[str] = Field(default_factory=list)


class BasemapDescriptor(CamelModel):
    basemap_key: str
    name: str
    provider: str
    kind: str
    attribution: str = ""
    tile_urls: list[str] = Field(default_factory=list)
    label_tile_urls: list[str] = Field(default_factory=list)
    available: bool = True
    is_default: bool = False


class PublishRequest(CamelModel):
    project_key: str | None = "demo-workspace"

    @field_validator("project_key")
    @classmethod
    def validate_project_key(cls, value: str | None) -> str | None:
        if value is None:
            return value
        candidate = value.strip()
        if not candidate:
            return None
        if not candidate.replace("-", "").replace("_", "").isalnum():
            raise ValueError("projectKey 只能包含字母、数字、短横线和下划线。")
        if candidate in {".", ".."} or "/" in candidate or "\\" in candidate:
            raise ValueError("projectKey 不能包含路径分隔符。")
        return candidate


class RunEvent(CamelModel):
    event_id: str
    run_id: str
    type: EventType
    message: str
    timestamp: datetime
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentStateModel(CamelModel):
    session_id: str
    user_query: str
    model_provider: str = "demo"
    model_name: str | None = None
    parsed_intent: UserIntent | None = None
    execution_plan: ExecutionPlan | None = None
    current_step: int = 0
    tool_results: list[ToolCall] = Field(default_factory=list)
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    failed_step_id: str | None = None
    failed_tool: str | None = None
    final_response: AgentFinalResponse | None = None


class SessionRecord(CamelModel):
    id: str
    created_at: datetime
    status: str = "active"
    share_token: str
    latest_run_id: str | None = None
    latest_uploaded_layer_key: str | None = None


class AnalysisRunRecord(CamelModel):
    id: str
    session_id: str
    user_query: str
    model_provider: str = "demo"
    model_name: str | None = None
    status: str = "queued"
    created_at: datetime
    updated_at: datetime
    state: AgentStateModel


class ModelProviderDescriptor(CamelModel):
    provider: str
    display_name: str
    configured: bool
    default_model: str | None = None
    capabilities: list[str] = Field(default_factory=list)


class ToolParameterOption(CamelModel):
    label: str
    value: str


class ToolParameterDescriptor(CamelModel):
    key: str
    label: str
    data_type: str
    source: str = "text"
    required: bool = False
    description: str | None = None
    placeholder: str | None = None
    default_value: Any | None = None
    options: list[ToolParameterOption] = Field(default_factory=list)


class ToolDescriptor(CamelModel):
    # 工具描述
    #
    # 这是前后端共享的工具展示与执行元数据结构。
    name: str
    label: str
    description: str
    group: str
    tool_kind: str = "registry"
    available: bool = True
    tags: list[str] = Field(default_factory=list)
    parameters: list[ToolParameterDescriptor] = Field(default_factory=list)
    error: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class SystemComponentsStatus(CamelModel):
    # 系统组件状态
    #
    # 汇总 catalog、QGIS、OGC API 与模型 provider 的当前可用性。
    catalog_backend: str
    postgis_enabled: bool
    qgis_runtime_available: bool
    qgis_server_available: bool
    ogc_api_available: bool
    publish_capabilities: list[str] = Field(default_factory=list)
    qgis_server_base_url: str
    providers: list[ModelProviderDescriptor] = Field(default_factory=list)
