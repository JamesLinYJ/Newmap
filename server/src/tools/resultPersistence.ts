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
import type { ArtifactRef, ToolValueRef } from '../schemas/types.js'
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
  await store.updateRunState(runId, {
    toolValueRefs: dedupeValueRefs([...run.state.toolValueRefs, ...refs]),
    artifacts: dedupeArtifacts([...run.state.artifacts, ...artifacts]),
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
