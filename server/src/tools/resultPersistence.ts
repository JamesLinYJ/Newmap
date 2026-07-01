// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具结果持久化
//
//   文件:       resultPersistence.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Agent 自动调用与 Debug 工作台直跑必须共享同一条结果持久化路径。
// run state 是实时快照，分片 run 文件是历史事实源，Postgres 只保存 artifact 可重建索引。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult, ValueRef } from '../framework/types.js'
import type { ArtifactRef, ClarificationState, DecisionRequest, ExecutionPlan, TodoItem, ToolValueRef } from '../schemas/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { makeId, nowUtc } from '../utils/ids.js'

export async function persistToolExecutionResult(
  store: PostgresPlatformStore,
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  const run = store.getRun(runId)
  const refs: ToolValueRef[] = (result.valueRefs ?? []).map(ref => ({
    ...ref,
    sourceTool: toolName,
    sourceResultId: result.resultId,
    metadata: ref.metadata ?? {},
    createdAt: nowUtc(),
    unit: ref.unit ?? null,
  }))
  const explicitArtifacts: ArtifactRef[] = (result.artifacts ?? []).map(artifact => ({
    artifactId: artifact.artifactId,
    runId,
    artifactType: artifact.artifactType,
    name: artifact.name,
    uri: artifact.uri,
    metadata: { ...(artifact.metadata ?? {}), ...(artifact.relativePath ? { relativePath: artifact.relativePath } : {}) },
    isIntermediate: false,
  }))
  const generatedArtifacts = await createGeoArtifacts(result, runId, store.runtimeRoot)
  const artifacts = dedupeArtifacts([...explicitArtifacts, ...generatedArtifacts])
  const controlState = {
    ...planControlState(result.payload),
    ...clarificationControlState(result.payload, run.state.decisions),
    ...todoControlState(result.payload),
  }
  await store.updateRunState(runId, {
    toolValueRefs: dedupeValueRefs([...run.state.toolValueRefs, ...refs]),
    artifacts: dedupeArtifacts([...run.state.artifacts, ...artifacts]),
    ...controlState,
    toolResults: [...run.state.toolResults, {
      stepId: makeId('step'),
      tool: toolName,
      args,
      status: 'completed',
      message: result.message,
      startedAt: null,
      completedAt: nowUtc(),
      resultId: result.resultId,
      source: result.source,
      confidence: null,
      usedQuery: null,
      provenance: result.provenance ?? {},
      crs: {},
      geometryType: null,
      featureCount: null,
      valueRefs: refs,
    }],
  })
  for (const ref of refs) store.conversationStore.appendValue(runId, ref)
  await Promise.all(artifacts.map(artifact => store.persistArtifact(artifact)))
}

// 计划模式是运行状态，不是普通工具 payload。
// enter/exit 工具返回控制字段后，必须在同一条持久化路径内写回 run state。
function planControlState(payload: Record<string, unknown>): Partial<{
  planMode: boolean
  executionPlan: ExecutionPlan | null
}> {
  const updates: Partial<{ planMode: boolean; executionPlan: ExecutionPlan | null }> = {}
  if (typeof payload.planMode === 'boolean') updates.planMode = payload.planMode
  if (isRecord(payload.plan)) updates.executionPlan = normalizeExecutionPlan(payload.plan)
  return updates
}

// 澄清是单次 run 的显式终止原因，不等于退出计划模式。
// 工具把结构化问题写入这里，UI/SSE 不再从 assistant 正文里猜测澄清状态。
function clarificationControlState(
  payload: Record<string, unknown>,
  currentDecisions: DecisionRequest[],
): Partial<{ clarification: ClarificationState | null; decisions: DecisionRequest[] }> {
  if (!isRecord(payload.clarification)) return {}
  const raw = payload.clarification
  const options = Array.isArray(raw.options)
    ? raw.options.filter(isRecord).map((option, index) => ({
      optionId: typeof option.optionId === 'string' ? option.optionId : `clarification_option_${index + 1}`,
      label: typeof option.label === 'string' && option.label.trim() ? option.label.trim() : `选项 ${index + 1}`,
      description: typeof option.description === 'string' ? option.description : '',
      kind: typeof option.kind === 'string' ? option.kind : 'generic',
      reason: typeof option.reason === 'string' ? option.reason : null,
      payload: isRecord(option.payload) ? option.payload : {},
    }))
    : []
  const clarification: ClarificationState = {
    clarificationId: typeof raw.clarificationId === 'string' && raw.clarificationId.trim()
      ? raw.clarificationId.trim()
      : makeId('clarification'),
    kind: typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim() : 'generic',
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'generic',
    question: typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim() : '请补充必要信息。',
    options,
    selectedOptionId: typeof raw.selectedOptionId === 'string' ? raw.selectedOptionId : null,
    allowFreeText: typeof raw.allowFreeText === 'boolean' ? raw.allowFreeText : true,
  }
  const decision: DecisionRequest = {
    decisionId: clarification.clarificationId,
    kind: 'clarification',
    title: '需要补充信息',
    question: clarification.question,
    description: clarification.reason,
    options: clarification.options,
    allowFreeText: clarification.allowFreeText,
    status: 'pending',
    payload: {
      clarificationId: clarification.clarificationId,
      clarificationKind: clarification.kind,
      reason: clarification.reason,
    },
    createdAt: nowUtc(),
    resolvedAt: null,
  }
  return { clarification, decisions: upsertDecision(currentDecisions, decision) }
}

function upsertDecision(decisions: DecisionRequest[], decision: DecisionRequest): DecisionRequest[] {
  const next = decisions.filter(item => item.decisionId !== decision.decisionId)
  return [...next, decision]
}

function normalizeExecutionPlan(value: Record<string, unknown>): ExecutionPlan {
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step, index) => normalizePlanStep(step, index))
    : []
  return {
    goal: typeof value.goal === 'string' && value.goal.trim() ? value.goal.trim() : '执行已批准计划',
    steps,
  }
}

function normalizePlanStep(value: unknown, index: number): ExecutionPlan['steps'][number] {
  const raw = isRecord(value) ? value : {}
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `plan_step_${index + 1}`,
    tool: typeof raw.tool === 'string' && raw.tool.trim() ? raw.tool.trim() : 'manual',
    args: isRecord(raw.args) ? raw.args : {},
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : '按计划执行',
  }
}

// todo_write 的 payload 是运行状态更新，不是普通文本结果。统一在工具持久化
// 入口写回 AgentState，确保时间线、右侧结果和 DebugPage 看到同一份 Todo。
function todoControlState(payload: Record<string, unknown>): Partial<{ todos: TodoItem[] }> {
  if (!Array.isArray(payload.todos)) return {}
  return { todos: payload.todos.map((todo, index) => normalizeTodoItem(todo, index)) }
}

function normalizeTodoItem(value: unknown, index: number): TodoItem {
  const raw = isRecord(value) ? value : {}
  const status = typeof raw.status === 'string' && ['pending', 'running', 'completed', 'failed', 'blocked'].includes(raw.status)
    ? raw.status as TodoItem['status']
    : 'pending'
  return {
    todoId: typeof raw.todoId === 'string' && raw.todoId.trim() ? raw.todoId.trim() : `todo_${index + 1}`,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Todo ${index + 1}`,
    status,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : null,
    activeForm: typeof raw.activeForm === 'string' && raw.activeForm.trim() ? raw.activeForm.trim() : null,
    ownerAgentId: typeof raw.ownerAgentId === 'string' && raw.ownerAgentId.trim() ? raw.ownerAgentId.trim() : null,
    stepId: typeof raw.stepId === 'string' && raw.stepId.trim() ? raw.stepId.trim() : null,
  }
}

export function resolveRuntimeValueRef(state: Map<string, unknown>, refId: string): ValueRef {
  const value = state.get(refId)
  if (!isRecord(value) || typeof value.refId !== 'string') throw new Error(`未知 valueRef：${refId}`)
  return value as unknown as ValueRef
}

async function createGeoArtifacts(result: ToolResult, runId: string, runtimeRoot: string): Promise<ArtifactRef[]> {
  const artifacts: ArtifactRef[] = []
  const serialized = new Set<string>()
  for (const ref of result.valueRefs ?? []) {
    const geojson = extractGeoJson(ref.value, ref.kind)
    if (!geojson) continue
    const artifact = await writeGeoArtifact(runtimeRoot, runId, ref.label || result.message, ref.kind, geojson, serialized)
    if (artifact) artifacts.push(artifact)
  }
  for (const [key, value] of Object.entries(result.payload)) {
    const geojson = extractGeoJson(value)
    if (!geojson) continue
    const artifact = await writeGeoArtifact(runtimeRoot, runId, key === 'route' ? '规划路线' : key, key, geojson, serialized)
    if (artifact) artifacts.push(artifact)
  }
  return artifacts
}

async function writeGeoArtifact(
  runtimeRoot: string,
  runId: string,
  name: string,
  kind: string,
  geojson: Record<string, unknown>,
  serialized: Set<string>,
): Promise<ArtifactRef | null> {
  const content = JSON.stringify(geojson)
  if (serialized.has(content)) return null
  serialized.add(content)
  const artifactId = makeId('artifact')
  const relativePath = path.posix.join('artifacts', runId, `${artifactId}.geojson`)
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  return {
    artifactId,
    runId,
    artifactType: 'geojson',
    name,
    uri: `/api/v1/results/${artifactId}/geojson`,
    metadata: { relativePath, kind },
    isIntermediate: false,
  }
}

function extractGeoJson(value: unknown, kind?: string): Record<string, unknown> | null {
  if (kind && !['geojson', 'route', 'feature_collection'].includes(kind)) return null
  return isGeoJsonObject(value) ? value : null
}

function isGeoJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [
    'FeatureCollection', 'Feature', 'LineString', 'Point', 'Polygon',
    'MultiLineString', 'MultiPoint', 'MultiPolygon', 'GeometryCollection',
  ].includes(String(value.type))
}

function dedupeArtifacts<T extends ArtifactRef>(artifacts: T[]): T[] {
  return [...new Map(artifacts.map(artifact => [artifact.artifactId, artifact])).values()]
}

function dedupeValueRefs<T extends ToolValueRef>(refs: T[]): T[] {
  return [...new Map(refs.map(ref => [ref.refId, ref])).values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
