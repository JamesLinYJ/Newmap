// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发工具 Provider 定义汇总
//
//   文件:       definitions.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Developer tools 是维护 GeoForge GIS/气象 Agent 的内部工具箱，不改变产品身份。
// manifest 从同一批 ToolDef 生成，避免 DebugPage、Agent SDK 与运行时定义漂移。

import type { ToolDef, ToolManifest } from '../../framework/types.js'
import { editFileTool } from './editFile/definition.js'
import { globFilesTool } from './globFiles/definition.js'
import { grepFilesTool } from './grepFiles/definition.js'
import { readFileTool } from './readFile/definition.js'
import { todoWriteTool } from './todoWrite/definition.js'
import { writeFileTool } from './writeFile/definition.js'

export const developerTools: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globFilesTool,
  grepFilesTool,
  todoWriteTool,
]

export const developerManifest: ToolManifest = {
  id: 'geo-platform-developer-tools',
  name: 'GIS/气象 Agent 开发工具',
  version: '1.0.0',
  author: 'geo-agent-platform',
  language: 'typescript',
  description: '用于维护 GeoForge GIS/气象 Agent 的受控文件读写、搜索与 Todo 工具。',
  requires: {
    DEVELOPER_TOOL_ALLOWED_ROOTS: 'required',
  },
  tools: developerTools.map(tool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    group: tool.group,
    tags: tool.tags,
    isReadOnly: tool.isReadOnly,
    isDestructive: tool.isDestructive,
    jsonSchema: tool.jsonSchema,
  })),
}
