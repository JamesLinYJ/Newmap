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
      {topBar}

      <div className="app-shell-grid grid min-h-screen grid-cols-[220px_minmax(0,1fr)] gap-0 pt-16">
        <aside className="app-sidebar sticky top-16 flex h-[calc(100vh-64px)] flex-col gap-6 self-start border-r border-white/30 bg-white/40 p-5 backdrop-blur-md" aria-label="工作空间导航">
          <div className="app-sidebar-copy">
            <div className="detail-label">地理智能平台</div>
            <h2 className="mt-1.5 text-xl font-bold text-slate-800 font-mono">工作空间</h2>
            <p className="mt-2 text-[13px] text-slate-500 leading-relaxed">自然语言驱动空间分析，从查询到发布一站式完成。</p>
          </div>
          <nav className="app-sidebar-nav flex flex-col gap-1.5">
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
          <div className="app-sidebar-metrics mt-auto flex flex-col gap-2.5">
            <article className="glass-subtle p-3.5 rounded-2xl">
              <span className="detail-label">运行</span>
              <strong className="detail-value">{runStatusLabel}</strong>
              <p className="text-[11px] text-slate-400 mt-1">{hasActiveRun ? '当前对话继续中' : '等待分析请求'}</p>
            </article>
            <article className="glass-subtle p-3.5 rounded-2xl">
              <span className="detail-label">数据</span>
              <strong className="detail-value">{dataReferenceCount}对象</strong>
              <p className="text-[11px] text-slate-400 mt-1">{selectedBasemapName}·{uploadedLayerName ?? '无自定义数据'}</p>
            </article>
          </div>
        </aside>

        <main className="app-main min-w-0 p-5" role="main">
          <m.section
            className="workspace-overview mb-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5"
            aria-label="工作台概览"
            variants={workspaceListVariants}
            initial="hidden"
            animate="visible"
          >
            <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
              <span className="detail-label">模式</span>
              <strong className="detail-value">{activeNavLabel}</strong>
              <p className="text-[11px] text-slate-400 mt-1">{panelModeLabel}就绪</p>
            </m.article>
            <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
              <span className="detail-label">模型</span>
              <strong className="detail-value">{providerLabel}</strong>
              <p className="text-[11px] text-slate-400 mt-1">{modelLabel}·处理中</p>
            </m.article>
            <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
              <span className="detail-label">结果</span>
              <strong className="detail-value">{artifactCount}产物</strong>
              <p className="text-[11px] text-slate-400 mt-1">{selectedArtifactName ?? '未选中图层'}</p>
            </m.article>
            <m.article className="glass-subtle p-3.5 rounded-2xl" layout variants={workspaceItemVariants}>
              <span className="detail-label">进度</span>
              <strong className="detail-value">{transcriptTitle}</strong>
              <p className="text-[11px] text-slate-400 mt-1">{transcriptBody}</p>
            </m.article>
          </m.section>
          <m.div
            className="workspace-grid grid min-h-[calc(100vh-64px-44px)] grid-cols-[minmax(240px,0.78fr)_minmax(480px,1.82fr)_minmax(240px,0.84fr)] items-start gap-4"
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
