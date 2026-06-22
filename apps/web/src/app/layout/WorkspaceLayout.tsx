// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台布局组件
//
//   文件:       WorkspaceLayout.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 承载主工作区的壳层、侧边栏与概览指标。这里只消费 AppShell 已经派生好的
// 展示状态，不订阅 run/event/item，避免布局组件重新成为业务状态中心。

import type { ReactNode } from 'react'
import type { Variants } from 'framer-motion'
import { m } from 'framer-motion'

import { AppIcon, type AppIconName } from '../../shared/components/AppIcon'
import { LiquidGlassLayer, LiquidGlassSurface } from '../../shared/components/LiquidGlassLayer'
import { buildFadeUpMotion } from '../../shared/motion'

export interface WorkspaceSidebarItem {
  id: string
  icon: AppIconName
  label: string
  shortLabel: string
}

interface WorkspaceLayoutProps {
  topBar: ReactNode
  sidebarItems: readonly WorkspaceSidebarItem[]
  activeSidebarItem: string
  onSidebarItemClick: (id: string) => void
  runStatusLabel: string
  hasActiveRun: boolean
  dataReferenceCount: number
  selectedBasemapName: string
  uploadedLayerName?: string
  activeNavLabel: string
  panelModeLabel: string
  providerLabel: string
  modelLabel: string
  modelStatusLabel: string
  artifactCount: number
  selectedArtifactName?: string
  transcriptTitle: string
  transcriptBody: string
  reducedMotion: boolean
  workspaceListVariants: Variants
  workspaceItemVariants: Variants
  children: ReactNode
}

export function WorkspaceLayout({
  topBar,
  sidebarItems,
  activeSidebarItem,
  onSidebarItemClick,
  runStatusLabel,
  hasActiveRun,
  dataReferenceCount,
  selectedBasemapName,
  uploadedLayerName,
  activeNavLabel,
  panelModeLabel,
  providerLabel,
  modelLabel,
  modelStatusLabel,
  artifactCount,
  selectedArtifactName,
  transcriptTitle,
  transcriptBody,
  reducedMotion,
  workspaceListVariants,
  workspaceItemVariants,
  children,
}: WorkspaceLayoutProps) {
  return (
    <m.div className="digital-cartographer" {...buildFadeUpMotion(reducedMotion, 0, 10)}>
      <LiquidGlassLayer />
      {topBar}

      <div className="app-shell-grid">
        <LiquidGlassSurface as="aside" variant="strong" className="app-sidebar" aria-label="工作空间导航">
          <div className="app-sidebar-copy">
            <div className="detail-label">业务工作区</div>
            <h2>气象空间分析</h2>
            <p>以自然语言组织数据、模型、地图与气象产品。</p>
          </div>
          <nav className="app-sidebar-nav">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activeSidebarItem === item.id ? 'sidebar-btn sidebar-btn-active' : 'sidebar-btn'}
                onClick={() => onSidebarItemClick(item.id)}
              >
                <AppIcon name={item.icon} size={17} />
                <span className="hidden sm:inline">{item.label}</span>
                <span className="sm:hidden text-[11px]">{item.shortLabel}</span>
              </button>
            ))}
          </nav>
          <div className="app-sidebar-metrics">
            <article className="glass-subtle">
              <span className="detail-label">运行</span>
              <strong className="detail-value">{runStatusLabel}</strong>
              <p>{hasActiveRun ? '当前对话继续中' : '等待分析请求'}</p>
            </article>
            <article className="glass-subtle">
              <span className="detail-label">数据</span>
              <strong className="detail-value">{dataReferenceCount}对象</strong>
              <p>{selectedBasemapName} · {uploadedLayerName ?? '无自定义数据'}</p>
            </article>
          </div>
        </LiquidGlassSurface>

        <main className="app-main" role="main">
          <m.section
            className="workspace-overview"
            aria-label="工作台概览"
            variants={workspaceListVariants}
            initial="hidden"
            animate="visible"
          >
            <m.article className="workspace-overview__card glass-subtle" layout variants={workspaceItemVariants}>
              <span className="detail-label">模式</span>
              <strong className="detail-value">{activeNavLabel}</strong>
              <p>{panelModeLabel}就绪</p>
            </m.article>
            <m.article className="workspace-overview__card glass-subtle" layout variants={workspaceItemVariants}>
              <span className="detail-label">模型</span>
              <strong className="detail-value">{providerLabel}</strong>
              <p>{modelLabel} · {modelStatusLabel}</p>
            </m.article>
            <m.article className="workspace-overview__card glass-subtle" layout variants={workspaceItemVariants}>
              <span className="detail-label">结果</span>
              <strong className="detail-value">{artifactCount}产物</strong>
              <p>{selectedArtifactName ?? '未选中图层'}</p>
            </m.article>
            <m.article className="workspace-overview__card glass-subtle" layout variants={workspaceItemVariants}>
              <span className="detail-label">进度</span>
              <strong className="detail-value">{transcriptTitle}</strong>
              <p>{transcriptBody}</p>
            </m.article>
          </m.section>
          <m.div
            className="workspace-grid"
            variants={workspaceListVariants}
            initial="hidden"
            animate="visible"
          >
            {children}
          </m.div>
        </main>
      </div>
    </m.div>
  )
}
