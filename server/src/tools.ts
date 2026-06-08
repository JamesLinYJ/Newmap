// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具注册中心
//
//   文件:       tools.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 集中 import 所有内置 tool，统一注册到 ToolRegistry 供 agent 调度。

import type { ToolDescriptor } from './schemas/types.js'
import type { PostGisRepository } from './gis/postgis.js'
import { geocodePlaceTool } from './tools/geocodePlace/geocodePlace.js'
import { createLayerQueryTool } from './tools/layerQuery/layerQuery.js'
import { createSpatialAnalysisTool } from './tools/spatialAnalysis/spatialAnalysis.js'
import { chartTool } from './tools/chart/chart.js'
import { weatherInspectTool } from './tools/weather/weatherTools.js'
import { ttsTool, digitalHumanTool } from './tools/media/mediaTools.js'
import { enterPlanModeTool, exitPlanModeTool } from './tools/plan/planTools.js'
import { taskCreateTool, taskListTool } from './tools/task/taskTools.js'

// Tool 执行上下文（传递给每个 tool handler）
export interface ToolRuntime {
  runId: string
  threadId: string | null
  sessionId: string
  userId?: string
}

// Tool 执行结果
export interface ToolExecutionResult {
  message: string
  payload: Record<string, unknown>
  warnings: unknown[]
  valueRefs: unknown[]
  resultId: string
  source: string
  artifact?: { artifactId: string; runId: string; artifactType: string; name: string; uri: string }
}

// Tool 定义
export interface ToolDef {
  name: string
  label: string
  description: string
  group: string
  toolKind: string
  tags: string[]
  isReadOnly: boolean
  isDestructive: boolean
  isConcurrencySafe: boolean
  available?: boolean
  unavailableReason?: string | null
  handler: (args: Record<string, unknown>, runtime: ToolRuntime) => Promise<ToolExecutionResult>
  jsonSchema?: Record<string, unknown>
  shouldDefer?: boolean
  interruptBehavior?: 'block' | 'allow'
}

// ToolRegistry
//
// 注册、查找、执行工具的调度层。
export class ToolRegistry {
  private defs = new Map<string, ToolDef>()

  register(def: ToolDef): void {
    if (def.available === false) return
    this.defs.set(def.name, def)
  }

  registerAll(defs: ToolDef[]): void {
    defs.forEach(d => this.register(d))
  }

  get(name: string): ToolDef | undefined {
    return this.defs.get(name)
  }

  list(): ToolDef[] {
    return [...this.defs.values()]
  }

  async execute(name: string, args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolExecutionResult> {
    const def = this.defs.get(name)
    if (!def) throw new Error(`工具 '${name}' 未注册`)
    return def.handler(args, runtime)
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map(d => ({
      name: d.name,
      label: d.label,
      description: d.description,
      group: d.group,
      toolKind: d.toolKind,
      available: true,
      tags: d.tags,
      parameters: [],
      error: null,
      meta: {},
    }))
  }
}

// 构建默认 registry
export function buildRegistry(deps: { postgis?: PostGisRepository | null } = {}): ToolRegistry {
  const registry = new ToolRegistry()
  const geoTools = deps.postgis
    ? [createLayerQueryTool(deps.postgis), createSpatialAnalysisTool(deps.postgis)]
    : []
  registry.registerAll([
    geocodePlaceTool, ...geoTools, chartTool,
    weatherInspectTool, ttsTool, digitalHumanTool,
    enterPlanModeTool, exitPlanModeTool,
    taskCreateTool, taskListTool,
  ])
  return registry
}
