// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端共享类型定义
//
//   文件:       index.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

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
  | 'loop.updated'
  | 'todo.updated'
  | 'tool.started'
  | 'tool.completed'
  | 'approval.required'
  | 'warning.raised'
  | 'run.completed'
  | 'run.failed'

export interface ClarificationOption {
  label: string
  description: string
}

export interface UserIntent {
  area?: string | null
  taskType?: string | null
  distanceM?: number | null
  publishRequested: boolean
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

export interface RuntimeContextConfig {
  memoryFilePaths: string[]
  historyRunLimit: number
  eventWindow: number
  toolCallWindow: number
  artifactWindow: number
  warningWindow: number
}

export interface AgentRuntimeConfig {
  defaultPublishProjectKey: string
  loopTraceLimit: number
  supervisor: SupervisorRuntimeConfig
  subAgents: RuntimeSubAgentConfig[]
  ui: RuntimeUiConfig
  context: RuntimeContextConfig
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
  tags?: string[]
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
