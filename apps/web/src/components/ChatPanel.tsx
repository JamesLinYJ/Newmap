// +-------------------------------------------------------------------------
//
//   地理智能平台 - REPL 对话面板
//
//   文件:       ChatPanel.tsx
//
//   日期:       2026年04月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { LoaderCircle } from 'lucide-react'

import type { AgentRuntimeConfig, UserIntent } from '@geo-agent-platform/shared-types'
import type { TranscriptEntry } from '../runTranscript'
import { AppIcon } from './AppIcon'

interface ChatPanelProps {
  artifactCount: number
  currentRunId?: string
  runCreatedAt?: string
  providerLabel: string
  runStatus?: string
  query: string
  isSubmitting: boolean
  errorMessage?: string
  uploadedLayerName?: string
  intent?: UserIntent
  transcriptEntries: ReadonlyArray<TranscriptEntry>
  runtimeConfig?: AgentRuntimeConfig
  onQueryChange: (value: string) => void
  onSubmit: () => void
  onFillSample: (value: string) => void
  onUseTemplate: () => void
  onUpload: (file: File) => void
  onSelectArtifact: (artifactId: string) => void
  onResolveApproval: (approvalId: string, approved: boolean) => void
}

const SAMPLE_QUERIES = [
  '查询巴黎地铁站 1 公里范围内的医院',
  '判断我上传的点是否落在柏林行政区内',
  '查询叫 Springfield 的区域',
] as const

export function ChatPanel({
  artifactCount,
  currentRunId,
  runCreatedAt,
  providerLabel,
  runStatus,
  query,
  isSubmitting,
  errorMessage,
  uploadedLayerName,
  intent,
  transcriptEntries,
  runtimeConfig,
  onQueryChange,
  onSubmit,
  onFillSample,
  onUseTemplate,
  onUpload,
  onSelectArtifact,
  onResolveApproval,
}: ChatPanelProps) {
  const hasTranscript = transcriptEntries.length > 1
  const transcriptLabel =
    runStatus === 'running'
      ? '分析过程会实时写入。'
    : runStatus === 'waiting_approval'
        ? '当前停在待确认节点。'
        : '新的空间分析任务会从这里开始。'
  const workingLabel = runCreatedAt && runStatus === 'running' ? formatElapsedLabel(runCreatedAt) : null
  const topicLabel = query.trim() || '新的空间分析任务'
  const showSamples = !isSubmitting && transcriptEntries.length <= 1
  const recordCount = transcriptEntries.filter((entry) => entry.kind !== 'user').length
  const compactContextLabel = runtimeConfig?.context
    ? `会延续最近 ${runtimeConfig.context.historyRunLimit} 轮任务与 ${runtimeConfig.context.eventWindow} 条记录`
    : '会延续当前会话里的最近任务与结果'

  return (
    <div className="dc-chat-column">
      <section className="dc-chat-console">
        <header className="dc-chat-console__header">
          <div className="dc-chat-console__tabs">
            <span className="dc-chat-console__tab dc-chat-console__tab--active">聊天</span>
            <span className="dc-chat-console__tab">{providerLabel}</span>
          </div>
          <div className="dc-chat-console__actions">
            <span className="dc-chat-shell__status">{formatRunStatus(runStatus)}</span>
            {currentRunId ? <span className="dc-chat-shell__status">任务 {currentRunId.slice(0, 8)}</span> : null}
          </div>
        </header>

        <div className="dc-chat-console__thread">
          <div className="dc-chat-console__thread-main">
            <span className="dc-chat-console__thread-path">← {topicLabel}</span>
            {!hasTranscript ? <p>{transcriptLabel}</p> : null}
          </div>
          <div className="dc-chat-console__thread-meta">
            <span className="dc-chat-console__thread-chip">{artifactCount} 个结果</span>
            <span className="dc-chat-console__thread-chip">{recordCount} 条记录</span>
          </div>
        </div>

        {intent?.clarificationRequired ? (
          <div className="dc-clarification">
            <strong>{intent.clarificationQuestion}</strong>
            <div className="dc-clarification__options">
              {intent.clarificationOptions?.map((option) => (
                <button key={option.label} type="button" className="dc-clarification__option" onClick={() => onFillSample(option.label)}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {errorMessage ? <div className="dc-error-banner">{errorMessage}</div> : null}

        <div className="dc-chat-console__feed" aria-label="Agent transcript">
          {transcriptEntries.length ? (
            transcriptEntries.map((entry) => (
              <article
                key={entry.id}
                className={`dc-chat-message dc-chat-message--${entry.kind === 'user' ? 'user' : 'assistant'} dc-chat-message--kind-${entry.kind} dc-chat-message--status-${entry.status}`}
              >
                <div className="dc-chat-message__meta">
                  <span className={`dc-chat-message__kind dc-chat-message__kind--${entry.kind}`}>{entry.kind === 'user' ? '你' : formatKind(entry.kind)}</span>
                  <span className={`dc-chat-message__status dc-chat-message__status--${entry.status}`}>{formatEntryStatus(entry.status)}</span>
                  <time dateTime={entry.timestamp}>{formatEventTime(entry.timestamp)}</time>
                </div>
                <strong>{entry.title}</strong>
                <p>{entry.body}</p>
                {entry.commandText ? (
                  <div className="dc-chat-message__command-block">
                    <span className="dc-chat-message__section-label">执行命令</span>
                    <pre className="dc-chat-message__command">{entry.commandText}</pre>
                  </div>
                ) : null}
                {entry.recoveryNote ? <p className="dc-chat-message__recovery">恢复说明：{entry.recoveryNote}</p> : null}
                {entry.details ? (
                  <details className="dc-chat-message__details">
                    <summary>{detailSummaryLabel(entry)}</summary>
                    <pre>{JSON.stringify(entry.details, null, 2)}</pre>
                  </details>
                ) : null}
                {entry.kind === 'artifact' && entry.artifactId ? (
                  <div className="dc-chat-message__actions">
                    <button type="button" className="dc-link-button dc-link-button--primary" onClick={() => onSelectArtifact(entry.artifactId!)}>
                      在地图中查看
                    </button>
                  </div>
                ) : null}
                {entry.kind === 'approval' && entry.approvalId ? (
                  <div className="dc-chat-message__actions">
                    <button type="button" className="dc-link-button dc-link-button--primary" onClick={() => onResolveApproval(entry.approvalId!, true)}>
                      批准
                    </button>
                    <button type="button" className="dc-link-button" onClick={() => onResolveApproval(entry.approvalId!, false)}>
                      拒绝
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <div className="dc-transcript-empty">
              <strong>等待第一条运行记录</strong>
              <p>提交空间问题后，这里会按真实顺序展示分析过程、工具调用、结果产物和待确认操作。</p>
            </div>
          )}
        </div>

        <div className="dc-chat-console__footer">
          {workingLabel ? <div className="dc-chat-console__footer-note">已运行 {workingLabel}</div> : null}
          <div className="dc-chat-console__footer-hint">{uploadedLayerName ? `已接入数据：${uploadedLayerName}` : compactContextLabel}</div>
        </div>

        <div className="dc-composer dc-composer--repl">
          <div className="dc-composer__field">
            <AppIcon name="auto_awesome" size={18} />
            <input
              id="analysis-query-input"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="描述您的空间分析需求，如：“分析地铁站周边的商业活力...”"
            />
            <button type="button" className="dc-composer__send" onClick={onSubmit} disabled={isSubmitting || !query.trim()}>
              {isSubmitting ? <LoaderCircle size={20} className="spin" aria-hidden="true" /> : <AppIcon name="send" size={18} />}
            </button>
          </div>

          <div className="dc-composer__footer">
            <label className="dc-utility" htmlFor="layer-upload">
              <AppIcon name="attach_file" size={16} />
              添加数据集
            </label>
            <input
              id="layer-upload"
              type="file"
              hidden
              accept=".geojson,.json,.gpkg"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  onUpload(file)
                }
                event.target.value = ''
              }}
            />

            <button type="button" className="dc-utility dc-utility--button" onClick={onUseTemplate}>
              <AppIcon name="history_edu" size={16} />
              使用模板
            </button>
          </div>
        </div>
      </section>

      {showSamples ? (
        <div className="dc-sample-row" aria-label="推荐问题">
          {SAMPLE_QUERIES.map((sample) => (
            <button key={sample} type="button" className="dc-sample-pill" onClick={() => onFillSample(sample)}>
              {sample}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function formatKind(kind: TranscriptEntry['kind']) {
  if (kind === 'user') return '用户'
  if (kind === 'assistant') return '助手'
  if (kind === 'supervisor') return '主智能体'
  if (kind === 'subagent') return '子智能体'
  if (kind === 'tool') return '工具调用'
  if (kind === 'approval') return '审批'
  if (kind === 'artifact') return '结果产物'
  return '错误'
}

function detailSummaryLabel(entry: TranscriptEntry) {
  if (entry.kind === 'tool') return '展开工具参数与返回'
  if (entry.kind === 'approval') return '展开审批上下文'
  if (entry.kind === 'artifact') return '展开结果元数据'
  if (entry.kind === 'error') return '展开错误详情'
  if (entry.kind === 'supervisor' || entry.kind === 'subagent') return '展开运行细节'
  return '展开详细记录'
}

function formatEntryStatus(status: TranscriptEntry['status']) {
  if (status === 'running') return '进行中'
  if (status === 'completed') return '已完成'
  if (status === 'blocked') return '待处理'
  if (status === 'failed') return '失败'
  return '待命'
}

function formatRunStatus(status?: string) {
  if (status === 'running') return '执行中'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'clarification_needed') return '待澄清'
  if (status === 'cancelled') return '已取消'
  return '准备就绪'
}

function formatEventTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN')
}

function formatElapsedLabel(value: string) {
  const started = new Date(value).getTime()
  if (Number.isNaN(started)) {
    return '--'
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} 秒`
  }
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return `${minutes} 分 ${seconds} 秒`
}
