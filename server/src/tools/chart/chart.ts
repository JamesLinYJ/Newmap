// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图表工具
//
//   文件:       chart.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 图表数据来自模型或 valueRef 解析结果；工具只生成规范化图表描述，
// 不在适配层推断或修补数据字段。
import type { ToolDef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'

export const chartTool: ToolDef = {
  name: 'create_chart', label: '生成图表', description: '根据数据生成统计图表（柱状图、折线图、饼图等）。',
  group: '可视化',  tags: ['chart', 'visualization'],
  isReadOnly: true, isDestructive: false, 

  jsonSchema: {
    type: 'object',
    properties: {
      chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter'], description: '图表类型' },
      title: { type: 'string', description: '图表标题' },
      data: { type: 'object', additionalProperties: true, description: '图表数据 { labels: string[], values: number[] }' },
    },
    required: ['chartType', 'data'],
  },

  async handler(args, _runtime) {
    const chartType = args.chartType as string
    const title = (args.title as string) ?? '图表'
    return {
      message: `${title} 已生成`,
      payload: { chartType, title, data: args.data, chartId: makeId('chart') },
      warnings: [], valueRefs: [{ refId: makeId('ref'), kind: 'chart', label: title, value: args.data }],
      resultId: makeId('result'), source: 'chart',
    }
  },
}
