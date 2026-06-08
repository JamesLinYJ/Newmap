// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线
//
//   文件:       ConversationTimeline.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 维护聊天时间线的滚动、空状态和辅助面板渲染。输入只接受
// ConversationEntry[]，诊断 RunEvent 面板不得接入这里。

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, m, type Variants } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { AppIcon } from '../../shared/components/AppIcon'
import { buildFadeUpMotion } from '../../shared/motion'
import type { DataReferenceSummary } from '../../shared/constants'
import type { ConversationEntry } from './items'
import type { ActiveClarification, ChatPanelProps, MemoryEntry } from './types'
import { ConversationEntryView } from './ConversationEntry'
import { formatTaskStatus } from './entryFormat'
import { fmtElapsed } from './useConversation'

interface ConversationTimelineProps {
  conversation: ConversationEntry[]
  activeClarification: ActiveClarification | null
  clarificationBusy: boolean
  isSubmitting: boolean
  errorMessage?: string
  errorTitle: string
  dataReferences: DataReferenceSummary[]
  uploadedLayerName?: string
  runCreatedAt?: string
  runStatus?: string
  executionPlan?: ChatPanelProps['executionPlan']
  progressTasks?: ChatPanelProps['tasks']
  memories?: MemoryEntry[]
  onRefreshMemories?: () => void
  onApprovePlan?: () => void
  onEditPlan?: () => void
  onSelectArtifact: (id: string) => void
  onResolveApproval: (id: string, approved: boolean) => void
  onRetry: () => void
  onFocusClarification: () => void
  feedVariants: Variants
  entryVariants: Variants
  reducedMotion: boolean
}

export function ConversationTimeline({
  conversation,
  activeClarification,
  clarificationBusy,
  isSubmitting,
  errorMessage,
  errorTitle,
  dataReferences,
  uploadedLayerName,
  runCreatedAt,
  runStatus,
  executionPlan,
  progressTasks,
  memories,
  onRefreshMemories,
  onApprovePlan,
  onEditPlan,
  onSelectArtifact,
  onResolveApproval,
  onRetry,
  onFocusClarification,
  feedVariants,
  entryVariants,
  reducedMotion,
}: ConversationTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const timelineRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  const handleTimelineScroll = () => {
    const el = timelineRef.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // 新消息到达时自动滚到底部，除非用户手动上滚。
  useEffect(() => {
    const el = timelineRef.current
    if (!el || !nearBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [conversation])

  return (
    <m.div className="cc-chat-mode" layout>
      <m.div ref={timelineRef} onScroll={handleTimelineScroll} className="cc-timeline" aria-label="对话" aria-live="polite" variants={feedVariants} initial="hidden" animate="visible">
        {executionPlan && executionPlan.steps.length > 0 && (
          <PlanPanel plan={executionPlan} onApprove={onApprovePlan} onEdit={onEditPlan} entryVariants={entryVariants} />
        )}
        {progressTasks && progressTasks.length > 0 && (
          <TaskPanel tasks={progressTasks} entryVariants={entryVariants} />
        )}
        {memories && memories.length > 0 && (
          <MemoryPanel memories={memories} onRefresh={onRefreshMemories} />
        )}
        {activeClarification && (
          <m.div key={activeClarification.key} className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
            <span className="cc-timeline-dot" />
            <div className="cc-timeline-body">
              <div className="cc-clarification-card">
                <div className="cc-clarification-card__copy">
                  <strong>需要确认</strong>
                  <span>{activeClarification.question}</span>
                </div>
                <button className="cc-mini-button cc-mini-button--primary" disabled={clarificationBusy} onClick={onFocusClarification}>
                  选择答案
                </button>
              </div>
            </div>
          </m.div>
        )}
        {errorMessage && (
          <m.div className="cc-timeline-item cc-timeline-item--error" role="alert" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
            <span className="cc-timeline-dot" />
            <div className="cc-timeline-body">
              <div className="cc-error-card">
                <strong>{errorTitle}</strong>
                <span>{errorMessage}</span>
                <button className="cc-mini-button" onClick={onRetry}>
                  重试
                </button>
              </div>
            </div>
          </m.div>
        )}
        {conversation.length ? (
          <AnimatePresence initial={false}>
            {conversation.map((entry) => (
              <ConversationEntryView
                key={entry.id}
                entry={entry}
                entryVariants={entryVariants}
                reducedMotion={reducedMotion}
                expandedIds={expandedIds}
                onToggleExpanded={toggleExpanded}
                onSelectArtifact={onSelectArtifact}
                onResolveApproval={onResolveApproval}
              />
            ))}
          </AnimatePresence>
        ) : isSubmitting ? (
          <m.div className="cc-timeline-item cc-timeline-item--running" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
            <span className="cc-timeline-dot" />
            <div className="cc-timeline-body">
              <button className="cc-thought-toggle" type="button">
                <span>正在思考…</span>
                <ChevronDown size={14} />
              </button>
              <div className="cc-assistant-copy">
                <p>正在分析你的问题...</p>
              </div>
            </div>
          </m.div>
        ) : (
          <m.div className="cc-empty cc-empty--chat" layout {...buildFadeUpMotion(reducedMotion, 0, 12)}>
            {dataReferences.length ? (
              <DataReferenceCard references={dataReferences} />
            ) : (
              <>
                <strong>有什么可以帮你分析？</strong>
                <span>输入一个地点、范围、图层或空间关系，我会把过程放在这条时间线上。</span>
              </>
            )}
          </m.div>
        )}
      </m.div>

      <div className="cc-run-footer">
        <span>{runCreatedAt && runStatus === 'running' ? `运行中 ${fmtElapsed(runCreatedAt)}` : '输入空间问题，按回车开始分析'}</span>
        {dataReferences.length ? <span>引用 {dataReferences.length} 个数据</span> : uploadedLayerName && <span>已接入 {uploadedLayerName}</span>}
      </div>
    </m.div>
  )
}

function MemoryPanel({ memories, onRefresh }: { memories: MemoryEntry[]; onRefresh?: () => void }) {
  const [isOpen, setIsOpen] = useState(false)
  if (!memories.length) return null

  return (
    <div className="cc-memory-panel">
      <button className="cc-memory-panel__toggle" type="button" onClick={() => setIsOpen(!isOpen)}>
        <ChevronDown size={14} className={`cc-chevron ${isOpen ? 'cc-chevron--open' : ''}`} />
        <span>记忆系统</span>
        <span className="cc-memory-panel__count">{memories.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <m.div className="cc-memory-panel__list" {...buildFadeUpMotion(false, 0, 4)}>
            {memories.map((mem) => {
              const typeLabel = ({ user: '用户', feedback: '反馈', project: '项目', reference: '参考' } as Record<string, string>)[mem.type] ?? mem.type
              return (
                <div key={mem.name} className="cc-memory-item">
                  <span className={`cc-memory-item__type cc-memory-item__type--${mem.type}`}>{typeLabel}</span>
                  <div className="cc-memory-item__body">
                    <strong>{mem.name}</strong>
                    <span>{mem.description}</span>
                  </div>
                  <span className="cc-memory-item__age">{mem.age}</span>
                </div>
              )
            })}
            {onRefresh && (
              <button className="cc-memory-panel__refresh" type="button" onClick={onRefresh}>刷新记忆</button>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DataReferenceCard({ references }: { references: DataReferenceSummary[] }) {
  const visible = references.slice(0, 8)
  const hiddenCount = Math.max(0, references.length - visible.length)
  return (
    <div className="cc-data-context">
      <div className="cc-data-context__head">
        <strong>当前引用的数据</strong>
        <span>{references.length} 个文件/结果</span>
      </div>
      <div className="cc-data-context__list">
        {visible.map((reference) => (
          <div key={reference.id} className="cc-data-reference">
            <span className={`cc-data-reference__kind cc-data-reference__kind--${reference.kind}`}>{formatReferenceKind(reference.kind)}</span>
            <span className="cc-data-reference__main">
              <strong title={reference.relativePath ?? reference.name}>{reference.relativePath ?? reference.name}</strong>
              <small>{reference.detail}</small>
            </span>
            <span className="cc-data-reference__status">{reference.status}</span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && <span className="cc-data-context__more">还有 {hiddenCount} 个文件已接入，可在数据源面板查看。</span>}
    </div>
  )
}

function PlanPanel({ plan, onApprove, onEdit, entryVariants }: {
  plan: NonNullable<ChatPanelProps['executionPlan']>
  onApprove?: () => void
  onEdit?: () => void
  entryVariants: Variants
}) {
  return (
    <m.div key="plan-panel" className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
      <span className="cc-timeline-dot" />
      <div className="cc-timeline-body">
        <div className="cc-plan-panel">
          <div className="cc-plan-panel__header">
            <AppIcon name="psychology" size={16} />
            <span>执行计划</span>
          </div>
          <div className="cc-plan-panel__goal">{plan.goal}</div>
          <div className="cc-plan-steps">
            {plan.steps.map((step, i) => (
              <div key={i} className="cc-plan-step">
                <span className="cc-plan-step__num">{i + 1}</span>
                <div className="cc-plan-step__body">
                  <span className="cc-plan-step__tool">{step.tool}</span>
                  {step.args && Object.keys(step.args).length > 0 && (
                    <code className="cc-plan-step__args">{JSON.stringify(step.args)}</code>
                  )}
                  <span className="cc-plan-step__reason">{step.reason}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="cc-plan-actions">
            {onApprove && (
              <button className="cc-mini-button cc-mini-button--primary" onClick={onApprove}>确认执行</button>
            )}
            {onEdit && (
              <button className="cc-mini-button" onClick={onEdit}>修改计划</button>
            )}
          </div>
        </div>
      </div>
    </m.div>
  )
}

function TaskPanel({ tasks, entryVariants }: {
  tasks: NonNullable<ChatPanelProps['tasks']>
  entryVariants: Variants
}) {
  const completed = tasks.filter(t => t.status === 'completed').length
  const total = tasks.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  const currentTask = tasks.find((task) => task.status === 'running') ?? tasks.find((task) => task.status === 'pending') ?? tasks.at(-1)
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <m.div key="task-progress" className="cc-timeline-item cc-timeline-item--todo" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
      <span className="cc-timeline-dot" />
      <div className="cc-timeline-body">
        <div className="cc-task-progress">
          <div className="cc-task-progress__header">
            <strong>Todo</strong>
            <span>{completed}/{total} 完成</span>
          </div>
          {currentTask && (
            <div className="cc-task-progress__current">
              <span>{formatTaskStatus(currentTask.status)}</span>
              <strong>{currentTask.status === 'running' ? currentTask.activeForm || currentTask.content : currentTask.content}</strong>
            </div>
          )}
          <div className="cc-task-progress__bar">
            <div className="cc-task-progress__fill" style={{ width: `${pct}%` }} />
          </div>
          <button className="cc-thought-toggle" type="button" onClick={() => setIsExpanded(!isExpanded)}>
            <ChevronDown size={14} className={`cc-chevron ${isExpanded ? 'cc-chevron--open' : ''}`} />
            <span>{isExpanded ? '收起 Todo' : '展开 Todo'}</span>
          </button>
          <AnimatePresence initial={false}>
            {isExpanded && (
              <m.div className="cc-task-progress__list" {...buildFadeUpMotion(false, 0, 4)}>
                {tasks.map(task => (
                  <div key={task.id} className="cc-task-progress-item">
                    <span className="cc-task-progress-item__content">{task.content}</span>
                    <span className={`cc-task-progress-item__tag cc-task-progress-item__tag--${task.status}`}>
                      {formatTaskStatus(task.status)}
                    </span>
                  </div>
                ))}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </m.div>
  )
}

function formatReferenceKind(kind: DataReferenceSummary['kind']) {
  if (kind === 'weather') return '气象'
  if (kind === 'artifact') return '结果'
  return '图层'
}
