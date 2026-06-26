// +-------------------------------------------------------------------------
//
//   地理智能平台 - 写入文件工具定义
//
//   文件:       definition.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolDef } from '../../../framework/types.js'
import { writeFileHandler } from './handler.js'
import { WRITE_FILE_PROMPT } from './prompt.js'

export const writeFileTool: ToolDef = {
  name: 'write_file',
  label: '写入文件',
  description: '在允许根目录内创建或完整覆盖 UTF-8 文本文件。',
  prompt: WRITE_FILE_PROMPT,
  group: '开发工具',
  tags: ['developer', 'file', 'write'],
  isReadOnly: false,
  isDestructive: true,
  requiresApproval: true,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', title: '文件路径', description: '目标文件路径。' },
      content: { type: 'string', title: '文件内容', description: '要写入的完整 UTF-8 文本。' },
      create_parent_dirs: { type: 'boolean', title: '创建父目录', description: '父目录不存在时是否创建。' },
      overwrite: { type: 'boolean', title: '允许覆盖', description: '目标已存在时必须显式为 true。' },
    },
    required: ['file_path', 'content'],
  },
  handler: writeFileHandler,
}
