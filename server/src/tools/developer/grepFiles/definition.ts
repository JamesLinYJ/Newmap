// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文本搜索工具定义
//
//   文件:       definition.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolDef } from '../../../framework/types.js'
import { grepFilesHandler } from './handler.js'
import { GREP_FILES_PROMPT } from './prompt.js'

export const grepFilesTool: ToolDef = {
  name: 'grep_files',
  label: '文本搜索',
  description: '用 ripgrep 在允许根目录内搜索文本或正则表达式。',
  prompt: GREP_FILES_PROMPT,
  group: '开发工具',
  tags: ['developer', 'file', 'search', 'ripgrep'],
  isReadOnly: true,
  isDestructive: false,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', title: '正则模式', description: 'ripgrep 正则表达式。' },
      path: { type: 'string', title: '搜索根目录', description: '可选目录；省略时使用首个允许根。' },
      glob: { type: 'string', title: '文件 Glob', description: '例如 **/*.ts。' },
      case_insensitive: { type: 'boolean', title: '忽略大小写', description: '是否忽略大小写。' },
      head_limit: { type: 'integer', title: '结果上限', description: '最大返回匹配行数。', minimum: 1, maximum: 1000 },
      context: { type: 'integer', title: '上下文行数', description: '每个匹配周围的上下文行数，最多 5。', minimum: 0, maximum: 5 },
    },
    required: ['pattern'],
  },
  handler: grepFilesHandler,
}
