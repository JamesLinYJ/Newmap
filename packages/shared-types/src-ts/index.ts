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

export interface ArtifactRef {
  artifactId: string
  runId: string
  artifactType: string
  name: string
  uri: string
  metadata: Record<string, unknown>
}

export interface RunEvent {
  eventId: string
  runId: string
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
  userQuery: string
  modelProvider: string
  modelName?: string | null
  parsedIntent?: UserIntent
  executionPlan?: ExecutionPlan
  currentStep: number
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
  latestRunId?: string | null
  latestUploadedLayerKey?: string | null
}

export interface AnalysisRun {
  id: string
  sessionId: string
  userQuery: string
  modelProvider: string
  modelName?: string | null
  status: 'queued' | 'running' | 'clarification_needed' | 'completed' | 'failed'
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
