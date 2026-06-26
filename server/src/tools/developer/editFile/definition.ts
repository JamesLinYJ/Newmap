// +-------------------------------------------------------------------------
//
//   地理智能平台 - 编辑文件工具定义
//
//   文件:       definition.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolDef } from '../../../framework/types.js'
import { editFileHandler } from './handler.js'
import { EDIT_FILE_PROMPT } from './prompt.js'

export const editFileTool: ToolDef = {
  name: 'edit_file',
  label: '编辑文件',
  description: '基于完整读取快照，对允许根目录内的 UTF-8 文本文件执行精确字符串替换。',
  prompt: EDIT_FILE_PROMPT,
  group: '开发工具',
  tags: ['developer', 'file', 'edit'],
  isReadOnly: false,
  isDestructive: true,
  requiresApproval: true,
  jsonSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', title: '文件路径', description: '目标文件路径。' },
      old_string: { type: 'string', title: '原文本', description: '必须精确匹配已读取内容。' },
      new_string: { type: 'string', title: '新文本', description: '替换后的文本。' },
      replace_all: { type: 'boolean', title: '替换全部', description: '当原文本出现多次时是否全部替换。' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  handler: editFileHandler,
}
