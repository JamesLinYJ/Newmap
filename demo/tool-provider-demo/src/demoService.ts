// +-------------------------------------------------------------------------
//
//   地理智能平台 - Demo 工具领域服务
//
//   文件:       demoService.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 领域服务承载可测试业务逻辑。
//
// Provider handler 只负责参数、上下文、artifact 和 provenance 编排，避免
// registry glue 变成隐藏业务算法。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolArtifact, ValueRef } from '../../../server/src/framework/types.js'

export interface DemoObservation {
  stationName: string
  observedValue: number
  unit: string
  collectedAt: string
}

export function createObservationRef({
  runId,
  stationName,
  observedValue,
  unit,
}: {
  runId: string
  stationName: string
  observedValue: number
  unit: string
}): ValueRef {
  const observation: DemoObservation = {
    stationName,
    observedValue,
    unit,
    collectedAt: new Date().toISOString(),
  }
  return {
    refId: `demo_observation_${runId}_${slug(stationName)}`,
    kind: 'demo_observation',
    label: `${stationName} 观测值`,
    value: observation,
    unit,
    metadata: {
      schemaVersion: 'demo-observation-v1',
    },
  }
}

export async function writeObservationArtifact({
  runId,
  observationRef,
  detailLevel,
}: {
  runId: string
  observationRef: ValueRef
  detailLevel: string
}): Promise<{ artifact: ToolArtifact; reportRef: ValueRef }> {
  const runtimeRoot = path.resolve(process.env.RUNTIME_ROOT ?? 'runtime')
  const artifactId = `demo_observation_report_${runId}_${Date.now()}`
  const relativePath = path.posix.join('artifacts', runId, `${artifactId}.json`)
  const targetPath = resolveRuntimePath(runtimeRoot, relativePath)
  const report = {
    title: 'Demo 观测报告',
    detailLevel,
    observationRef: observationRef.refId,
    observation: observationRef.value,
    generatedAt: new Date().toISOString(),
  }
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const artifact: ToolArtifact = {
    artifactId,
    artifactType: 'json',
    name: 'Demo 观测报告',
    uri: `artifact://${artifactId}`,
    relativePath,
    metadata: {
      observationRef: observationRef.refId,
      detailLevel,
      schemaVersion: 'demo-report-v1',
    },
  }
  const reportRef: ValueRef = {
    refId: `demo_report_${artifactId}`,
    kind: 'demo_report',
    label: 'Demo 观测报告引用',
    value: {
      artifactId,
      observationRef: observationRef.refId,
    },
    metadata: {
      artifactType: artifact.artifactType,
    },
  }
  return { artifact, reportRef }
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string) {
  const normalizedParts = relativePath.split('/').filter(Boolean)
  const target = path.resolve(runtimeRoot, ...normalizedParts)
  const rootWithSeparator = runtimeRoot.endsWith(path.sep) ? runtimeRoot : `${runtimeRoot}${path.sep}`
  if (target !== runtimeRoot && !target.startsWith(rootWithSeparator)) {
    throw new Error('artifact 路径必须位于 runtime 根目录内')
  }
  return target
}

function slug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'observation'
}
