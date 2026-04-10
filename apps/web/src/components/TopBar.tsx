import { Download, ExternalLink, Share2 } from 'lucide-react'

import { StatusPill } from './StatusPill'

interface TopBarProps {
  runStatus?: string
  selectedArtifactId?: string
  selectedArtifactName?: string
  publishStateLabel: string
  selectedArtifactGeoJsonUrl?: string
  onCopyShareLink: () => void
  onPublishSelected?: () => void
}

export function TopBar({
  runStatus,
  selectedArtifactId,
  selectedArtifactName,
  publishStateLabel,
  selectedArtifactGeoJsonUrl,
  onCopyShareLink,
  onPublishSelected,
}: TopBarProps) {
  const statusTone =
    runStatus === 'completed'
      ? 'success'
      : runStatus === 'clarification_needed'
        ? 'warning'
        : runStatus === 'running'
          ? 'accent'
          : runStatus === 'failed'
            ? 'danger'
            : 'neutral'

  const statusLabel =
    runStatus === 'completed'
      ? '分析完成'
      : runStatus === 'clarification_needed'
        ? '等待确认'
        : runStatus === 'running'
          ? '正在分析'
          : runStatus === 'failed'
            ? '分析失败'
            : '准备开始'

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <div className="topbar__brand-mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="topbar__brand-copy">
          <div className="topbar__title-row">
            <h1>地图分析助手</h1>
            <StatusPill label={statusLabel} tone={statusTone} />
          </div>
          <p>直接描述你的空间问题，系统会在地图上给出结论、结果图层和可下载结果。</p>
        </div>
      </div>

      <div className="topbar__meta" aria-label="当前结果状态">
        <div className="topbar__metric">
          <span>当前结果</span>
          <strong>{selectedArtifactName ?? '等待分析结果'}</strong>
        </div>
        <div className="topbar__metric">
          <span>地图服务</span>
          <strong>{publishStateLabel}</strong>
        </div>
      </div>

      <div className="topbar__actions">
        <button className="toolbar-button toolbar-button--primary" type="button" onClick={onCopyShareLink}>
          <Share2 size={16} aria-hidden="true" />
          复制分享链接
        </button>
        {selectedArtifactId && selectedArtifactGeoJsonUrl ? (
          <a className="toolbar-button toolbar-button--ghost" href={selectedArtifactGeoJsonUrl} target="_blank" rel="noreferrer">
            <Download size={16} aria-hidden="true" />
            下载结果
          </a>
        ) : null}
        {selectedArtifactId ? (
          <button className="toolbar-button toolbar-button--ghost" type="button" onClick={onPublishSelected}>
            <ExternalLink size={16} aria-hidden="true" />
            发布地图服务
          </button>
        ) : null}
      </div>
    </header>
  )
}
