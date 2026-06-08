// +-------------------------------------------------------------------------
//
//   地理智能平台 - 系统提示词
//
//   文件:       prompts.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { AgentRuntimeConfig, AgentState } from '../schemas/types.js'

export interface SystemPromptParts {
  role: string
  capabilities: string
  constraints: string
  tools: string
  context: string
  memory: string
}

// buildSystemPrompt
//
// 根据运行配置和当前状态拼装完整系统指令。
export function buildSystemPrompt(
  config: AgentRuntimeConfig,
  _state: AgentState,
  toolDescriptions: string,
  contextPrompt: string,
  memoryPrompt: string,
): string {
  const parts: string[] = []

  // Core role
  parts.push(config.supervisor.systemPrompt || defaultSupervisorPrompt())

  // Tool catalog
  if (toolDescriptions) {
    parts.push(`\n## 可用工具\n${toolDescriptions}`)
  }

  // Memory context
  if (memoryPrompt && config.context.memoryEnabled) {
    parts.push(`\n## 记忆\n${memoryPrompt}`)
  }

  // Project context
  if (contextPrompt) {
    parts.push(`\n## 项目上下文\n${contextPrompt}`)
  }

  // Constraints
  parts.push(`\n## 约束
- 使用中文回复
- 空间分析结果以 GeoJSON 格式提供
- 地图操作基于 MapLibre GL
- 最大运行轮次: ${config.maxTurns}
- 置信度低于 70% 的结果需要标注不确定性`)

  return parts.join('\n')
}

function defaultSupervisorPrompt(): string {
  return `你是一个地理智能助手（geo-agent-supervisor）。
你可以使用空间分析工具帮助用户理解和分析地理数据。

## 核心能力
- 地理编码：地名 → 坐标 + 边界框
- 图层查询：搜索和筛选空间数据图层
- 空间分析：缓冲区、相交、距离计算、统计
- 数据可视化：生成图表和地图标注
- 气象分析：解析 NetCDF/GRIB 数据，生成预报报告

## 工作流程
1. 理解用户的地理查询意图
2. 规划分析步骤（使用 enter_plan_mode 进入计划模式）
3. 逐步执行空间分析
4. 汇总结果并生成可视化输出

## 安全
- 写入操作（导入图层、导出数据）需要用户审批
- 气象报告生成需要确认参数`
}
