// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台进度卡片
//
//   文件:       WorkbenchProgressCard.tsx
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 将右侧检查区的任务进度从装饰卡片升级为真实状态投影。卡片只消费
// run、事件和待办事实源；展开详情仍交给历史面板，避免在这里复制日志。

import { ListChecks } from 'lucide-react'

import type { AnalysisRun, RunEvent } from '@geo-agent-platform/shared-types'
import type { ProgressTodoItem } from '../derivedState'
import { deriveWorkbenchProgressSummary, type WorkbenchProgressItem } from './WorkbenchProgressModel'

interface WorkbenchProgressCardProps {
  runStatus?: AnalysisRun['status']
  progressItems: ReadonlyArray<WorkbenchProgressItem>
  tasks: ReadonlyArray<ProgressTodoItem>
  events: ReadonlyArray<RunEvent>
  onOpenHistory: () => void
}

export function WorkbenchProgressCard({
  runStatus,
  progressItems,
  tasks,
  events,
  onOpenHistory,
}: WorkbenchProgressCardProps) {
  const summary = deriveWorkbenchProgressSummary({ runStatus, progressItems, tasks, events })

  return (
    <section
      className={`workbench-inspector-card workbench-inspector-card--progress workbench-progress-card workbench-progress-card--${summary.tone}`}
      aria-label="任务进度"
    >
      <div className="workbench-inspector-card__head">
        <div>
          <strong>任务进度</strong>
          <span>{summary.statusLabel}</span>
        </div>
        <button
          type="button"
          className="workbench-inspector-card__action"
          aria-label="查看详细进度"
          title="查看详细进度"
          onClick={onOpenHistory}
        >
          <ListChecks size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="workbench-progress-steps" aria-label="分析进度">
        {progressItems.map((item) => (
          <span
            key={item.id}
            className={`workbench-progress-step workbench-progress-step--${item.status}`}
            title={`${item.title}：${item.description}`}
          />
        ))}
      </div>

      <p>{summary.description}</p>
      <div className="workbench-progress-card__meta">
        <span>{summary.completedCount}/{summary.totalCount} 步完成</span>
        <strong>{summary.latestDetail}</strong>
      </div>
    </section>
  )
}
