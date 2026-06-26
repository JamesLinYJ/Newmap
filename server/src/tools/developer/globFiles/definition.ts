// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件模式搜索定义
//
//   文件:       definition.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolDef } from '../../../framework/types.js'
import { globFilesHandler } from './handler.js'
import { GLOB_FILES_PROMPT } from './prompt.js'

export const globFilesTool: ToolDef = {
  name: 'glob_files',
  label: '文件模式搜索',
  description: '在允许根目录内按 glob 查找文件。',
  prompt: GLOB_FILES_PROMPT,
  group: '开发工具',
  tags: ['developer', 'file', 'search'],
  isReadOnly: true,
  isDestructive: false,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', title: 'Glob 模式', description: '例如 **/*.ts、apps/web/**/*.tsx。' },
      path: { type: 'string', title: '搜索根目录', description: '可选目录；省略时使用首个允许根。' },
      limit: { type: 'integer', title: '结果上限', description: '最大返回数量。', minimum: 1, maximum: 1000 },
    },
    required: ['pattern'],
  },
  handler: globFilesHandler,
}
