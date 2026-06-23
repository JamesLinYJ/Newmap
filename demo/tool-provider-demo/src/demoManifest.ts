// +-------------------------------------------------------------------------
//
//   地理智能平台 - Demo 工具 Manifest
//
//   文件:       demoManifest.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Manifest 是工具公开契约。UI、Agent 和 runtime descriptor 都从这里获得
// 工具名称、风险属性和参数 schema。

import type { ToolManifest } from '../../../server/src/framework/types.js'

export const collectObservationSchema = {
  type: 'object',
  properties: {
    station_name: {
      type: 'string',
      title: '站点名称',
      description: '观测站点或业务对象名称。',
      minLength: 1,
      'x-source': 'text',
    },
    observed_value: {
      type: 'number',
      title: '观测值',
      description: '已经过人工确认或上游工具输出的观测数值。',
      'x-source': 'number',
    },
    unit: {
      type: 'string',
      title: '单位',
      description: '观测值单位。',
      enum: ['mm', 'm/s', 'degC'],
      default: 'mm',
      'x-source': 'text',
    },
  },
  required: ['station_name', 'observed_value', 'unit'],
  additionalProperties: false,
}

export const writeObservationReportSchema = {
  type: 'object',
  properties: {
    observation_ref: {
      type: 'string',
      title: '观测引用',
      description: '由 demo_collect_observation 返回的 demo_observation valueRef。',
      minLength: 1,
      'x-source': 'value_ref',
      'x-value-ref-kinds': ['demo_observation'],
    },
    detail_level: {
      type: 'string',
      title: '报告详细程度',
      description: '控制 artifact 中说明文字的详细程度。',
      enum: ['brief', 'standard'],
      default: 'standard',
      'x-source': 'text',
    },
  },
  required: ['observation_ref'],
  additionalProperties: false,
}

export const manifest: ToolManifest = {
  id: 'demo-observation',
  name: '观测 Demo 工具',
  version: '0.1.0',
  author: 'Geo Agent Team',
  description: '展示 TypeScript ToolProvider、valueRef、artifact 和 provenance 的最小可复制模板。',
  language: 'typescript',
  tools: [
    {
      name: 'demo_collect_observation',
      label: '采集 Demo 观测',
      description: '把输入观测值整理成当前 run 可复用的 valueRef。',
      group: 'demo',
      tags: ['demo', 'valueRef'],
      isReadOnly: true,
      isDestructive: false,
      jsonSchema: collectObservationSchema,
    },
    {
      name: 'demo_write_observation_report',
      label: '生成 Demo 观测报告',
      description: '消费观测 valueRef，写入一个 JSON artifact 作为报告模板。',
      group: 'demo',
      tags: ['demo', 'artifact'],
      isReadOnly: true,
      isDestructive: false,
      jsonSchema: writeObservationReportSchema,
    },
  ],
}
