// +-------------------------------------------------------------------------
//
//   地理智能平台 - Demo ToolProvider
//
//   文件:       demoProvider.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Provider 是工具进入平台的唯一显式入口。
//
// 这里演示 valueRef 输出、valueRef 消费、artifact 写入和 provenance 记录，
// 复制为正式工具时应保留这些边界。

import type { ToolDef, ToolProvider, ValueRef } from '../../../server/src/framework/types.js'
import {
  collectObservationSchema,
  manifest,
  writeObservationReportSchema,
} from './demoManifest.js'
import { createObservationRef, writeObservationArtifact } from './demoService.js'

const collectObservationTool: ToolDef = {
  name: manifest.tools[0].name,
  label: manifest.tools[0].label,
  description: manifest.tools[0].description,
  group: manifest.tools[0].group,
  tags: manifest.tools[0].tags,
  isReadOnly: manifest.tools[0].isReadOnly,
  isDestructive: manifest.tools[0].isDestructive,
  jsonSchema: collectObservationSchema,
  handler: async (args, ctx) => {
    const stationName = String(args.station_name)
    const observedValue = Number(args.observed_value)
    const unit = String(args.unit)
    const observationRef = createObservationRef({
      runId: ctx.runId,
      stationName,
      observedValue,
      unit,
    })
    return {
      message: 'Demo 观测值已整理为可复用引用。',
      payload: {
        observation_ref: observationRef.refId,
        station_name: stationName,
        unit,
      },
      warnings: [],
      resultId: `demo_collect_${ctx.runId}`,
      source: 'demo-observation.collect',
      valueRefs: [observationRef],
      provenance: {
        providerId: manifest.id,
        toolName: 'demo_collect_observation',
        algorithm: 'demo-observation-v1',
        inputs: {
          station_name: stationName,
          observed_value: observedValue,
          unit,
        },
      },
    }
  },
}

const writeObservationReportTool: ToolDef = {
  name: manifest.tools[1].name,
  label: manifest.tools[1].label,
  description: manifest.tools[1].description,
  group: manifest.tools[1].group,
  tags: manifest.tools[1].tags,
  isReadOnly: manifest.tools[1].isReadOnly,
  isDestructive: manifest.tools[1].isDestructive,
  jsonSchema: writeObservationReportSchema,
  handler: async (args, ctx) => {
    const observationRefId = String(args.observation_ref)
    const detailLevel = String(args.detail_level ?? 'standard')
    const observationRef = ctx.resolveValueRef(observationRefId)
    assertObservationRef(observationRef)
    const { artifact, reportRef } = await writeObservationArtifact({
      runId: ctx.runId,
      observationRef,
      detailLevel,
    })
    return {
      message: 'Demo 观测报告已生成。',
      payload: {
        artifact_id: artifact.artifactId,
        report_ref: reportRef.refId,
        observation_ref: observationRef.refId,
      },
      warnings: [],
      resultId: `demo_report_${ctx.runId}`,
      source: 'demo-observation.report',
      artifacts: [artifact],
      valueRefs: [reportRef],
      provenance: {
        providerId: manifest.id,
        toolName: 'demo_write_observation_report',
        algorithm: 'demo-report-v1',
        inputRefs: {
          observation_ref: observationRef.refId,
        },
      },
    }
  },
}

export const demoProvider: ToolProvider = {
  manifest,
  tools: () => [collectObservationTool, writeObservationReportTool],
}

export default demoProvider

function assertObservationRef(ref: ValueRef) {
  if (ref.kind !== 'demo_observation') {
    throw new Error(`observation_ref 类型错误：期望 demo_observation，实际为 ${ref.kind}`)
  }
}
