# +-------------------------------------------------------------------------
#
#   地理智能平台 - 共享数据结构定义
#
#   文件:       schemas.py
# 
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 集中定义跨前后端共享的数据模型、事件类型和运行态结构。

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


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
    SUBAGENT_CREATED = "subagent.created"
    SUBAGENT_UPDATED = "subagent.updated"
    MESSAGE_DELTA = "message.delta"
    THINKING_DELTA = "thinking.delta"
    LOOP_UPDATED = "loop.updated"
    TODO_UPDATED = "todo.updated"
    TOOL_STARTED = "tool.started"
    TOOL_COMPLETED = "tool.completed"
    CLARIFICATION_REQUIRED = "clarification.required"
    APPROVAL_REQUIRED = "approval.required"
    WARNING_RAISED = "warning.raised"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"


class ClarificationOption(CamelModel):
    option_id: str | None = None
    label: str
    description: str
    kind: str = "generic"
    reason: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class ClarificationState(CamelModel):
    clarification_id: str
    kind: str = "generic"
    reason: str = "generic"
    question: str
    options: list[ClarificationOption] = Field(default_factory=list)
    selected_option_id: str | None = None
    allow_free_text: bool = True


class PlaceSearchCandidate(CamelModel):
    label: str
    display_name: str | None = None
    country: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    boundingbox: list[str] | list[float] | None = None
    source: str | None = None


class PlaceResolution(CamelModel):
    status: str = "unresolved"
    query: str | None = None
    provider: str | None = None
    selected: PlaceSearchCandidate | None = None
    candidates: list[PlaceSearchCandidate] = Field(default_factory=list)
    error: str | None = None


class UserIntent(CamelModel):
    area: str | None = None
    place_query: str | None = None
    anchor_type: str = "unknown"
    task_type: str | None = None
    distance_m: float | None = None
    publish_requested: bool = False
    data_requirements: list[str] = Field(default_factory=list)
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


class ToolValueRef(CamelModel):
    # 工具值引用
    #
    # 坐标、bbox、阈值、统计量等工具派生值统一进入运行时黑板；
    # 后续工具只传 ref_id，由工具层解析真实值，避免模型手抄数值。
    ref_id: str
    kind: str
    label: str
    value: Any
    unit: str | None = None
    source_tool: str | None = None
    source_result_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class ToolCall(CamelModel):
    step_id: str
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    status: str
    message: str
    started_at: datetime | None = None
    completed_at: datetime | None = None
    result_id: str | None = None
    source: str | None = None
    confidence: float | None = None
    used_query: str | None = None
    provenance: dict[str, Any] = Field(default_factory=dict)
    crs: dict[str, Any] = Field(default_factory=dict)
    geometry_type: str | None = None
    feature_count: int | None = None
    value_refs: list[ToolValueRef] = Field(default_factory=list)


class ContextReference(CamelModel):
    # 上下文引用候选
    #
    # 代码只负责列出当前 thread 中真实存在、可被工具引用的对象；
    # 具体“这个”指哪个候选，由 Agent 选择后再交给 Validator 校验。
    reference_id: str
    kind: str
    label: str
    description: str = ""
    source_run_id: str | None = None
    artifact_id: str | None = None
    collection_ref: str | None = None
    layer_key: str | None = None
    confidence: float | None = None
    usable_as: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ContextResolution(CamelModel):
    status: str = "unresolved"
    query: str | None = None
    selected_reference_id: str | None = None
    selected_kind: str | None = None
    source_run_id: str | None = None
    reason: str | None = None
    candidates: list[ContextReference] = Field(default_factory=list)


class ContextEntryRecord(CamelModel):
    # 上下文索引条目
    #
    # JSONL 会话日志中的 context_entry 是 Agent prompt 上下文的事实源；
    # run/event 只负责执行快照和实时叙事，不再被运行时临时扫描拼接。
    context_entry_id: str
    session_id: str
    thread_id: str
    source_run_id: str | None = None
    kind: str
    label: str
    summary: str
    reference: ContextReference | None = None
    search_text: str = ""
    created_at: datetime
    updated_at: datetime


class ThreadContextRecord(CamelModel):
    # 线程上下文快照
    #
    # 保存线程级有界摘要和上下文统计，供 supervisor prompt 快速恢复任务背景。
    thread_id: str
    session_id: str
    summary_text: str = ""
    entry_count: int = 0
    payload: dict[str, Any] = Field(default_factory=dict)
    updated_at: datetime


class AgentSessionLogRecord(CamelModel):
    # Agent 会话日志行
    #
    # 持久化文件每行只允许 timestamp/type/payload 三个顶层字段；
    # 具体 run、event、context 快照都进入 payload。
    timestamp: datetime
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class RunLifecycle(CamelModel):
    status: str = "created"
    reason: str | None = None
    updated_at: datetime | None = None


class TodoItem(CamelModel):
    todo_id: str
    title: str
    status: str = "pending"
    description: str | None = None
    activeForm: str | None = None
    """当前进度的动态描述，如"正在处理数据..."，用于前端实时展示。"""
    owner_agent_id: str | None = None
    step_id: str | None = None


class TaskRecord(CamelModel):
    """后台任务记录 — Agent 异步任务的元数据。

    由 task_create / task_list / task_update 工具管理。
    任务的业务结果由 Agent 在执行完成后写回最终消息。
    """
    task_id: str
    agent_type: str
    """子智能体类型标识，如 spatial_analyst、weather_analyst。"""
    prompt: str
    """任务描述 / 要执行的指令文本。"""
    status: str = "pending"
    """pending / in_progress / completed / failed"""
    created_at: datetime
    updated_at: datetime | None = None
    result_summary: str | None = None
    """任务完成时的简短结论摘要。"""


class SubAgentState(CamelModel):
    agent_id: str
    name: str
    role: str
    status: str = "pending"
    summary: str
    step_ids: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    current_step_id: str | None = None
    latest_message: str | None = None


class ApprovalRequest(CamelModel):
    approval_id: str
    action: str
    title: str
    description: str
    status: str = "pending"
    artifact_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    resolved_at: datetime | None = None


class ArtifactRef(CamelModel):
    artifact_id: str
    run_id: str
    artifact_type: str
    name: str
    uri: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    is_intermediate: bool = False


class WeatherDatasetRecord(CamelModel):
    # 气象数据集事实
    #
    # 原始文件保存在 runtime/weather，数据库只保存解析状态和轻量 metadata，
    # 避免把多维数组塞进平台业务表。
    dataset_id: str
    session_id: str
    thread_id: str
    filename: str
    status: str = "uploaded"
    storage_relative_path: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class WeatherJobRecord(CamelModel):
    # 气象后台任务事实
    #
    # worker 只认 job 状态推进；API 和前端通过这份记录观察解析进度。
    job_id: str
    dataset_id: str
    thread_id: str
    job_type: str = "parse"
    status: str = "queued"
    payload: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class AgentFinalResponse(CamelModel):
    summary: str
    limitations: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)


class RuntimeSubAgentConfig(CamelModel):
    agent_id: str
    name: str
    role: str
    summary: str
    system_prompt: str | None = None
    tools: list[str] = Field(default_factory=list)


class PermissionRuleEntry(CamelModel):
    """权限规则配置条目

    tool_pattern 支持通配符 *，如 "geocode_*" 匹配所有 geocode 开头的工具。
    decision 取值: 'always_allow' | 'always_deny' | 'always_ask'
    """
    tool_pattern: str
    """工具名或前缀匹配模式，支持 * 通配符。"""
    decision: str
    """决策: 'always_allow'（永远允许）| 'always_deny'（永远拒绝）| 'always_ask'（始终询问）"""
    priority: int = 0
    """优先级，数字越小越优先。"""
    description: str = ""
    """规则说明。"""


class HookConfigEntry(CamelModel):
    """Hook 配置条目

    对应 HookHandler 的配置化表示，可从 YAML 或 JSON 配置加载。
    """
    event_type: str
    """Hook 事件类型字符串，如 "pre_tool_use"。"""
    command_type: str = "command"
    """执行方式: 'command' | 'prompt'。"""
    command: str
    """shell 命令或 prompt 文本。"""
    matcher: dict[str, str] = Field(default_factory=dict)
    """匹配条件，如 {"tool_name": "geocode_place"}。"""
    priority: int = 0
    """优先级，数字越小越优先执行。"""
    description: str = ""
    """可读描述。"""
    timeout_seconds: int = 30
    """命令执行超时秒数，仅对 command 类型有效。"""


class SupervisorRuntimeConfig(CamelModel):
    name: str = "geo_agent_supervisor"
    system_prompt: str = ""
    approval_interrupt_tools: list[str] = Field(default_factory=list)
    permission_rules: list[PermissionRuleEntry] = Field(default_factory=list)
    """分层权限规则列表，按决策链 AlwaysDeny→AlwaysAllow→AlwaysAsk 顺序求值。"""


class RuntimeUiConfig(CamelModel):
    transcript_max_entries: int = 40
    show_internal_reasoning_labels: bool = True
    event_grouping_window_ms: int = 1500


class RuntimeCatalogConfig(CamelModel):
    allow_empty_catalog: bool = True
    admin_enabled: bool = True


class RuntimeContextConfig(CamelModel):
    memory_file_paths: list[str] = Field(default_factory=lambda: ["/AGENTS.md", "/THREAD_CONTEXT.md"])
    history_run_limit: int = 4
    event_window: int = 24
    tool_call_window: int = 8
    artifact_window: int = 6
    warning_window: int = 6
    prompt_max_chars: int = 12000
    context_entry_window: int = 18
    memory_file_char_limit: int = 4000
    memory_enabled: bool = True
    """是否启用记忆系统。关闭后将不会加载 MEMORY.md 索引，也不会注入 memory_mechanics prompt。"""
    memory_base_dir: str = ".geoagent/memory"
    """记忆存储基础目录（相对 project_root）。Agent 持久化记忆文件的根路径。"""


class RuntimeGeosearchConfig(CamelModel):
    provider: str = "nominatim"
    enabled: bool = True
    base_url: str = "https://nominatim.openstreetmap.org"
    user_agent: str = "geo-agent-platform/0.1"
    timeout_ms: int = 2500
    max_candidates: int = 5


class RuntimePoiConfig(CamelModel):
    provider: str = "overpass"
    enabled: bool = True
    base_url: str = "https://overpass-api.de/api/interpreter"
    user_agent: str = "geo-agent-platform/0.1"
    timeout_ms: int = 8000
    max_results: int = 200


class RuntimeNowcastConfig(CamelModel):
    # 短临领域配置。
    #
    # 这里保存产品口径和默认分析边界，不保存任何区县、坐标或回答模板；
    # 具体事实必须来自 NC 产品、边界图层和工具分析结果。
    default_city_name: str = "杭州市"
    forecast_horizon_minutes: int = 180
    point_buffer_meters: float = 1000
    district_layer_key: str | None = None
    district_name_field: str | None = None
    rain_level_thresholds: dict[str, float] = Field(
        default_factory=lambda: {"none": 0.1, "light": 2.5, "moderate": 8.0, "heavy": 16.0}
    )
    candidate_limit: int = 12


class RuntimePlanningConfig(CamelModel):
    max_plan_repair_rounds: int = 2
    allow_text_only_delivery: bool = True
    external_source_priority: list[str] = Field(default_factory=lambda: ["catalog", "external_poi", "geosearch"])


class AgentRuntimeConfig(CamelModel):
    loop_trace_limit: int = 80
    max_turns: int = 50
    """Agent 运行最大轮次。超出后强制终止，防止无限循环。"""
    supervisor: SupervisorRuntimeConfig = Field(default_factory=SupervisorRuntimeConfig)
    sub_agents: list[RuntimeSubAgentConfig] = Field(default_factory=list)
    ui: RuntimeUiConfig = Field(default_factory=RuntimeUiConfig)
    catalog: RuntimeCatalogConfig = Field(default_factory=RuntimeCatalogConfig)
    planning: RuntimePlanningConfig = Field(default_factory=RuntimePlanningConfig)
    context: RuntimeContextConfig = Field(default_factory=RuntimeContextConfig)
    geosearch: RuntimeGeosearchConfig = Field(default_factory=RuntimeGeosearchConfig)
    external_poi: RuntimePoiConfig = Field(default_factory=RuntimePoiConfig)
    nowcast: RuntimeNowcastConfig = Field(default_factory=RuntimeNowcastConfig)
    hook_configs: list[HookConfigEntry] = Field(default_factory=list)
    """Hook 配置列表，运行时加载到 AgentHookManager。"""


class LoopTraceEntry(CamelModel):
    iteration: int
    phase: str
    title: str
    description: str
    status: str = "running"
    timestamp: datetime
    agent_id: str | None = None
    tool_name: str | None = None
    step_id: str | None = None


class LayerPropertyDescriptor(CamelModel):
    # 图层字段摘要
    #
    # 图层管理面板只展示字段事实，不拉取完整要素集合，避免目录列表成为隐式数据下载接口。
    name: str
    data_type: str
    populated_count: int = 0
    sample_values: list[str] = Field(default_factory=list)


class LayerDescriptor(CamelModel):
    # 图层目录事实
    #
    # 这是 API、Agent 上下文和前端图层管理的统一视图；边界和字段概览来自真实落库数据。
    layer_key: str
    name: str
    source_type: str
    geometry_type: str
    srid: int = 4326
    description: str
    feature_count: int | None = None
    bounds: list[float] | None = None
    property_schema: list[LayerPropertyDescriptor] = Field(default_factory=list)
    category: str = "general"
    status: str = "active"
    tags: list[str] = Field(default_factory=list)
    analysis_capabilities: list[str] = Field(default_factory=list)
    source_config_summary: str | None = None
    session_id: str | None = None
    thread_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


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


class RunEvent(CamelModel):
    event_id: str
    run_id: str
    thread_id: str | None = None
    type: EventType
    message: str
    timestamp: datetime
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentStateModel(CamelModel):
    session_id: str
    thread_id: str | None = None
    user_query: str
    model_provider: str | None = None
    model_name: str | None = None
    parsed_intent: UserIntent | None = None
    clarification: ClarificationState | None = None
    place_resolution: PlaceResolution | None = None
    context_references: list[ContextReference] = Field(default_factory=list)
    context_resolution: ContextResolution | None = None
    run_lifecycle: RunLifecycle = Field(default_factory=RunLifecycle)
    execution_plan: ExecutionPlan | None = None
    current_step: int = 0
    loop_iteration: int = 0
    loop_phase: str = "idle"
    loop_trace: list[LoopTraceEntry] = Field(default_factory=list)
    todos: list[TodoItem] = Field(default_factory=list)
    tasks: list[TaskRecord] = Field(default_factory=list)
    """后台异步任务列表，由 task_* 工具管理。"""
    plan_mode: bool = False
    """是否处于计划模式（只读探索），由 enter_plan_mode / exit_plan_mode 控制。"""
    sub_agents: list[SubAgentState] = Field(default_factory=list)
    approvals: list[ApprovalRequest] = Field(default_factory=list)
    tool_results: list[ToolCall] = Field(default_factory=list)
    tool_value_refs: list[ToolValueRef] = Field(default_factory=list)
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    selected_data_sources: list[str] = Field(default_factory=list)
    plan_repair_attempts: int = 0
    text_only_delivery: bool = False
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    failed_step_id: str | None = None
    failed_tool: str | None = None
    final_response: AgentFinalResponse | None = None
    denial_counts: dict[str, int] = Field(default_factory=dict)
    """拒绝追踪计数，键为工具名，值为连续被拒次数。"""
    runtime_stats: dict[str, int] = Field(default_factory=dict)
    """运行时统计：tool_success_count / tool_failure_count / approval_count / hook_block_count"""


class SessionRecord(CamelModel):
    id: str
    created_at: datetime
    status: str = "active"
    share_token: str
    latest_thread_id: str | None = None
    latest_run_id: str | None = None
    latest_uploaded_layer_key: str | None = None
    latest_weather_dataset_id: str | None = None


class AgentThreadRecord(CamelModel):
    id: str
    session_id: str
    title: str
    status: str = "active"
    created_at: datetime
    updated_at: datetime
    latest_run_id: str | None = None
    latest_user_query: str | None = None
    latest_assistant_summary: str | None = None
    latest_run_status: str | None = None
    latest_artifact_id: str | None = None
    latest_artifact_name: str | None = None
    history_preview: str | None = None
    run_count: int = 0
    session_log_path: str | None = None


class AnalysisRunRecord(CamelModel):
    id: str
    thread_id: str | None = None
    session_id: str
    user_query: str
    model_provider: str | None = None
    model_name: str | None = None
    status: str = "queued"
    created_at: datetime
    updated_at: datetime
    state: AgentStateModel
    session_log_path: str | None = None


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
    # 汇总 catalog、PostGIS、会话日志与模型 provider 的当前可用性。
    catalog_backend: str
    postgis_enabled: bool
    session_log_root: str | None = None
    providers: list[ModelProviderDescriptor] = Field(default_factory=list)
