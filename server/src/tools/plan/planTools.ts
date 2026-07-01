// +-------------------------------------------------------------------------
//
//   地理智能平台 - 计划模式工具
//
//   文件:       planTools.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 计划模式只改变运行约束，不执行业务写入。
// exit_plan_mode 必须先经过 Agents SDK approval，批准后才会写回 executionPlan。
import type { ToolDef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import {
  ENTER_PLAN_MODE_DESCRIPTION,
  ENTER_PLAN_MODE_PROMPT,
  EXIT_PLAN_MODE_DESCRIPTION,
  EXIT_PLAN_MODE_PROMPT,
  REQUEST_CLARIFICATION_DESCRIPTION,
  REQUEST_CLARIFICATION_PROMPT,
} from './prompts.js'

export const requestClarificationTool: ToolDef = {
  name: 'request_clarification', label: '请求澄清',
  description: REQUEST_CLARIFICATION_DESCRIPTION,
  prompt: REQUEST_CLARIFICATION_PROMPT,
  group: '系统', tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false,

  jsonSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '向用户提出的澄清问题。' },
      reason: { type: 'string', description: '为什么必须先澄清。' },
      options: {
        type: 'array',
        description: '可选的快捷选项。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: '选项按钮文本。' },
            description: { type: 'string', description: '选项说明。' },
          },
          required: ['label'],
        },
      },
      allowFreeText: { type: 'boolean', description: '是否允许用户自由输入补充。' },
    },
    required: ['question', 'reason'],
  },

  async handler(args, runtime) {
    const options = Array.isArray(args.options)
      ? args.options.filter(isRecord).map((option, index) => ({
        optionId: `clarification_option_${index + 1}`,
        label: typeof option.label === 'string' ? option.label : `选项 ${index + 1}`,
        description: typeof option.description === 'string' ? option.description : '',
        kind: 'generic',
        reason: null,
        payload: {},
      }))
      : []
    return {
      message: '需要用户补充信息。',
      payload: {
        runId: runtime.runId,
        clarification: {
          clarificationId: makeId('clarification'),
          kind: 'plan_requirement',
          reason: String(args.reason),
          question: String(args.question),
          options,
          selectedOptionId: null,
          allowFreeText: typeof args.allowFreeText === 'boolean' ? args.allowFreeText : true,
        },
      },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}

export const enterPlanModeTool: ToolDef = {
  name: 'enter_plan_mode', label: '进入计划模式',
  description: ENTER_PLAN_MODE_DESCRIPTION,
  prompt: ENTER_PLAN_MODE_PROMPT,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const exitPlanModeTool: ToolDef = {
  name: 'exit_plan_mode', label: '退出计划模式',
  description: EXIT_PLAN_MODE_DESCRIPTION,
  prompt: EXIT_PLAN_MODE_PROMPT,
  group: '系统',  tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false, 
  requiresApproval: true,

  jsonSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        additionalProperties: false,
        description: '待用户批准的执行计划。',
        properties: {
          goal: { type: 'string', description: '本轮实施目标。' },
          steps: {
            type: 'array',
            description: '按执行顺序排列的计划步骤。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: '步骤 ID，例如 step_1。' },
                tool: { type: 'string', description: '预计使用的工具或 manual。' },
                args: { type: 'object', additionalProperties: true, description: '预计工具参数；无法确定时使用空对象。' },
                reason: { type: 'string', description: '为什么需要这一步。' },
              },
              required: ['id', 'tool', 'reason'],
            },
          },
        },
        required: ['goal', 'steps'],
      },
      allowedPrompts: {
        type: 'array',
        description: '计划获批后建议允许的动作类别。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: { type: 'string', description: '工具名称，例如 Bash。' },
            prompt: { type: 'string', description: '动作类别，例如运行测试。' },
          },
          required: ['tool', 'prompt'],
        },
      },
    },
    required: ['plan'],
  },

  async handler(args, runtime) {
    return {
      message: '计划已批准，已退出计划模式。',
      payload: {
        planMode: false,
        plan: args.plan,
        allowedPrompts: Array.isArray(args.allowedPrompts) ? args.allowedPrompts : [],
        runId: runtime.runId,
      },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}
