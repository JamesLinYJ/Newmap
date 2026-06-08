// 后台任务工具
import type { ToolDef } from '../../tools.js'
import { makeId, nowUtc } from '../../utils/ids.js'

const taskStore = new Map<string, { taskId: string; agentType: string; prompt: string; status: string; createdAt: string; resultSummary?: string }>()

export const taskCreateTool: ToolDef = {
  name: 'task_create', label: '创建后台任务',
  description: '创建一个异步后台任务，由子智能体在后台执行。',
  group: '系统', toolKind: 'registry', tags: ['task', 'async'],
  isReadOnly: false, isDestructive: false, isConcurrencySafe: true,

  jsonSchema: {
    type: 'object',
    properties: {
      agentType: { type: 'string', description: '子智能体类型（spatial_analyst, weather_analyst）' },
      prompt: { type: 'string', description: '任务描述/指令' },
    },
    required: ['agentType', 'prompt'],
  },

  async handler(args, _runtime) {
    const task = {
      taskId: makeId('task'), agentType: args.agentType as string,
      prompt: args.prompt as string, status: 'pending', createdAt: nowUtc(),
    }
    taskStore.set(task.taskId, task)
    return {
      message: `任务已创建: ${task.taskId}`,
      payload: task, warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'task',
    }
  },
}

export const taskListTool: ToolDef = {
  name: 'task_list', label: '列出任务',
  description: '列出所有后台任务及其状态。',
  group: '系统', toolKind: 'registry', tags: ['task', 'read'],
  isReadOnly: true, isDestructive: false, isConcurrencySafe: true,

  jsonSchema: { type: 'object', properties: {}, required: [] },

  async handler(_args, _runtime) {
    const tasks = [...taskStore.values()]
    return {
      message: tasks.length > 0 ? `共 ${tasks.length} 个任务` : '没有后台任务',
      payload: { tasks }, warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'task',
    }
  },
}
