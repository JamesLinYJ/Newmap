// +-------------------------------------------------------------------------
//
//   地理智能平台 - Todo 写入工具定义
//
//   文件:       definition.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolDef } from '../../../framework/types.js'
import { todoWriteHandler } from './handler.js'
import { TODO_WRITE_PROMPT } from './prompt.js'

export const todoWriteTool: ToolDef = {
  name: 'todo_write',
  label: '更新 Todo',
  description: '更新当前运行的可见 Todo 列表。',
  prompt: TODO_WRITE_PROMPT,
  group: '开发工具',
  tags: ['developer', 'todo', 'state'],
  isReadOnly: false,
  isDestructive: false,
  jsonSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        title: 'Todo 列表',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            todoId: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'blocked'] },
            description: { type: 'string' },
            activeForm: { type: 'string' },
            ownerAgentId: { type: 'string' },
            stepId: { type: 'string' },
          },
          required: ['status'],
        },
      },
    },
    required: ['todos'],
  },
  handler: todoWriteHandler,
}
