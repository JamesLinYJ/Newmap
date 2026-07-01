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
import { CheckCircle2, ChevronDown, GitBranchPlus, LoaderCircle, ShieldCheck } from 'lucide-react'
import { buildFadeMotion, buildFadeUpMotion } from '../../shared/motion'
import { Markdown } from '../../shared/components/Markdown'
import { VoiceBar } from './VoiceBar'
import { ToolMiniAppResult } from '../tools/ToolMiniApp'
import { miniAppKindForTool } from '../tools/toolMiniAppModel'
import type { ConversationCommand, ConversationEntry } from './items'

interface ConversationEntryViewProps {
  entry: ConversationEntry
  entryVariants: Variants
  reducedMotion: boolean
  expandedIds: Set<string>
  onToggleExpanded: (id: string) => void
  onSelectArtifact: (id: string) => void
  onForkMessage?: (entryId: string) => void
}

export function ConversationEntryView({
  entry,
  entryVariants,
  reducedMotion,
  expandedIds,
  onToggleExpanded,
  onSelectArtifact,
  onForkMessage,
}: ConversationEntryViewProps) {
  if (entry.kind === 'message' && entry.role === 'user') {
    const sourceEntryId = transcriptEntryId(entry)
    return (
      <m.div key={entry.id} className="cc-user-prompt" role="article" aria-label="用户消息" layout variants={entryVariants} initial="hidden" animate="visible" exit="exit">
        <span>{entry.body}</span>
        {sourceEntryId && onForkMessage && (
          <button className="cc-message-branch" type="button" onClick={() => onForkMessage(sourceEntryId)} title="从这里新建分支">
            <GitBranchPlus size={13} />
          </button>
        )}
      </m.div>
    )
  }

  if (entry.kind === 'message' && entry.role === 'assistant') {
    const isThought = isThoughtEntry(entry)
    const thoughtExpanded = isThought && expandedIds.has(entry.id)
    const sourceEntryId = transcriptEntryId(entry)
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
          {!isThought && sourceEntryId && onForkMessage && (
            <button className="cc-message-branch cc-message-branch--assistant" type="button" onClick={() => onForkMessage(sourceEntryId)}>
              <GitBranchPlus size={13} /> 从这里分支
            </button>
          )}
        </div>
      </div>
    )
  }

  if (entry.kind === 'command_batch') {
    const commands = entry.commands ?? []
    if (commands.length === 1 && isSpeechSynthesisCommand(commands[0])) {
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
      const forecastText = extractNowcastAnswer(commands[0])
      const artifactId = firstArtifactId(commands[0])
      return (
        <div key={entry.id} className="cc-timeline-item cc-timeline-item--answer">
          <span className="cc-timeline-dot" />
          <div className="cc-timeline-body">
            <div className="cc-result-card">
              {forecastText || '暂无数据'}
            </div>
            {artifactId ? (
              <button className="cc-mini-button mt-2" type="button" onClick={() => onSelectArtifact(artifactId)}>
                在地图中查看
              </button>
            ) : null}
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
                expanded={expandedIds.has(`tool:${command.id}`)}
                onToggle={() => onToggleExpanded(`tool:${command.id}`)}
                onSelectArtifact={onSelectArtifact}
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
          <ApprovalCard entry={entry} />
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

function ApprovalCard({ entry }: { entry: ConversationEntry }) {
  const plan = extractApprovalPlan(entry.details)
  if (plan) {
    const allowedPrompts = extractAllowedPrompts(entry.details)
    return (
      <div className="cc-plan-review-card" aria-label="计划审核">
        <div className="cc-plan-review-card__status">
          <strong>Ready for review</strong>
          <span>请先审阅计划。批准后系统才会退出只读计划模式并继续执行。</span>
        </div>
        <div className="cc-plan-document">
          <div className="cc-plan-document__eyebrow">GeoForge Plan</div>
          <h2>{plan.goal}</h2>
          <section>
            <h3>执行步骤</h3>
            <ol className="cc-plan-document__steps">
              {plan.steps.map((step, index) => (
                <li key={step.id || `${step.tool}:${index}`}>
                  <span className="cc-plan-document__index">{index + 1}</span>
                  <div>
                    <strong>{step.reason || step.tool || `步骤 ${index + 1}`}</strong>
                    <small>{step.tool || 'manual'}</small>
                    {step.args && Object.keys(step.args).length > 0 ? (
                      <code>{JSON.stringify(step.args)}</code>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {allowedPrompts.length > 0 ? (
            <section>
              <h3>批准后允许的动作</h3>
              <ul className="cc-plan-document__allowlist">
                {allowedPrompts.map((item, index) => (
                  <li key={`${item.tool}:${index}`}>
                    <strong>{item.tool}</strong>
                    <span>{item.prompt}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <div className="cc-plan-approval-box">
          <div>
            <strong>{entry.title || '接受这个计划？'}</strong>
            <span>{entry.body}</span>
          </div>
          <div className="cc-plan-approval-box__actions">
            <span>请在底部决策面板中确认。</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cc-approval-card">
      <span className="cc-approval-card__icon"><ShieldCheck size={18} /></span>
      <div className="cc-approval-card__main">
        <div className="cc-approval-copy">
          <strong>{entry.title || '需要你的确认'}</strong>
          <span>{entry.body}</span>
        </div>
        <div className="cc-approval-actions">
          <span>请在底部决策面板中确认。</span>
        </div>
      </div>
    </div>
  )
}

interface ReviewPlan {
  goal: string
  steps: Array<{ id: string; tool: string; args: Record<string, unknown>; reason: string }>
}

function extractApprovalPlan(details: Record<string, unknown> | null | undefined): ReviewPlan | null {
  const args = isRecord(details?.args) ? details.args : null
  const rawPlan = isRecord(args?.plan) ? args.plan : null
  if (!rawPlan) return null
  const goal = typeof rawPlan.goal === 'string' && rawPlan.goal.trim()
    ? rawPlan.goal.trim()
    : '待审批执行计划'
  const steps = Array.isArray(rawPlan.steps)
    ? rawPlan.steps.map((step, index) => normalizeReviewPlanStep(step, index)).filter(Boolean)
    : []
  if (!steps.length) return null
  return { goal, steps }
}

function normalizeReviewPlanStep(value: unknown, index: number): ReviewPlan['steps'][number] | null {
  if (!isRecord(value)) return null
  const tool = typeof value.tool === 'string' && value.tool.trim() ? value.tool.trim() : 'manual'
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : tool
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `plan_step_${index + 1}`
  return {
    id,
    tool,
    reason,
    args: isRecord(value.args) ? value.args : {},
  }
}

function extractAllowedPrompts(details: Record<string, unknown> | null | undefined): Array<{ tool: string; prompt: string }> {
  const args = isRecord(details?.args) ? details.args : null
  const raw = Array.isArray(args?.allowedPrompts) ? args.allowedPrompts : []
  return raw.flatMap((item) => {
    if (!isRecord(item)) return []
    const tool = typeof item.tool === 'string' ? item.tool.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    return tool && prompt ? [{ tool, prompt }] : []
  })
}

function ToolCommandCard({
  command,
  expanded,
  onToggle,
  onSelectArtifact,
}: {
  command: ConversationCommand
  expanded: boolean
  onToggle: () => void
  onSelectArtifact: (id: string) => void
}) {
  const isRunning = command.status === 'running'
  const hasInput = Boolean(command.commandText?.trim())
  const hasOutput = isRunning || Boolean(command.body.trim())
  const miniAppKind = miniAppKindForTool(command.toolName)
  const artifacts = Array.isArray(command.details?.artifacts) ? command.details.artifacts.filter(isRecord) : []
  const hasDetails = hasInput || hasOutput || Boolean(miniAppKind)

  return (
    <div className="cc-tool-row">
      <button
        className="cc-tool-row-head"
        type="button"
        aria-expanded={expanded}
        disabled={!hasDetails}
        onClick={onToggle}
      >
        <span className={`cc-tool-row-state cc-tool-row-state--${command.status}`}>
          {isRunning ? <LoaderCircle size={13} /> : <CheckCircle2 size={13} />}
        </span>
        <span className="cc-tool-row-title">{formatToolKindLabel(command)}</span>
        <span className="cc-tool-row-subtitle">{formatToolActionLabel(command)}</span>
        {miniAppKind ? <span className="cc-tool-row-mini-entry">小工具页面</span> : null}
        {hasDetails && <ChevronDown size={14} className={`cc-chevron ml-auto ${expanded ? 'cc-chevron--open' : ''}`} />}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasDetails && (
          <m.div className="cc-tool-io-card" {...buildFadeUpMotion(false, 0, 4)}>
            {!isRunning && miniAppKind ? (
              <ToolMiniAppResult
                toolName={command.toolName}
                result={command.details?.result}
                artifacts={artifacts}
                onSelectArtifact={onSelectArtifact}
              />
            ) : null}
            {hasInput && (
              <div className="cc-tool-io-section">
                <span className="cc-tool-io-label">输入</span>
                <pre>{truncateToolText(command.commandText?.replace(/^>\s*/u, '').trim() ?? '')}</pre>
              </div>
            )}
            {hasOutput && (
              <div className="cc-tool-io-section cc-tool-io-section--output">
                <span className="cc-tool-io-label">输出</span>
                {isRunning ? (
                  <pre>执行中，等待工具返回...</pre>
                ) : (
                  <pre>{truncateToolText(formatToolOutput(formatCommandOutput(command)))}</pre>
                )}
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function transcriptEntryId(entry: ConversationEntry): string | null {
  const value = entry.details?.transcriptEntryId
  return typeof value === 'string' && value ? value : null
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
    const directUrl = stringOrNull(result.audio_url ?? result.audioUrl ?? result.uri ?? result.downloadUrl)
    if (directUrl) return directUrl
  }
  const artifactUrl = firstAudioArtifactUrl(command)
  if (artifactUrl) return artifactUrl
  return stringOrNull(command.details?.audio_url ?? command.details?.audioUrl)
}

function isSpeechSynthesisCommand(command: ConversationCommand) {
  return command.toolName === 'synthesize_speech'
    || command.toolName === 'text_to_speech'
    || firstAudioArtifactUrl(command) !== null
}

function firstAudioArtifactUrl(command: ConversationCommand) {
  const artifacts = command.details?.artifacts
  if (!Array.isArray(artifacts)) return null
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) continue
    const artifactType = typeof artifact.artifactType === 'string' ? artifact.artifactType : ''
    const mimeType = isRecord(artifact.metadata) && typeof artifact.metadata.mimeType === 'string' ? artifact.metadata.mimeType : ''
    if (artifactType === 'audio_mp3' || mimeType.startsWith('audio/')) {
      const uri = stringOrNull(artifact.uri)
      if (uri) return uri
    }
  }
  return null
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

function truncateToolText(value: string, maxLength = 12_000) {
  const text = value.trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n… 输出过长，已截断 ${text.length - maxLength} 个字符。`
}

function extractNowcastAnswer(command: ConversationCommand) {
  const result = command.details?.result
  if (isRecord(result)) {
    const answer = stringOrNull(result.answer)
    if (answer) return answer
  }
  return command.body.trim()
}

function firstArtifactId(command: ConversationCommand) {
  const direct = command.details?.artifactId
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const artifacts = command.details?.artifacts
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (isRecord(artifact) && typeof artifact.artifactId === 'string' && artifact.artifactId.trim()) {
        return artifact.artifactId.trim()
      }
    }
  }
  return null
}
