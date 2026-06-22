// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具表单状态工具
//
//   文件:       toolFormState.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 保存工具参数默认值、必填校验和 JSON 参数解析等纯逻辑。拆出 TS 文件可让
// React 组件文件满足 Fast Refresh 的组件导出规则。

import type {
  ArtifactRef,
  LayerDescriptor,
  ToolDescriptor,
  ToolParameterDescriptor,
} from '@geo-agent-platform/shared-types'

export interface ToolFormState {
  values: Record<string, string>
  missing: ToolParameterDescriptor[]
  parsed: { args: Record<string, unknown>; error: string | null }
}

export function resolveToolDefaults(tool: ToolDescriptor) {
  return tool.parameters.reduce<Record<string, string>>((accumulator, parameter) => {
    if (parameter.defaultValue === undefined || parameter.defaultValue === null) {
      accumulator[parameter.key] = ''
      return accumulator
    }
    accumulator[parameter.key] = parameter.source === 'json'
      ? JSON.stringify(parameter.defaultValue, null, 2)
      : String(parameter.defaultValue)
    return accumulator
  }, {})
}

export function buildToolFormState(tool: ToolDescriptor, values: Record<string, string>): ToolFormState {
  return {
    values,
    missing: getMissingRequiredParameters(tool, values),
    parsed: buildToolArgsSafely(tool, values),
  }
}

export function buildCollectionOptions({
  artifacts,
  layers,
}: {
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
}) {
  const artifactOptions = artifacts.map((artifact) => ({
    label: `结果 · ${artifact.name} · ${shortId(artifact.artifactId)}`,
    value: artifact.artifactId,
  }))
  const layerOptions = layers.map((layer) => ({
    label: `图层 · ${layer.name} · ${layer.layerKey}`,
    value: layer.layerKey,
  }))
  return [...artifactOptions, ...layerOptions]
}

export function buildToolArgs(tool: ToolDescriptor, values: Record<string, string>) {
  return tool.parameters.reduce<Record<string, unknown>>((accumulator, parameter) => {
    const rawValue = values[parameter.key]
    if (rawValue == null || rawValue === '') {
      return accumulator
    }
    if (parameter.source === 'number') {
      accumulator[parameter.key] = Number(rawValue)
      return accumulator
    }
    if (parameter.source === 'boolean') {
      accumulator[parameter.key] = rawValue === 'true'
      return accumulator
    }
    if (parameter.source === 'json') {
      accumulator[parameter.key] = JSON.parse(rawValue)
      return accumulator
    }
    accumulator[parameter.key] = rawValue
    return accumulator
  }, {})
}

export function getMissingRequiredParameters(tool: ToolDescriptor, values: Record<string, string>) {
  return tool.parameters.filter((parameter) => parameter.required && !String(values[parameter.key] ?? '').trim())
}

export function buildToolArgsSafely(tool: ToolDescriptor, values: Record<string, string>): { args: Record<string, unknown>; error: string | null } {
  try {
    return { args: buildToolArgs(tool, values), error: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { args: {}, error: `JSON 参数格式不正确：${detail}` }
  }
}

function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}
