import { LoaderCircle, Paperclip, Play, Upload } from 'lucide-react'

import type { LayerDescriptor, UserIntent } from '@geo-agent-platform/shared-types'

import { StatusPill } from './StatusPill'

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
  layers: LayerDescriptor[]
  onQueryChange: (value: string) => void
  onSubmit: () => void
  onFillSample: (value: string) => void
  onUpload: (file: File) => void
}

const SAMPLE_QUERIES = [
  '查询巴黎地铁站 1 公里范围内的医院',
  '判断我上传的点是否落在柏林行政区内',
  '查询叫 Springfield 的区域',
  '裁剪上海市范围内的候选点',
  '查询柏林地铁站 500 米范围内的医院并发布结果',
]

export function ChatPanel({
  query,
  isSubmitting,
  errorMessage,
  uploadedLayerName,
  intent,
  progressItems,
  layers,
  onQueryChange,
  onSubmit,
  onFillSample,
  onUpload,
}: ChatPanelProps) {
  const featuredLayers = layers.slice(0, 4)

  return (
    <section className="panel panel--chat" aria-label="任务输入">
      <div className="panel__header">
        <div>
          <h2>你想在地图上弄清什么？</h2>
        </div>
        <StatusPill label={isSubmitting ? '正在处理' : '等待提问'} tone={isSubmitting ? 'accent' : 'neutral'} />
      </div>

      <div className="panel__section">
        {errorMessage ? (
          <div className="clarification-box clarification-box--error" role="alert">
            {errorMessage}
          </div>
        ) : null}

        <label className="composer__label" htmlFor="query-input">
          输入你的空间问题
        </label>
        <textarea
          id="query-input"
          className="composer__textarea"
          placeholder="例如：查询巴黎地铁站 1 公里范围内的医院"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <div className="composer__actions">
          <label className="toolbar-button toolbar-button--ghost upload-button" htmlFor="layer-upload">
            <Upload size={16} aria-hidden="true" />
            上传自己的数据
          </label>
          <input
            id="layer-upload"
            name="layer-upload"
            type="file"
            accept=".geojson,.json,.gpkg"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                onUpload(file)
              }
              event.target.value = ''
            }}
          />
          <button
            className="toolbar-button toolbar-button--primary"
            type="button"
            onClick={onSubmit}
            disabled={!query.trim() || isSubmitting}
          >
            {isSubmitting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {isSubmitting ? '正在分析' : '开始分析'}
          </button>
        </div>
        <div className="composer__helper">
          {uploadedLayerName ? (
            <span>
              <Paperclip size={14} aria-hidden="true" />
              已接入你的数据：{uploadedLayerName}
            </span>
          ) : (
            <span>支持直接分析系统参考数据，也支持上传自己的 GeoJSON 或 GPKG 数据。</span>
          )}
        </div>
      </div>

      {intent?.clarificationRequired ? (
        <div className="panel__section">
          <div className="panel__subheader">
            <span>还需要你确认一下</span>
          </div>
          <div className="clarification-box" role="alert">
            <p>{intent.clarificationQuestion}</p>
            {intent.clarificationOptions?.length ? (
              <div className="clarification-options">
                {intent.clarificationOptions.map((option) => (
                  <div key={option.label} className="clarification-option">
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="panel__section">
        <div className="panel__subheader">
          <span>推荐问题</span>
          <span className="panel__muted">点一下就能试</span>
        </div>
        <div className="sample-list sample-list--stacked">
          {SAMPLE_QUERIES.map((sample) => (
            <button key={sample} className="sample-list__item" type="button" onClick={() => onFillSample(sample)}>
              {sample}
            </button>
          ))}
        </div>
      </div>

      <div className="panel__section">
        <div className="panel__subheader">
          <span>当前进度</span>
          <span className="panel__muted">系统会自动更新</span>
        </div>
        <ol className="progress-list">
          {progressItems.map((item) => (
            <li key={item.id} className={`progress-list__item progress-list__item--${item.status}`}>
              <div className="progress-list__marker" aria-hidden="true" />
              <div>
                <strong>{item.title}</strong>
                <p>{item.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="panel__section">
        <div className="panel__subheader">
          <span>系统已准备好的数据</span>
          <span className="panel__muted">可直接参与分析</span>
        </div>
        <div className="friendly-layer-list">
          {featuredLayers.map((layer) => (
            <div key={layer.layerKey} className="friendly-layer-list__item">
              <strong>{layer.name}</strong>
              <p>{layer.description || `${layer.featureCount ?? 0} 个对象，可直接用于空间分析。`}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
