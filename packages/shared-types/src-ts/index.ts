// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端共享类型定义
//
//   文件:       index.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 定义前端消费的共享类型，保持与 Python schemas 语义一致。

// 共享前端类型定义
//
// 与 Python 侧 shared_types.schemas 保持语义一致，供 Web 端直接消费接口数据。
export type EventType =
  | 'intent.parsed'
  | 'plan.ready'
  | 'step.started'
  | 'step.completed'
  | 'artifact.created'
  | 'subagent.created'
  | 'subagent.updated'
  | 'message.delta'
  | 'thinking.delta'
  | 'loop.updated'
  | 'todo.updated'
  | 'tool.started'
  | 'tool.completed'
  | 'approval.required'
  | 'warning.raised'
  | 'run.completed'
  | 'run.failed'

export interface ClarificationOption {
  optionId?: string | null
  label: string
  description: string
  kind?: string
  reason?: string | null
  payload?: Record<string, unknown>
}

export interface ClarificationState {
  clarificationId: string
  kind: string
  reason: string
  question: string
  options: ClarificationOption[]
  selectedOptionId?: string | null
  allowFreeText: boolean
}

export interface PlaceSearchCandidate {
  label: string
  displayName?: string | null
  country?: string | null
  latitude?: number | null
  longitude?: number | null
  boundingbox?: Array<string | number> | null
  source?: string | null
}

export interface PlaceResolution {
  status: 'unresolved' | 'resolved' | 'ambiguous' | 'not_found' | 'failed'
  query?: string | null
  provider?: string | null
  selected?: PlaceSearchCandidate | null
  candidates: PlaceSearchCandidate[]
  error?: string | null
}

export interface UserIntent {
  area?: string | null
  placeQuery?: string | null
  anchorType: 'admin_area' | 'poi' | 'uploaded_layer' | 'unknown'
  taskType?: string | null
  distanceM?: number | null
  publishRequested: boolean
  dataRequirements: string[]
  targetLayers: string[]
  spatialConstraints: string[]
  desiredOutputs: string[]
  uncertaintyFlags: string[]
  clarificationRequired: boolean
  clarificationQuestion?: string | null
  clarificationOptions?: ClarificationOption[]
}

export interface PlanStep {
  id: string
  tool: string
  args: Record<string, unknown>
  reason: string
}

export interface ExecutionPlan {
  goal: string
  steps: PlanStep[]
}

export interface ToolCall {
  stepId: string
  tool: string
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed'
  message: string
  startedAt?: string
  completedAt?: string | null
  resultId?: string | null
  source?: string | null
  confidence?: number | null
  usedQuery?: string | null
  provenance?: Record<string, unknown>
  crs?: Record<string, unknown>
  geometryType?: string | null
  featureCount?: number | null
}

export interface ContextReference {
  referenceId: string
  kind: string
  label: string
  description: string
  sourceRunId?: string | null
  artifactId?: string | null
  collectionRef?: string | null
  layerKey?: string | null
  confidence?: number | null
  usableAs: string[]
  metadata: Record<string, unknown>
}

export interface ContextResolution {
  status: string
  query?: string | null
  selectedReferenceId?: string | null
  selectedKind?: string | null
  sourceRunId?: string | null
  reason?: string | null
  candidates: ContextReference[]
}

export interface RunLifecycle {
  status: 'created' | 'running' | 'waiting_clarification' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | string
  reason?: string | null
  updatedAt?: string | null
}

export interface TodoItem {
  todoId: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  description?: string | null
  ownerAgentId?: string | null
  stepId?: string | null
}

export interface SubAgentState {
  agentId: string
  name: string
  role: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  summary: string
  stepIds: string[]
  tools: string[]
  currentStepId?: string | null
  latestMessage?: string | null
}

export interface ApprovalRequest {
  approvalId: string
  action: string
  title: string
  description: string
  status: 'pending' | 'approved' | 'rejected'
  artifactId?: string | null
  payload: Record<string, unknown>
  createdAt: string
  resolvedAt?: string | null
}

export interface ArtifactRef {
  artifactId: string
  runId: string
  artifactType: string
  name: string
  uri: string
  metadata: Record<string, unknown>
}

export interface RuntimeSubAgentConfig {
  agentId: string
  name: string
  role: string
  summary: string
  systemPrompt?: string | null
  tools: string[]
}

export interface SupervisorRuntimeConfig {
  name: string
  systemPrompt: string
  approvalInterruptTools: string[]
}

export interface RuntimeUiConfig {
  transcriptMaxEntries: number
  showInternalReasoningLabels: boolean
  eventGroupingWindowMs: number
}

export interface RuntimeCatalogConfig {
  allowEmptyCatalog: boolean
  adminEnabled: boolean
}

export interface RuntimeContextConfig {
  memoryFilePaths: string[]
  historyRunLimit: number
  eventWindow: number
  toolCallWindow: number
  artifactWindow: number
  warningWindow: number
}

export interface RuntimeGeosearchConfig {
  provider: string
  enabled: boolean
  baseUrl: string
  userAgent: string
  timeoutMs: number
  maxCandidates: number
}

export interface RuntimePoiConfig {
  provider: string
  enabled: boolean
  baseUrl: string
  userAgent: string
  timeoutMs: number
  maxResults: number
}

export interface RuntimePlanningConfig {
  maxPlanRepairRounds: number
  allowTextOnlyDelivery: boolean
  externalSourcePriority: string[]
}

export interface AgentRuntimeConfig {
  defaultPublishProjectKey: string
  loopTraceLimit: number
  supervisor: SupervisorRuntimeConfig
  subAgents: RuntimeSubAgentConfig[]
  ui: RuntimeUiConfig
  catalog: RuntimeCatalogConfig
  planning: RuntimePlanningConfig
  context: RuntimeContextConfig
  geosearch: RuntimeGeosearchConfig
  externalPoi: RuntimePoiConfig
}

export interface LoopTraceEntry {
  iteration: number
  phase: string
  title: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  timestamp: string
  agentId?: string | null
  toolName?: string | null
  stepId?: string | null
}

export interface RunEvent {
  eventId: string
  runId: string
  threadId?: string | null
  type: EventType
  message: string
  timestamp: string
  payload?: Record<string, unknown>
}

export interface LayerDescriptor {
  layerKey: string
  name: string
  sourceType: string
  geometryType: string
  srid: number
  description: string
  featureCount?: number
  category: string
  status: string
  tags: string[]
  analysisCapabilities: string[]
  sourceConfigSummary?: string | null
  sessionId?: string | null
}

export interface BasemapDescriptor {
  basemapKey: string
  name: string
  provider: string
  kind: string
  attribution: string
  tileUrls: string[]
  labelTileUrls: string[]
  available: boolean
  isDefault: boolean
}

export interface PublishRequest {
  projectKey?: string
}

export interface AgentState {
  sessionId: string
  threadId?: string | null
  userQuery: string
  modelProvider?: string | null
  modelName?: string | null
  parsedIntent?: UserIntent
  clarification?: ClarificationState | null
  placeResolution?: PlaceResolution | null
  contextReferences?: ContextReference[]
  contextResolution?: ContextResolution | null
  runLifecycle?: RunLifecycle
  executionPlan?: ExecutionPlan
  currentStep: number
  loopIteration: number
  loopPhase: string
  loopTrace: LoopTraceEntry[]
  todos: TodoItem[]
  subAgents: SubAgentState[]
  approvals: ApprovalRequest[]
  toolResults: ToolCall[]
  artifacts: ArtifactRef[]
  selectedDataSources: string[]
  planRepairAttempts: number
  textOnlyDelivery: boolean
  warnings: string[]
  errors: string[]
  failedStepId?: string | null
  failedTool?: string | null
  finalResponse?: {
    summary: string
    limitations: string[]
    nextActions: string[]
  }
}

export interface SessionRecord {
  id: string
  createdAt: string
  status: string
  shareToken: string
  latestThreadId?: string | null
  latestRunId?: string | null
  latestUploadedLayerKey?: string | null
}

export interface AgentThreadRecord {
  id: string
  sessionId: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
  latestRunId?: string | null
  latestUserQuery?: string | null
  latestAssistantSummary?: string | null
  latestRunStatus?: string | null
  latestArtifactId?: string | null
  latestArtifactName?: string | null
  historyPreview?: string | null
  runCount: number
}

export interface AnalysisRun {
  id: string
  threadId?: string | null
  sessionId: string
  userQuery: string
  modelProvider?: string | null
  modelName?: string | null
  status: 'queued' | 'running' | 'clarification_needed' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  state: AgentState
}

export interface ModelProviderDescriptor {
  provider: string
  displayName: string
  configured: boolean
  defaultModel?: string | null
  capabilities: string[]
}

export interface ToolParameterOption {
  label: string
  value: string
}

export interface ToolParameterDescriptor {
  key: string
  label: string
  dataType: string
  source: string
  required: boolean
  description?: string | null
  placeholder?: string | null
  defaultValue?: unknown
  options: ToolParameterOption[]
}

export interface ToolDescriptor {
  name: string
  label: string
  description: string
  group: string
  toolKind: string
  available: boolean
  tags: string[]
  parameters: ToolParameterDescriptor[]
  error?: string | null
  meta: Record<string, unknown>
}

export interface SystemComponentsStatus {
  catalogBackend: string
  postgisEnabled: boolean
  qgisRuntimeAvailable: boolean
  qgisServerAvailable: boolean
  ogcApiAvailable: boolean
  publishCapabilities: string[]
  qgisServerBaseUrl: string
  providers: ModelProviderDescriptor[]
}

export interface QgisModelsResponse {
  available: boolean
  models: string[]
  error?: string
}
