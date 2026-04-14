// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话与任务面板
//
//   文件:       ChatPanel.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { LoaderCircle } from 'lucide-react'

import type { UserIntent } from '@geo-agent-platform/shared-types'
import { AppIcon } from './AppIcon'

interface ProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

interface ChatPanelProps {
  query: string
  isSubmitting: boolean
  errorMessage?: string
  uploadedLayerName?: string
  intent?: UserIntent
  progressItems: ReadonlyArray<ProgressItem>
  onQueryChange: (value: string) => void
  onSubmit: () => void
  onFillSample: (value: string) => void
  onUseTemplate: () => void
  onUpload: (file: File) => void
}

const QUICK_ACTIONS = ['生成热力图', '识别高密度区', '选址推荐'] as const
const SAMPLE_QUERIES = [
  '查询巴黎地铁站 1 公里范围内的医院',
  '判断我上传的点是否落在柏林行政区内',
  '查询叫 Springfield 的区域',
] as const

export function ChatPanel({
  query,
  isSubmitting,
  errorMessage,
  uploadedLayerName,
  intent,
  progressItems,
  onQueryChange,
  onSubmit,
  onFillSample,
  onUseTemplate,
  onUpload,
}: ChatPanelProps) {
  // 聊天与任务提交面板。
  const liveStatus =
    progressItems.find((item) => item.status === 'active' || item.status === 'warning') ?? progressItems.at(-1)
  const assistantIntro = intent?.clarificationRequired
    ? '我已经识别到你的空间问题，不过当前还有一个地点或范围需要你确认，确认后我会继续把结果落到地图上。'
    : uploadedLayerName
      ? `我已经接入你上传的数据“${uploadedLayerName}”。你可以继续描述范围、目标对象和分析方式，我会自动组织步骤。`
      : '你好，我是你的 GIS 助手。你可以直接告诉我想看哪个区域、哪些对象，以及希望做什么空间分析，我会把过程和结果展示在地图上。'
  const userPromptPreview = query || '比如：查询某个区域内的医院、学校、站点关系，或者判断上传点位是否落在指定行政区内。'

  return (
    <div className="dc-chat-column">
      <section className="dc-chat-shell">
        <div className="dc-chat-shell__header">
          <div className="dc-chat-shell__identity">
            <div className="dc-avatar dc-avatar--assistant">
              <AppIcon name="smart_toy" size={20} />
            </div>
            <div>
              <strong>GIS 助手</strong>
              <span>{intent?.clarificationRequired ? '等待你确认范围' : '地图分析会同步显示在右侧和地图上'}</span>
            </div>
          </div>
          <div className={`dc-chat-shell__status dc-chat-shell__status--${liveStatus?.status ?? 'pending'}`}>
            {liveStatus?.title ?? '待命'}
          </div>
        </div>

        <div className="dc-chat-shell__intro">
          <p>{assistantIntro}</p>
          <div className="dc-chip-row">
            {QUICK_ACTIONS.map((item, index) => (
              <button
                key={item}
                className="dc-chip"
                type="button"
                onClick={() => onFillSample(SAMPLE_QUERIES[index] ?? SAMPLE_QUERIES[0])}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="dc-chat-shell__query">
          <div className="dc-chat-shell__query-label">当前问题</div>
          <p>{userPromptPreview}</p>
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

        <div className="dc-stage-note">
          <AppIcon name="insights" size={18} />
          <div>
            <strong>{liveStatus?.title ?? '等待开始分析'}</strong>
            <p>{liveStatus?.description ?? '系统会根据你的问题自动拆解空间步骤，并把结果同步到地图和右侧摘要卡片。'}</p>
          </div>
        </div>

        <div className="dc-composer dc-composer--inline">
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

          {uploadedLayerName ? <p className="dc-composer__hint">已接入你的数据：{uploadedLayerName}</p> : null}
        </div>
      </section>

      <div className="dc-sample-row" aria-label="推荐问题">
        {SAMPLE_QUERIES.map((sample) => (
          <button key={sample} type="button" className="dc-sample-pill" onClick={() => onFillSample(sample)}>
            {sample}
          </button>
        ))}
      </div>
    </div>
  )
}
