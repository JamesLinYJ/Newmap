import { Download, ExternalLink, TriangleAlert } from 'lucide-react'

import type { AgentState, ArtifactRef } from '@geo-agent-platform/shared-types'

import { apiBaseUrl } from '../api'
import { StatusPill } from './StatusPill'

interface DetailPanelProps {
  runStatus?: string
  agentState?: AgentState
  artifacts: ArtifactRef[]
  artifactData: Record<string, GeoJSON.FeatureCollection>
  selectedArtifactId?: string
  publishResult?: Record<string, unknown> | null
  onSelectArtifact: (artifactId: string) => void
  onPublish: (artifactId: string) => void
}

export function DetailPanel({
  runStatus,
  agentState,
  artifacts,
  artifactData,
  selectedArtifactId,
  publishResult,
  onSelectArtifact,
  onPublish,
}: DetailPanelProps) {
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
  const selectedData = selectedArtifactId ? artifactData[selectedArtifactId] : undefined
  const selectedCount = selectedData?.features.length ?? 0
  const selectedGeometry = summarizeGeometry(selectedData)
  const linkItems = buildPublishLinks(publishResult)

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
      ? '结果已生成'
      : runStatus === 'clarification_needed'
        ? '等待确认'
        : runStatus === 'running'
          ? '分析进行中'
          : runStatus === 'failed'
            ? '未完成'
            : '等待开始'

  return (
    <section className="panel panel--detail" aria-label="分析结果">
      <div className="panel__header">
        <div>
          <h2>地图结论与结果操作</h2>
        </div>
        <StatusPill label={statusLabel} tone={statusTone} />
      </div>

      <div className="panel__section">
        <div className="result-hero">
          <h3>{buildSummaryHeadline(runStatus, agentState?.finalResponse?.summary)}</h3>
          <p>{buildSummaryBody(runStatus, selectedArtifact?.name, selectedCount, selectedGeometry)}</p>
        </div>
      </div>

      {selectedArtifact ? (
        <div className="panel__section">
          <div className="panel__subheader">
            <span>当前结果</span>
            <span className="panel__muted">可下载、可发布</span>
          </div>
          <div className="result-highlight">
            <div className="result-highlight__header">
              <div>
                <strong>{selectedArtifact.name}</strong>
                <p>{selectedCount ? `共 ${selectedCount} 个结果对象` : '已生成结果图层'}</p>
              </div>
              <span className="result-badge">{selectedGeometry}</span>
            </div>
            <div className="result-highlight__stats">
              <div>
                <span>结果数量</span>
                <strong>{selectedCount}</strong>
              </div>
              <div>
                <span>地图类型</span>
                <strong>{selectedGeometry}</strong>
              </div>
            </div>
            <div className="artifact-actions">
              <a
                className="toolbar-button toolbar-button--ghost"
                href={`${apiBaseUrl}/api/v1/results/${selectedArtifact.artifactId}/geojson`}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={16} aria-hidden="true" />
                下载 GeoJSON
              </a>
              <button className="toolbar-button toolbar-button--primary" type="button" onClick={() => onPublish(selectedArtifact.artifactId)}>
                <ExternalLink size={16} aria-hidden="true" />
                发布在线地图服务
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel__section">
        <div className="panel__subheader">
          <span>结果列表</span>
          <span className="panel__muted">{artifacts.length} 个结果</span>
        </div>
        <div className="artifact-list">
          {artifacts.length ? (
            artifacts.map((artifact) => {
              const data = artifactData[artifact.artifactId]
              const count = data?.features.length ?? 0
              return (
                <button
                  key={artifact.artifactId}
                  className={`artifact-list__item${
                    artifact.artifactId === selectedArtifactId ? ' artifact-list__item--active' : ''
                  }`}
                  type="button"
                  onClick={() => onSelectArtifact(artifact.artifactId)}
                >
                  <div>
                    <strong>{artifact.name}</strong>
                    <p>{count ? `${count} 个对象` : '已生成地图图层'}</p>
                  </div>
                </button>
              )
            })
          ) : (
            <p className="panel__empty">分析完成后，结果会出现在这里，方便你逐个查看。</p>
          )}
        </div>
      </div>

      <div className="panel__section">
        <div className="panel__subheader">
          <span>后续可做的事</span>
          <span className="panel__muted">系统建议</span>
        </div>
        {agentState?.finalResponse?.nextActions?.length ? (
          <div className="next-actions">
            {agentState.finalResponse.nextActions.map((item) => (
              <div key={item} className="next-actions__item">
                {item}
              </div>
            ))}
          </div>
        ) : (
          <p className="panel__empty">结果生成后，这里会告诉你下一步适合继续做什么。</p>
        )}
      </div>

      <div className="panel__section">
        <div className="panel__subheader">
          <span>注意事项</span>
          <span className="panel__muted">{agentState?.warnings.length ?? 0} 条</span>
        </div>
        {agentState?.warnings.length ? (
          <ul className="warning-list">
            {agentState.warnings.map((warning) => (
              <li key={warning}>
                <TriangleAlert size={16} aria-hidden="true" />
                {warning}
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel__empty">当前没有需要额外提醒你的地方。</p>
        )}
      </div>

      {linkItems.length ? (
        <div className="panel__section">
          <div className="panel__subheader">
            <span>服务与下载链接</span>
            <span className="panel__muted">发布后可直接打开</span>
          </div>
          <div className="publish-links">
            {linkItems.map((item) => (
              <a key={item.label} className="publish-links__item" href={item.href} target="_blank" rel="noreferrer">
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.description}</p>
                </div>
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function summarizeGeometry(collection?: GeoJSON.FeatureCollection) {
  if (!collection?.features.length) {
    return '地图结果'
  }

  const types = new Set(
    collection.features
      .map((feature) => feature.geometry?.type)
      .filter((value): value is GeoJSON.Geometry['type'] => Boolean(value)),
  )

  if ([...types].some((item) => item.includes('Polygon'))) {
    return '范围结果'
  }
  if ([...types].some((item) => item.includes('LineString'))) {
    return '线路结果'
  }
  if ([...types].some((item) => item.includes('Point'))) {
    return '点位结果'
  }
  return '地图结果'
}

function buildSummaryHeadline(runStatus?: string, summary?: string) {
  if (summary) {
    return summary
  }
  if (runStatus === 'clarification_needed') {
    return '还需要你确认一下地点或范围。'
  }
  if (runStatus === 'running') {
    return '系统正在整理地图结果。'
  }
  if (runStatus === 'failed') {
    return '这次分析没有顺利完成。'
  }
  return '地图分析结果会在这里生成。'
}

function buildSummaryBody(
  runStatus?: string,
  artifactName?: string,
  featureCount?: number,
  geometryLabel?: string,
) {
  if (runStatus === 'completed' && artifactName) {
    return `${artifactName} 已经落在地图上${featureCount ? `，共整理出 ${featureCount} 个对象` : ''}。你可以继续查看、下载或发布为在线服务。`
  }
  if (runStatus === 'clarification_needed') {
    return '请先在左侧确认问题中的地点或范围，系统再继续分析。'
  }
  if (runStatus === 'running') {
    return '系统正在识别地点、加载数据并完成空间分析，请稍等片刻。'
  }
  if (runStatus === 'failed') {
    return '请查看页面提示后重试，或调整问题描述让范围更明确。'
  }
  return `${geometryLabel ?? '地图结果'}、下载入口和服务链接会在分析完成后自动展示。`
}

function buildPublishLinks(publishResult?: Record<string, unknown> | null) {
  if (!publishResult) {
    return [] as PublishLink[]
  }

  const mapping = [
    ['geojsonUrl', 'GeoJSON 下载', '适合继续在 GIS 软件或脚本里使用。'],
    ['owsUrl', '在线地图服务入口', '统一访问入口，便于继续接入地图软件。'],
    ['wmsCapabilitiesUrl', 'WMS 服务', '适合地图叠加和底图展示。'],
    ['wfsCapabilitiesUrl', 'WFS 服务', '适合继续拉取矢量要素数据。'],
    ['ogcApiCollectionsUrl', 'OGC API 集合', '查看当前发布的数据集合。'],
    ['ogcApiItemsUrl', 'OGC API 要素', '直接访问发布后的要素数据。'],
  ] as const

  const links: PublishLink[] = []

  mapping.forEach(([key, label, description]) => {
    const value = publishResult[key]
    if (typeof value === 'string' && value.startsWith('http')) {
      links.push({ label, description, href: value })
    }
  })

  return links
}

interface PublishLink {
  label: string
  description: string
  href: string
}
