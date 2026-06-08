// +-------------------------------------------------------------------------
//
//   地理智能平台 - Zod 共享类型（自动推导 TS 类型）
//
//   文件:       types.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { z } from 'zod'

// --- Enums ---

export const eventTypeSchema = z.enum([
  'intent.parsed', 'plan.ready', 'step.started', 'step.completed',
  'artifact.created', 'subagent.created', 'subagent.updated',
  'loop.updated', 'todo.updated', 'tool.started', 'tool.completed',
  'clarification.required', 'approval.required', 'warning.raised',
  'run.completed', 'run.failed',
])

export const runStatusSchema = z.enum([
  'queued', 'running', 'clarification_needed', 'waiting_approval',
  'completed', 'failed', 'cancelled',
])

export const todoStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'blocked'])

export const conversationItemTypeSchema = z.enum([
  'message', 'reasoning', 'function_call', 'function_call_output', 'result', 'error',
])

// --- Core Models ---

export const clarificationOptionSchema = z.object({
  optionId: z.string().nullable().default(null),
  label: z.string(),
  description: z.string().default(''),
  kind: z.string().default('generic'),
  reason: z.string().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
})

export const clarificationStateSchema = z.object({
  clarificationId: z.string(),
  kind: z.string().default('generic'),
  reason: z.string().default('generic'),
  question: z.string(),
  options: z.array(clarificationOptionSchema).default([]),
  selectedOptionId: z.string().nullable().default(null),
  allowFreeText: z.boolean().default(true),
})

export const placeSearchCandidateSchema = z.object({
  label: z.string(),
  displayName: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  boundingbox: z.array(z.union([z.string(), z.number()])).nullable().default(null),
  source: z.string().nullable().default(null),
})

export const placeResolutionSchema = z.object({
  status: z.string().default('unresolved'),
  query: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  selected: placeSearchCandidateSchema.nullable().default(null),
  candidates: z.array(placeSearchCandidateSchema).default([]),
  error: z.string().nullable().default(null),
})

export const userIntentSchema = z.object({
  area: z.string().nullable().default(null),
  placeQuery: z.string().nullable().default(null),
  anchorType: z.string().default('unknown'),
  taskType: z.string().nullable().default(null),
  distanceM: z.number().nullable().default(null),
  publishRequested: z.boolean().default(false),
  dataRequirements: z.array(z.string()).default([]),
  targetLayers: z.array(z.string()).default([]),
  spatialConstraints: z.array(z.string()).default([]),
  desiredOutputs: z.array(z.string()).default([]),
  uncertaintyFlags: z.array(z.string()).default([]),
  clarificationRequired: z.boolean().default(false),
  clarificationQuestion: z.string().nullable().default(null),
  clarificationOptions: z.array(clarificationOptionSchema).default([]),
})

export const planStepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
  reason: z.string(),
})

export const executionPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(planStepSchema).default([]),
})

export const toolValueRefSchema = z.object({
  refId: z.string(),
  kind: z.string(),
  label: z.string(),
  value: z.unknown(),
  unit: z.string().nullable().default(null),
  sourceTool: z.string().nullable().default(null),
  sourceResultId: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().nullable().default(null),
})

export const toolCallSchema = z.object({
  stepId: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
  status: z.string(),
  message: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  resultId: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  confidence: z.number().nullable().default(null),
  usedQuery: z.string().nullable().default(null),
  provenance: z.record(z.unknown()).default({}),
  crs: z.record(z.unknown()).default({}),
  geometryType: z.string().nullable().default(null),
  featureCount: z.number().nullable().default(null),
  valueRefs: z.array(toolValueRefSchema).default([]),
})

export const contextReferenceSchema = z.object({
  referenceId: z.string(),
  kind: z.string(),
  label: z.string(),
  description: z.string().default(''),
  sourceRunId: z.string().nullable().default(null),
  artifactId: z.string().nullable().default(null),
  collectionRef: z.string().nullable().default(null),
  layerKey: z.string().nullable().default(null),
  confidence: z.number().nullable().default(null),
  usableAs: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
})

export const contextResolutionSchema = z.object({
  status: z.string().default('unresolved'),
  query: z.string().nullable().default(null),
  selectedReferenceId: z.string().nullable().default(null),
  selectedKind: z.string().nullable().default(null),
  sourceRunId: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  candidates: z.array(contextReferenceSchema).default([]),
})

export const runLifecycleSchema = z.object({
  status: z.string().default('created'),
  reason: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const todoItemSchema = z.object({
  todoId: z.string(),
  title: z.string(),
  status: todoStatusSchema.default('pending'),
  description: z.string().nullable().default(null),
  activeForm: z.string().nullable().default(null),
  ownerAgentId: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
})

export const taskRecordSchema = z.object({
  taskId: z.string(),
  agentType: z.string(),
  prompt: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).default('pending'),
  createdAt: z.string(),
  updatedAt: z.string().nullable().default(null),
  resultSummary: z.string().nullable().default(null),
})

export const subAgentStateSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string().default('pending'),
  summary: z.string().default(''),
  stepIds: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  currentStepId: z.string().nullable().default(null),
  latestMessage: z.string().nullable().default(null),
})

export const approvalRequestSchema = z.object({
  approvalId: z.string(),
  action: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string().default('pending'),
  artifactId: z.string().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
})

export const artifactRefSchema = z.object({
  artifactId: z.string(),
  runId: z.string(),
  artifactType: z.string(),
  name: z.string(),
  uri: z.string(),
  metadata: z.record(z.unknown()).default({}),
  isIntermediate: z.boolean().default(false),
})

export const loopTraceEntrySchema = z.object({
  iteration: z.number(),
  phase: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string().default('running'),
  timestamp: z.string(),
  agentId: z.string().nullable().default(null),
  toolName: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
})

export const agentStateSchema = z.object({
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  parsedIntent: userIntentSchema.nullable().default(null),
  clarification: clarificationStateSchema.nullable().default(null),
  placeResolution: placeResolutionSchema.nullable().default(null),
  contextReferences: z.array(contextReferenceSchema).default([]),
  contextResolution: contextResolutionSchema.nullable().default(null),
  runLifecycle: runLifecycleSchema.default({}),
  executionPlan: executionPlanSchema.nullable().default(null),
  currentStep: z.number().default(0),
  loopIteration: z.number().default(0),
  loopPhase: z.string().default('idle'),
  loopTrace: z.array(loopTraceEntrySchema).default([]),
  todos: z.array(todoItemSchema).default([]),
  tasks: z.array(taskRecordSchema).default([]),
  planMode: z.boolean().default(false),
  subAgents: z.array(subAgentStateSchema).default([]),
  approvals: z.array(approvalRequestSchema).default([]),
  toolResults: z.array(toolCallSchema).default([]),
  toolValueRefs: z.array(toolValueRefSchema).default([]),
  artifacts: z.array(artifactRefSchema).default([]),
  selectedDataSources: z.array(z.string()).default([]),
  planRepairAttempts: z.number().default(0),
  textOnlyDelivery: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  failedStepId: z.string().nullable().default(null),
  failedTool: z.string().nullable().default(null),
  denialCounts: z.record(z.number()).default({}),
  runtimeStats: z.record(z.number()).default({}),
})

export const runEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  threadId: z.string().nullable().default(null),
  type: eventTypeSchema,
  message: z.string(),
  timestamp: z.string(),
  payload: z.record(z.unknown()).default({}),
})

export const conversationItemSchema = z.object({
  itemId: z.string(),
  itemType: conversationItemTypeSchema,
  runId: z.string(),
  threadId: z.string().nullable().default(null),
  turnId: z.string().nullable().default(null),
  callId: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  arguments: z.string().nullable().default(null),
  output: z.string().nullable().default(null),
  isError: z.boolean().default(false),
  phase: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.string(),
})

// --- Session / Thread / Run ---

export const sessionRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.string().default('active'),
  shareToken: z.string(),
  latestThreadId: z.string().nullable().default(null),
  latestRunId: z.string().nullable().default(null),
  latestUploadedLayerKey: z.string().nullable().default(null),
})

export const agentThreadRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  status: z.string().default('active'),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRunId: z.string().nullable().default(null),
  latestUserQuery: z.string().nullable().default(null),
  latestAssistantSummary: z.string().nullable().default(null),
  latestRunStatus: z.string().nullable().default(null),
  latestArtifactId: z.string().nullable().default(null),
  latestArtifactName: z.string().nullable().default(null),
  historyPreview: z.string().nullable().default(null),
  runCount: z.number().default(0),
  sessionLogPath: z.string().nullable().default(null),
})

export const analysisRunSchema = z.object({
  id: z.string(),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema.default('queued'),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: agentStateSchema,
  sessionLogPath: z.string().nullable().default(null),
  runtimeConfigSnapshot: z.custom<AgentRuntimeConfig>().nullable().default(null),
})

// --- Config ---

export const permissionRuleSchema = z.object({
  toolPattern: z.string(),
  decision: z.enum(['always_allow', 'always_deny', 'always_ask']),
  priority: z.number().default(0),
  description: z.string().default(''),
})

export const hookConfigSchema = z.object({
  eventType: z.string(),
  commandType: z.string().default('command'),
  command: z.string(),
  matcher: z.record(z.string()).default({}),
  priority: z.number().default(0),
  description: z.string().default(''),
  timeoutSeconds: z.number().default(30),
})

export const runtimeSubAgentConfigSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  summary: z.string(),
  systemPrompt: z.string().nullable().default(null),
  tools: z.array(z.string()).default([]),
})

export const supervisorRuntimeConfigSchema = z.object({
  name: z.string().default('geo_agent_supervisor'),
  systemPrompt: z.string().default(''),
  approvalInterruptTools: z.array(z.string()).default([]),
  permissionRules: z.array(permissionRuleSchema).default([]),
})

export const runtimeUiConfigSchema = z.object({
  transcriptMaxEntries: z.number().default(40),
  showInternalReasoningLabels: z.boolean().default(true),
  eventGroupingWindowMs: z.number().default(1500),
})

export const runtimeCatalogConfigSchema = z.object({
  allowEmptyCatalog: z.boolean().default(true),
  adminEnabled: z.boolean().default(true),
})

export const runtimeContextConfigSchema = z.object({
  memoryFilePaths: z.array(z.string()).default(['/AGENTS.md', '/THREAD_CONTEXT.md']),
  historyRunLimit: z.number().default(4),
  eventWindow: z.number().default(24),
  toolCallWindow: z.number().default(8),
  artifactWindow: z.number().default(6),
  warningWindow: z.number().default(6),
  promptMaxChars: z.number().default(12000),
  contextEntryWindow: z.number().default(18),
  memoryFileCharLimit: z.number().default(4000),
  memoryEnabled: z.boolean().default(true),
  memoryBaseDir: z.string().default('.geoagent/memory'),
})

export const runtimeGeosearchConfigSchema = z.object({
  provider: z.string().default('nominatim'),
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://nominatim.openstreetmap.org'),
  userAgent: z.string().default('geo-agent-platform/0.1'),
  timeoutMs: z.number().default(2500),
  maxCandidates: z.number().default(5),
})

export const runtimePoiConfigSchema = z.object({
  provider: z.string().default('overpass'),
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://overpass-api.de/api/interpreter'),
  userAgent: z.string().default('geo-agent-platform/0.1'),
  timeoutMs: z.number().default(8000),
  maxResults: z.number().default(200),
})

export const runtimeNowcastConfigSchema = z.object({
  defaultCityName: z.string().default('杭州市'),
  forecastHorizonMinutes: z.number().default(180),
  pointBufferMeters: z.number().default(1000),
  districtLayerKey: z.string().nullable().default(null),
  districtNameField: z.string().nullable().default(null),
  rainLevelThresholds: z.record(z.number()).default({ none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 }),
  candidateLimit: z.number().default(12),
})

export const runtimePlanningConfigSchema = z.object({
  maxPlanRepairRounds: z.number().default(2),
  allowTextOnlyDelivery: z.boolean().default(true),
  externalSourcePriority: z.array(z.string()).default(['catalog', 'external_poi', 'geosearch']),
})

export const agentRuntimeConfigSchema = z.object({
  loopTraceLimit: z.number().default(80),
  maxTurns: z.number().default(50),
  supervisor: supervisorRuntimeConfigSchema.default({}),
  subAgents: z.array(runtimeSubAgentConfigSchema).default([]),
  ui: runtimeUiConfigSchema.default({}),
  catalog: runtimeCatalogConfigSchema.default({}),
  planning: runtimePlanningConfigSchema.default({}),
  context: runtimeContextConfigSchema.default({}),
  geosearch: runtimeGeosearchConfigSchema.default({}),
  externalPoi: runtimePoiConfigSchema.default({}),
  nowcast: runtimeNowcastConfigSchema.default({}),
  hookConfigs: z.array(hookConfigSchema).default([]),
})

// --- Resources ---

export const layerPropertyDescriptorSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  populatedCount: z.number().default(0),
  sampleValues: z.array(z.string()).default([]),
})

export const layerDescriptorSchema = z.object({
  layerKey: z.string(),
  name: z.string(),
  sourceType: z.string(),
  geometryType: z.string(),
  srid: z.number().default(4326),
  description: z.string(),
  featureCount: z.number().nullable().default(null),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  propertySchema: z.array(layerPropertyDescriptorSchema).default([]),
  category: z.string().default('general'),
  status: z.string().default('active'),
  tags: z.array(z.string()).default([]),
  analysisCapabilities: z.array(z.string()).default([]),
  sourceConfigSummary: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const basemapDescriptorSchema = z.object({
  basemapKey: z.string(),
  name: z.string(),
  provider: z.string(),
  kind: z.string(),
  attribution: z.string().default(''),
  tileUrls: z.array(z.string()).default([]),
  labelTileUrls: z.array(z.string()).default([]),
  available: z.boolean().default(true),
  isDefault: z.boolean().default(false),
})

export const modelProviderDescriptorSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  configured: z.boolean(),
  defaultModel: z.string().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
})

export const toolParameterOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
})

export const toolParameterDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  dataType: z.string(),
  source: z.string().default('text'),
  required: z.boolean().default(false),
  description: z.string().nullable().default(null),
  placeholder: z.string().nullable().default(null),
  defaultValue: z.unknown().nullable().default(null),
  options: z.array(toolParameterOptionSchema).default([]),
})

export const toolDescriptorSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.string(),
  toolKind: z.string().default('registry'),
  available: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  parameters: z.array(toolParameterDescriptorSchema).default([]),
  error: z.string().nullable().default(null),
  meta: z.record(z.unknown()).default({}),
})

// --- Derived TypeScript types ---

export type EventType = z.infer<typeof eventTypeSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type TodoStatus = z.infer<typeof todoStatusSchema>
export type ConversationItemType = z.infer<typeof conversationItemTypeSchema>

export type ClarificationOption = z.infer<typeof clarificationOptionSchema>
export type ClarificationState = z.infer<typeof clarificationStateSchema>
export type PlaceSearchCandidate = z.infer<typeof placeSearchCandidateSchema>
export type PlaceResolution = z.infer<typeof placeResolutionSchema>
export type UserIntent = z.infer<typeof userIntentSchema>
export type PlanStep = z.infer<typeof planStepSchema>
export type ExecutionPlan = z.infer<typeof executionPlanSchema>
export type ToolValueRef = z.infer<typeof toolValueRefSchema>
export type ToolCall = z.infer<typeof toolCallSchema>
export type ContextReference = z.infer<typeof contextReferenceSchema>
export type ContextResolution = z.infer<typeof contextResolutionSchema>
export type RunLifecycle = z.infer<typeof runLifecycleSchema>
export type TodoItem = z.infer<typeof todoItemSchema>
export type TaskRecord = z.infer<typeof taskRecordSchema>
export type SubAgentState = z.infer<typeof subAgentStateSchema>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>
export type ArtifactRef = z.infer<typeof artifactRefSchema>
export type LoopTraceEntry = z.infer<typeof loopTraceEntrySchema>
export type AgentState = z.infer<typeof agentStateSchema>
export type RunEvent = z.infer<typeof runEventSchema>
export type ConversationItem = z.infer<typeof conversationItemSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type AgentThreadRecord = z.infer<typeof agentThreadRecordSchema>
export type AnalysisRun = z.infer<typeof analysisRunSchema>

export type PermissionRuleEntry = z.infer<typeof permissionRuleSchema>
export type HookConfigEntry = z.infer<typeof hookConfigSchema>
export type RuntimeSubAgentConfig = z.infer<typeof runtimeSubAgentConfigSchema>
export type SupervisorRuntimeConfig = z.infer<typeof supervisorRuntimeConfigSchema>
export type RuntimeUiConfig = z.infer<typeof runtimeUiConfigSchema>
export type RuntimeCatalogConfig = z.infer<typeof runtimeCatalogConfigSchema>
export type RuntimeContextConfig = z.infer<typeof runtimeContextConfigSchema>
export type RuntimeGeosearchConfig = z.infer<typeof runtimeGeosearchConfigSchema>
export type RuntimePoiConfig = z.infer<typeof runtimePoiConfigSchema>
export type RuntimeNowcastConfig = z.infer<typeof runtimeNowcastConfigSchema>
export type RuntimePlanningConfig = z.infer<typeof runtimePlanningConfigSchema>
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>

export type LayerPropertyDescriptor = z.infer<typeof layerPropertyDescriptorSchema>
export type LayerDescriptor = z.infer<typeof layerDescriptorSchema>
export type BasemapDescriptor = z.infer<typeof basemapDescriptorSchema>
export type ModelProviderDescriptor = z.infer<typeof modelProviderDescriptorSchema>
export type ToolParameterOption = z.infer<typeof toolParameterOptionSchema>
export type ToolParameterDescriptor = z.infer<typeof toolParameterDescriptorSchema>
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>

