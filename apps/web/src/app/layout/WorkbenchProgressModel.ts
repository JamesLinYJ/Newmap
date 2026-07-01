// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台进度派生模型
//
//   文件:       WorkbenchProgressModel.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 进度卡的事实派生
//
// 这个文件只做 run、任务和事件到 UI 文案的投影，避免进度卡组件混入
// 非组件导出，也避免右侧检查区重新发明运行状态。

import type { AnalysisRun, RunEvent } from '@geo-agent-platform/shared-types'
import { formatUiRunEventMessage, type ProgressTodoItem } from '../derivedState'

export interface WorkbenchProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

export interface WorkbenchProgressSummary {
  title: string
  statusLabel: string
  tone: 'idle' | 'running' | 'done' | 'warning'
  description: string
  latestDetail: string
  completedCount: number
  totalCount: number
}

export function deriveWorkbenchProgressSummary({
  runStatus,
  progressItems,
  tasks,
  events,
}: {
  runStatus?: AnalysisRun['status']
  progressItems: ReadonlyArray<WorkbenchProgressItem>
  tasks: ReadonlyArray<ProgressTodoItem>
  events: ReadonlyArray<RunEvent>
}): WorkbenchProgressSummary {
  const completedCount = progressItems.filter(item => item.status === 'done').length
  const totalCount = Math.max(progressItems.length, 1)
  const activeItem = progressItems.find(item => item.status === 'active')
  const warningItem = progressItems.find(item => item.status === 'warning')
  const latestTask = [...tasks].reverse().find(task => task.status === 'running' || task.status === 'completed') ?? tasks.at(-1)
  const latestEvent = events.at(-1)

  if (runStatus === 'completed') {
    return {
      title: '任务进度',
      statusLabel: '分析完成',
      tone: 'done',
      description: '本轮分析已完成，结果图层和摘要可以继续查看或导出。',
      latestDetail: latestTask?.content ?? '结果已经整理完成',
      completedCount: totalCount,
      totalCount,
    }
  }

  if (runStatus === 'failed' || runStatus === 'cancelled') {
    return {
      title: '任务进度',
      statusLabel: runStatus === 'cancelled' ? '已取消' : '分析失败',
      tone: 'warning',
      description: warningItem?.description ?? '本次分析没有完成，请查看执行历史里的失败原因。',
      latestDetail: latestTask?.activeForm ?? formatUiRunEventMessage(latestEvent),
      completedCount,
      totalCount,
    }
  }

  if (runStatus === 'running' || runStatus === 'waiting_approval' || runStatus === 'clarification_needed') {
    return {
      title: '任务进度',
      statusLabel: runStatus === 'waiting_approval' ? '等待审批' : runStatus === 'clarification_needed' ? '等待澄清' : '正在分析',
      tone: 'running',
      description: activeItem?.description ?? '系统正在按计划执行分析步骤。',
      latestDetail: latestTask?.activeForm ?? formatUiRunEventMessage(latestEvent),
      completedCount,
      totalCount,
    }
  }

  return {
    title: '任务进度',
    statusLabel: '等待输入',
    tone: 'idle',
    description: '提交问题后，这里会显示理解需求、准备数据、执行分析和交付结果的进度。',
    latestDetail: '暂无运行任务',
    completedCount,
    totalCount,
  }
}
