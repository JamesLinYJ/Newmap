# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 请求模型
#
#   文件:       models.py
#
#   日期:       2026年05月07日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 集中定义 API 层所有 Pydantic 请求模型，从 main.py 提取以保持路由文件精简。

from __future__ import annotations

from pydantic import BaseModel, Field


class AnalysisRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    query: str = Field(..., min_length=2, max_length=4000)
    provider: str | None = None
    model: str | None = None
    clarification_option_id: str | None = Field(default=None, alias="clarificationOptionId")


class ThreadCreateRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    title: str | None = None


class ThreadRunRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=4000)
    provider: str | None = None
    model: str | None = None
    clarification_option_id: str | None = Field(default=None, alias="clarificationOptionId")


class ThreadUpdateRequest(BaseModel):
    title: str


class ApprovalResolutionRequest(BaseModel):
    approved: bool


class QgisProcessRequest(BaseModel):
    algorithm_id: str = Field(..., alias="algorithmId")
    inputs: dict[str, object] = Field(default_factory=dict)
    artifact_id: str | None = Field(default=None, alias="artifactId")
    input_parameter_name: str | None = Field(default="INPUT", alias="inputParameterName")
    output_parameter_name: str | None = Field(default="OUTPUT", alias="outputParameterName")
    run_id: str | None = Field(default=None, alias="runId")
    save_as_artifact: bool = Field(default=False, alias="saveAsArtifact")
    result_name: str | None = Field(default=None, alias="resultName")


class QgisModelRequest(BaseModel):
    model_name: str = Field(..., alias="modelName")
    inputs: dict[str, object] = Field(default_factory=dict)
    artifact_id: str | None = Field(default=None, alias="artifactId")
    input_parameter_name: str | None = Field(default="INPUT", alias="inputParameterName")
    output_parameter_name: str | None = Field(default="output", alias="outputParameterName")
    run_id: str | None = Field(default=None, alias="runId")
    save_as_artifact: bool = Field(default=False, alias="saveAsArtifact")
    result_name: str | None = Field(default=None, alias="resultName")


class ToolRunRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    tool_name: str = Field(..., alias="toolName")
    tool_kind: str = Field(default="registry", alias="toolKind")
    run_id: str | None = Field(default=None, alias="runId")
    args: dict[str, object] = Field(default_factory=dict)


class ToolCatalogEntryUpsertRequest(BaseModel):
    payload: dict[str, object] = Field(default_factory=dict)
    sort_order: int | None = Field(default=None, alias="sortOrder")


class LayerCreateRequest(BaseModel):
    name: str
    description: str = ""
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    status: str = "active"
    analysis_capabilities: list[str] = Field(default_factory=list, alias="analysisCapabilities")
    source_type: str = Field(default="managed", alias="sourceType")
    source_config_summary: str | None = Field(default=None, alias="sourceConfigSummary")
    geojson: dict[str, object]


class LayerUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    status: str | None = None
    analysis_capabilities: list[str] | None = Field(default=None, alias="analysisCapabilities")
    source_config_summary: str | None = Field(default=None, alias="sourceConfigSummary")
