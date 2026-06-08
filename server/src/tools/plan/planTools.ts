// 计划模式工具
import type { ToolDef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'

export const enterPlanModeTool: ToolDef = {
  name: 'enter_plan_mode', label: '进入计划模式',
  description: '进入只读探索模式，只允许查询和分析操作，不能修改数据。',
  group: '系统',  tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false, 

  jsonSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: '进入计划模式的原因' } },
    required: [],
  },

  async handler(args, runtime) {
    return {
      message: `已进入计划模式。原因: ${(args.reason as string) ?? '用户请求'}`,
      payload: { planMode: true, runId: runtime.runId },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}

export const exitPlanModeTool: ToolDef = {
  name: 'exit_plan_mode', label: '退出计划模式',
  description: '退出只读探索模式，恢复完整工具访问权限。',
  group: '系统',  tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false, 

  jsonSchema: {
    type: 'object',
    properties: { plan: { type: 'object', description: '执行计划' } },
    required: [],
  },

  async handler(args, runtime) {
    return {
      message: `已退出计划模式`,
      payload: { planMode: false, plan: args.plan, runId: runtime.runId },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}
