// +-------------------------------------------------------------------------
//
//   地理智能平台 - 读取文件工具定义
//
//   文件:       definition.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolDef } from '../../../framework/types.js'
import { READ_FILE_PROMPT } from './prompt.js'
import { readFileHandler } from './handler.js'

export const readFileTool: ToolDef = {
  name: 'read_file',
  label: '读取文件',
  description: '读取允许根目录内的 UTF-8 文本文件，并为后续 edit_file 建立完整读取快照。',
  prompt: READ_FILE_PROMPT,
  group: '开发工具',
  tags: ['developer', 'file', 'read'],
  isReadOnly: true,
  isDestructive: false,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', title: '文件路径', description: '绝对路径；相对路径会按首个允许根目录解析。' },
      offset: { type: 'integer', title: '起始行', description: '1-based 起始行。省略时从第一行开始。', minimum: 1 },
      limit: { type: 'integer', title: '行数限制', description: '返回的最大行数。省略时读取完整文件。', minimum: 1, maximum: 5000 },
    },
    required: ['file_path'],
  },
  handler: readFileHandler,
}
