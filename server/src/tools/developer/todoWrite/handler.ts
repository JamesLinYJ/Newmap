// +-------------------------------------------------------------------------
//
//   地理智能平台 - Todo 写入工具实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolHandler } from '../../../framework/types.js'
import { makeId } from '../../../utils/ids.js'
import { developerResult } from '../shared/result.js'

const TODO_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'blocked'])

export const todoWriteHandler: ToolHandler = async (args, context) => {
  if (!Array.isArray(args.todos)) throw new Error('todos 必须是数组')
  const todos = args.todos.map((todo, index) => normalizeTodo(todo, index))
  const runningCount = todos.filter(todo => todo.status === 'running').length
  if (runningCount > 1) throw new Error('同一时间最多只能有一个 running Todo')
  return developerResult('todo_write', `已更新 ${todos.length} 个 Todo`, {
    todos: todos.map(todo => ({ ...todo, ownerAgentId: todo.ownerAgentId ?? context.threadId ?? context.sessionId })),
  }, {
    provenance: {
      access: 'run_state',
      stateField: 'todos',
    },
  })
}

function normalizeTodo(value: unknown, index: number) {
  if (!isRecord(value)) throw new Error(`todos[${index}] 必须是对象`)
  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title.trim()
    : typeof value.content === 'string' && value.content.trim()
      ? value.content.trim()
      : ''
  if (!title) throw new Error(`todos[${index}].title 不能为空`)
  const rawStatus = typeof value.status === 'string' ? value.status : 'pending'
  if (!TODO_STATUSES.has(rawStatus)) throw new Error(`todos[${index}].status 不受支持：${rawStatus}`)
  return {
    todoId: typeof value.todoId === 'string' && value.todoId.trim()
      ? value.todoId.trim()
      : typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : makeId('todo'),
    title,
    status: rawStatus,
    description: typeof value.description === 'string' && value.description.trim() ? value.description.trim() : null,
    activeForm: typeof value.activeForm === 'string' && value.activeForm.trim() ? value.activeForm.trim() : null,
    ownerAgentId: typeof value.ownerAgentId === 'string' && value.ownerAgentId.trim() ? value.ownerAgentId.trim() : null,
    stepId: typeof value.stepId === 'string' && value.stepId.trim() ? value.stepId.trim() : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
