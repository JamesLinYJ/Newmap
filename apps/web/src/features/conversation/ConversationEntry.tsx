// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话条目渲染
//
//   文件:       ConversationEntry.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 渲染 ConversationItem 派生出的单条展示 entry。这里不读取 RunEvent，
// 也不维护运行状态，只负责把 item 投影成稳定的聊天 UI。

import { AnimatePresence, m, type Variants } from 'framer-motion'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { buildFadeMotion, buildFadeUpMotion } from '../../shared/motion'
import { Markdown } from '../../shared/components/Markdown'
import { VoiceBar } from './VoiceBar'
import type { ConversationCommand, ConversationEntry } from './items'

interface ConversationEntryViewProps {
  entry: ConversationEntry
  entryVariants: Variants
  reducedMotion: boolean
  expandedIds: Set<string>
  onToggleExpanded: (id: string) => void
  onSelectArtifact: (id: string) => void
  onResolveApproval: (id: string, approved: boolean) => void
}

export function ConversationEntryView({
  entry,
  entryVariants,
  reducedMotion,
  expandedIds,
  onToggleExpanded,
  onSelectArtifact,
  onResolveApproval,
}: ConversationEntryViewProps) {
  if (entry.kind === 'message' && entry.role === 'user') {
    return (
      <m.div key={entry.id} className="cc-user-prompt" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        {entry.body}
      </m.div>
    )
  }

  if (entry.kind === 'message' && entry.role === 'assistant') {
    const isThought = isThoughtEntry(entry)
    const thoughtExpanded = isThought && expandedIds.has(entry.id)
    // 思考与回答走普通 DOM 渲染，不参与列表入场位移动画。
    //
    // 流式回答一到就直接占位显示，避免思考折叠完成后正文再“弹入”。
    return (
      <div
        key={entry.id}
        className={`cc-timeline-item ${isThought ? 'cc-timeline-item--thought' : 'cc-timeline-item--answer'}`}
      >
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          {isThought ? (
            <>
              <button className="cc-thought-toggle" type="button" aria-expanded={thoughtExpanded} onClick={() => onToggleExpanded(entry.id)}>
                <span>{formatThoughtLabel(entry)}</span>
                <ChevronDown size={14} className={`cc-chevron ${thoughtExpanded ? 'cc-chevron--open' : ''}`} />
                {entry.status === 'running' && <span className="cc-thinking-pulse" />}
              </button>
              <AnimatePresence initial={false}>
                {thoughtExpanded && (
                  <m.div className="cc-assistant-copy cc-assistant-copy--thought" {...buildFadeMotion(reducedMotion)}>
                    <Markdown streaming={entry.status === 'running'}>{entry.body}</Markdown>
                  </m.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <div className="cc-assistant-copy">
              <Markdown streaming={entry.status === 'running'}>{entry.body}</Markdown>
            </div>
          )}
          {entry.artifactId && (
            <button className="cc-mini-button mt-2" onClick={() => onSelectArtifact(entry.artifactId!)}>
              在地图中查看
            </button>
          )}
        </div>
      </div>
    )
  }

  if (entry.kind === 'command_batch') {
    const commands = entry.commands ?? []
    if (commands.length === 1 && commands[0].toolName === 'synthesize_speech') {
      return (
        <div key={entry.id} className="cc-timeline-item cc-timeline-item--answer">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <VoiceBar
              text={extractSpeechText(commands[0])}
              messageId={entry.id}
              initialAudioUrl={extractSpeechAudioUrl(commands[0])}
            />
          </div>
        </div>
      )
    }
    if (commands.length === 1 && commands[0].toolName === 'answer_nowcast_question') {
      const forecastText = (commands[0].body ?? '').trim()
      return (
        <div key={entry.id} className="cc-timeline-item cc-timeline-item--answer">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <div className="cc-result-card">
              {forecastText || '暂无数据'}
            </div>
          </div>
        </div>
      )
    }
    return (
      <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--tool" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          {commands.length > 1 && (
            <div className="cc-command-summary cc-command-summary--static">
              <span>{formatCommandBatchTitle(entry)}</span>
            </div>
          )}
          <m.div className="cc-tool-stack" {...buildFadeUpMotion(reducedMotion, 0, 6)}>
            {commands.map((command) => (
              <ToolCommandCard
                key={command.id}
                command={command}
              />
            ))}
          </m.div>
        </div>
      </m.div>
    )
  }

  if (entry.kind === 'approval') {
    return (
      <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--notice" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          <ApprovalCard entry={entry} onResolve={onResolveApproval} />
        </div>
      </m.div>
    )
  }

  if (entry.kind === 'error') {
    return (
      <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--error" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          <div className="cc-error-card">
            <strong>{entry.title || '运行遇到问题'}</strong>
            <span>{entry.body}</span>
            {entry.recoveryNote && <em>{entry.recoveryNote}</em>}
          </div>
        </div>
      </m.div>
    )
  }

  if (entry.kind === 'system') {
    return (
      <m.div key={entry.id} className="cc-timeline-item cc-timeline-item--system" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span className="cc-timeline-dot" />
        <div className="cc-timeline-body">
          <div className="cc-system-card">
            <span className="cc-system-card__badge">{entry.title}</span>
            <span>{entry.body}</span>
          </div>
        </div>
      </m.div>
    )
  }

  return null
}

function ApprovalCard({ entry, onResolve }: { entry: ConversationEntry; onResolve: (id: string, approved: boolean) => void }) {
  return (
    <>
      <pre className="cc-task-notice">{buildTaskNotification(entry)}</pre>
      <div className="cc-approval-copy">
        <strong>{entry.title}</strong>
        <span>{entry.body}</span>
      </div>
      {entry.approvalId && (
        <div className="cc-approval-actions">
          <button className="cc-mini-button cc-mini-button--primary" onClick={() => onResolve(entry.approvalId!, true)}>
            批准发布
          </button>
          <button className="cc-mini-button" onClick={() => onResolve(entry.approvalId!, false)}>
            暂不发布
          </button>
        </div>
      )}
    </>
  )
}

function ToolCommandCard({ command }: { command: ConversationCommand }) {
  const isRunning = command.status === 'running'
  const resultText = formatCommandOutput(command)
  const hasInput = Boolean(command.commandText)
  const showOutput = isRunning || Boolean(resultText)

  return (
    <div className="cc-tool-row">
      <div className="cc-tool-row-head">
        <span className="cc-tool-row-title">{formatToolKindLabel(command)}</span>
        <span className="cc-tool-row-subtitle">{formatToolActionLabel(command)}</span>
        {isRunning && <LoaderCircle size={13} className="cc-tool-row-spinner" />}
      </div>
      {(hasInput || showOutput) && (
        <m.div className="cc-tool-io-card" {...buildFadeUpMotion(false, 0, 4)}>
          {hasInput && (
            <div className="cc-tool-io-section">
              <span className="cc-tool-io-label">输入</span>
              <pre>{command.commandText?.replace(/^>\s*/u, '').trim()}</pre>
            </div>
          )}
          {showOutput && (
            <div className="cc-tool-io-section cc-tool-io-section--output">
              <span className="cc-tool-io-label">输出</span>
              {isRunning ? (
                <pre>执行中，等待工具返回...</pre>
              ) : (
                <pre>{formatToolOutput(resultText)}</pre>
              )}
            </div>
          )}
        </m.div>
      )}
    </div>
  )
}

function extractSpeechText(command: ConversationCommand) {
  const result = command.details?.result
  if (isRecord(result)) {
    const text = stringOrNull(result.text)
    if (text) return text
  }
  const args = command.details?.args
  if (isRecord(args)) {
    const text = stringOrNull(args.text)
    if (text) return text
  }
  return command.body
}

function extractSpeechAudioUrl(command: ConversationCommand) {
  const result = command.details?.result
  if (isRecord(result)) {
    return stringOrNull(result.audio_url ?? result.audioUrl)
  }
  return stringOrNull(command.details?.audio_url ?? command.details?.audioUrl)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function isThoughtEntry(entry: ConversationEntry) {
  return entry.badge === 'thinking'
}

function formatThoughtLabel(entry: ConversationEntry) {
  if (entry.status === 'running') return '思考中'
  return '思考过程'
}

function formatCommandBatchTitle(entry: ConversationEntry) {
  const count = entry.commands?.length ?? 0
  if (entry.status === 'running') return `正在执行 ${count} 个工具`
  if (entry.status === 'failed') return `${count} 个工具里有失败项`
  return `已完成 ${count} 个工具`
}

function formatCommandStatus(status: string) {
  if (status === 'running') return '执行中'
  if (status === 'failed') return '失败'
  return '完成'
}

function formatToolKindLabel(command: ConversationCommand) {
  return command.title.trim() || '工具调用'
}

function formatToolActionLabel(command: ConversationCommand) {
  return formatCommandStatus(command.status)
}

function formatCommandOutput(command: ConversationCommand) {
  if (command.status === 'running') {
    return '工具正在后台运行，完成后会在这里显示结果。'
  }
  const body = command.body.trim()
  return body || formatCommandStatus(command.status)
}

function formatToolOutput(value: string) {
  return value.trim() || '完成'
}

function buildTaskNotification(entry: ConversationEntry) {
  const taskId = entry.approvalId ?? entry.artifactId ?? entry.id
  return [`<task-notification>`, `<task-id>${taskId}</task-id>`, `<status>${entry.badge ?? entry.status}</status>`].join('\n')
}
