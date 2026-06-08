import type { ToolDef } from '../../framework/types.js'
import { makeId, nowUtc } from '../../utils/ids.js'

const taskStore = new Map<string, { taskId: string; agentType: string; prompt: string; status: string; createdAt: string }>()

export const taskCreateTool: ToolDef = {
  name: 'task_create', label: '创建后台任务', description: '创建一个异步后台任务。',
  group: '系统', tags: ['task'], isReadOnly: false, isDestructive: false,
  jsonSchema: { type: 'object', properties: { agentType: { type: 'string' }, prompt: { type: 'string' } }, required: ['agentType', 'prompt'] },
  async handler(args, _ctx) {
    const task = { taskId: makeId('task'), agentType: args.agentType as string, prompt: args.prompt as string, status: 'pending', createdAt: nowUtc() }
    taskStore.set(task.taskId, task)
    return { message: `任务已创建: ${task.taskId}`, payload: task, resultId: makeId('result'), source: 'task', warnings: [] }
  },
}

export const taskListTool: ToolDef = {
  name: 'task_list', label: '列出任务', description: '列出所有后台任务。',
  group: '系统', tags: ['task', 'read'], isReadOnly: true, isDestructive: false,
  jsonSchema: { type: 'object', properties: {}, required: [] },
  async handler(_args, _ctx) {
    const tasks = [...taskStore.values()]
    return { message: tasks.length > 0 ? `共 ${tasks.length} 个任务` : '没有后台任务', payload: { tasks }, resultId: makeId('result'), source: 'task', warnings: [] }
  },
}
