// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台进度卡规则测试
//
//   文件:       workbenchProgressCard.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { deriveWorkbenchProgressSummary } from '../app/layout/WorkbenchProgressModel'

const progressItems = [
  { id: 'understand', title: '理解需求', description: '正在理解问题', status: 'done' as const },
  { id: 'data', title: '准备数据', description: '正在准备数据', status: 'active' as const },
  { id: 'deliver', title: '交付结果', description: '等待交付结果', status: 'pending' as const },
]

describe('workbench progress card model', () => {
  it('shows idle copy before any run starts', () => {
    // 进度卡不能再用装饰圆点兜底；没有运行时必须明确说明等待用户输入。
    const summary = deriveWorkbenchProgressSummary({ progressItems: [], tasks: [], events: [] })

    expect(summary.statusLabel).toBe('等待输入')
    expect(summary.description).toContain('提交问题后')
    expect(summary.latestDetail).toBe('暂无运行任务')
  })

  it('derives running status from active progress and task facts', () => {
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'running',
      progressItems,
      tasks: [{ id: 'task_1', content: '准备 NetCDF 元数据', activeForm: '正在读取 NetCDF 元数据', status: 'running' }],
      events: [],
    })

    expect(summary.statusLabel).toBe('正在分析')
    expect(summary.description).toBe('正在准备数据')
    expect(summary.latestDetail).toBe('正在读取 NetCDF 元数据')
    expect(summary.completedCount).toBe(1)
  })

  it('marks completed runs with delivery copy and full completion count', () => {
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'completed',
      progressItems,
      tasks: [{ id: 'task_2', content: '已生成气象分析摘要', activeForm: '生成摘要', status: 'completed' }],
      events: [],
    })

    expect(summary.statusLabel).toBe('分析完成')
    expect(summary.tone).toBe('done')
    expect(summary.completedCount).toBe(summary.totalCount)
    expect(summary.latestDetail).toBe('已生成气象分析摘要')
  })

  it('surfaces failed runs as warnings with a concrete latest detail', () => {
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'failed',
      progressItems: [
        progressItems[0],
        { id: 'data', title: '准备数据', description: '数据读取失败', status: 'warning' as const },
      ],
      tasks: [],
      events: [{ type: 'run.failed', message: 'NetCDF 文件不可读' } as never],
    })

    expect(summary.statusLabel).toBe('分析失败')
    expect(summary.tone).toBe('warning')
    expect(summary.description).toBe('数据读取失败')
    expect(summary.latestDetail).toBe('分析没有顺利完成，请稍后重试。')
  })
})
