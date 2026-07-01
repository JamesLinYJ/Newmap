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

import { useState, type ReactNode } from 'react'
import type { Variants } from 'framer-motion'
import { AnimatePresence, m } from 'framer-motion'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'

import { AppIcon, type AppIconName } from '../../shared/components/AppIcon'
import { LiquidGlassLayer } from '../../shared/components/LiquidGlassLayer'
import { buildFadeUpMotion, motionSpring } from '../../shared/motion'
import type { WorkspaceMode } from '../types'
import { isMapWorkspaceMode, reduceWorkspaceMode } from '../workspaceModeModel'

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
  currentThreadId?: string
  sessionThreads: AgentThreadRecord[]
  onNewTask: () => void
  onSelectThread: (threadId: string) => void
  mainSlot: ReactNode
  mapSlot: ReactNode
  inspectorSlot: ReactNode
  toolsSlot: ReactNode
  workspaceMode: WorkspaceMode
  onWorkspaceModeChange: (mode: WorkspaceMode) => void
  toolsMode: boolean
}

type MobileWorkspacePanel = 'chat' | 'map' | 'results' | 'tools'

const MOBILE_PANELS: ReadonlyArray<{
  id: MobileWorkspacePanel
  icon: AppIconName
  label: string
}> = [
  { id: 'chat', icon: 'psychology', label: '对话' },
  { id: 'map', icon: 'deployed_code', label: '地图' },
  { id: 'results', icon: 'analytics', label: '结果' },
  { id: 'tools', icon: 'build', label: '工具' },
]

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
  currentThreadId,
  sessionThreads,
  onNewTask,
  onSelectThread,
  mainSlot,
  mapSlot,
  inspectorSlot,
  toolsSlot,
  workspaceMode,
  onWorkspaceModeChange,
  toolsMode,
}: WorkspaceLayoutProps) {
  const [mobilePanel, setMobilePanel] = useState<MobileWorkspacePanel>('chat')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const effectiveMobilePanel = toolsMode ? 'tools' : mobilePanel === 'tools' ? 'chat' : mobilePanel
  const recentThreads = sessionThreads.slice(0, 7)
  const mapMode = isMapWorkspaceMode(workspaceMode)
  const panelTransition = reducedMotion ? { duration: 0 } : motionSpring.gentle
  const panelMotion = reducedMotion
    ? {
        initial: false,
        animate: { opacity: 1 },
        exit: { opacity: 1 },
        transition: panelTransition,
      }
    : {
        initial: { opacity: 0, y: 10, scale: 0.992 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -8, scale: 0.996 },
        transition: panelTransition,
      }

  const selectSidebarItem = (id: string) => {
    onSidebarItemClick(id)
    setMobileSidebarOpen(false)
  }

  const selectWorkspaceMode = (mode: WorkspaceMode) => {
    onWorkspaceModeChange(reduceWorkspaceMode(workspaceMode, { kind: 'mode-tab', mode }))
    setMobileSidebarOpen(false)
  }

  const selectMobilePanel = (panel: MobileWorkspacePanel) => {
    setMobilePanel(panel)
    if (panel === 'tools') {
      onSidebarItemClick('tools')
      return
    }
    if (panel === 'results') {
      onSidebarItemClick('export')
      return
    }
    if (panel === 'map') {
      return
    }
    onSidebarItemClick('assistant')
  }

  return (
    <m.div className="workbench-shell" {...buildFadeUpMotion(reducedMotion, 0, 10)}>
      <LiquidGlassLayer />
      {topBar}
      <button
        type="button"
        className="workbench-mobile-menu"
        aria-label="打开工作区导航"
        aria-expanded={mobileSidebarOpen}
        onClick={() => setMobileSidebarOpen(true)}
      >
        <AppIcon name="tune" size={17} />
      </button>
      <AnimatePresence initial={false}>
        {mobileSidebarOpen ? (
          <m.button
            type="button"
            className="workbench-mobile-scrim"
            aria-label="关闭工作区导航"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' }}
            onClick={() => setMobileSidebarOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      <m.div className="workbench-frame" layout transition={panelTransition}>
        <m.aside
          className="workbench-sidebar"
          aria-label="工作空间导航"
          data-mobile-open={mobileSidebarOpen ? 'true' : 'false'}
          layout
          transition={panelTransition}
        >
          <div className="workbench-mode-tabs" aria-label="工作台模式">
            <button
              type="button"
              className={workspaceMode === 'meteorology' ? 'workbench-mode-tab workbench-mode-tab--active' : 'workbench-mode-tab'}
              aria-pressed={workspaceMode === 'meteorology'}
              onClick={() => selectWorkspaceMode('meteorology')}
            >
              <AppIcon name="psychology" size={16} />
              <span>气象分析</span>
            </button>
            <button
              type="button"
              className={workspaceMode === 'map' ? 'workbench-mode-tab workbench-mode-tab--active' : 'workbench-mode-tab'}
              aria-pressed={workspaceMode === 'map'}
              onClick={() => selectWorkspaceMode('map')}
            >
              <AppIcon name="deployed_code" size={16} />
              <span>地图浏览</span>
            </button>
          </div>
          <div className="workbench-sidebar-actions">
            <button
              type="button"
              className="workbench-sidebar-command"
              onClick={() => {
                onNewTask()
                setMobileSidebarOpen(false)
              }}
            >
              <AppIcon name="add" size={17} />
              <span>新分析</span>
            </button>
            <button type="button" className="workbench-sidebar-command" onClick={() => selectSidebarItem('history')}>
              <AppIcon name="history" size={17} />
              <span>历史对话</span>
            </button>
          </div>
          <nav className="workbench-sidebar-nav">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activeSidebarItem === item.id ? 'workbench-sidebar-item workbench-sidebar-item--active' : 'workbench-sidebar-item'}
                onClick={() => selectSidebarItem(item.id)}
              >
                <AppIcon name={item.icon} size={17} />
                <span className="workbench-sidebar-label">{item.label}</span>
              </button>
            ))}
          </nav>
          <section className="workbench-recents" aria-label="最近对话">
            <div className="workbench-recents__head">
              <span>最近</span>
              <AppIcon name="tune" size={15} />
            </div>
            <div className="workbench-recents__list">
              {recentThreads.length ? recentThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={thread.id === currentThreadId ? 'workbench-recent workbench-recent--active' : 'workbench-recent'}
                  onClick={() => {
                    onSelectThread(thread.id)
                    setMobileSidebarOpen(false)
                  }}
                >
                  <span className="workbench-recent__dot" />
                  <span className="workbench-recent__main">{thread.title || '未命名对话'}</span>
                  <span className="workbench-recent__meta">{formatThreadAge(thread.updatedAt)}</span>
                </button>
              )) : (
                <span className="workbench-recents__empty">暂无对话</span>
              )}
            </div>
          </section>
          <div className="workbench-sidebar-footer">
            <div className="workbench-footer-row">
              <span>Gateway</span>
              <strong>{providerLabel}</strong>
            </div>
            <div className="workbench-footer-row">
              <span>模型</span>
              <strong>{modelLabel} · {modelStatusLabel}</strong>
            </div>
            <div className="workbench-footer-row">
              <span>{activeNavLabel}</span>
              <strong>{panelModeLabel} · {hasActiveRun ? runStatusLabel : selectedBasemapName}</strong>
            </div>
            <div className="workbench-footer-row">
              <span>数据</span>
              <strong>{dataReferenceCount} 对象 · {selectedArtifactName ?? uploadedLayerName ?? `${artifactCount} 产物`}</strong>
            </div>
            <div className="workbench-footer-row workbench-footer-row--muted">
              <span>{transcriptTitle}</span>
              <strong>{transcriptBody}</strong>
            </div>
          </div>
        </m.aside>

        <m.main className="workbench-main" role="main" layout transition={panelTransition}>
          <m.div
            className="workbench-content"
            data-mobile-panel={effectiveMobilePanel}
            data-tools-mode={toolsMode ? 'true' : 'false'}
            data-map-mode={mapMode ? 'true' : 'false'}
            variants={workspaceListVariants}
            initial="hidden"
            animate="visible"
            layout
            transition={panelTransition}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {toolsMode ? (
                <m.div
                  key="tools-pane"
                  className="workbench-pane workbench-pane--tools"
                  layout
                  variants={workspaceItemVariants}
                  {...panelMotion}
                >
                  {toolsSlot}
                </m.div>
              ) : (
                [
                  <m.div
                    key="primary-pane"
                    className={mapMode ? 'workbench-pane workbench-pane--map-primary' : 'workbench-pane workbench-pane--chat'}
                    layout
                    layoutId={mapMode ? 'workbench-map-surface' : 'workbench-chat-surface'}
                    variants={workspaceItemVariants}
                    {...panelMotion}
                  >
                    {mapMode ? mapSlot : mainSlot}
                  </m.div>,
                  <m.aside
                    key="inspector-pane"
                    className="workbench-pane workbench-pane--inspector"
                    aria-label="工作台检查器"
                    layout
                    variants={workspaceItemVariants}
                    {...panelMotion}
                  >
                    <div className="workbench-inspector-stack">
                      <m.div
                        className={mapMode ? 'workbench-side-swap workbench-side-swap--chat' : 'workbench-side-swap workbench-side-swap--map'}
                        layout
                        layoutId={mapMode ? 'workbench-chat-surface' : 'workbench-map-surface'}
                        transition={panelTransition}
                      >
                        {mapMode ? mainSlot : mapSlot}
                      </m.div>
                      {inspectorSlot}
                    </div>
                  </m.aside>,
                ]
              )}
            </AnimatePresence>
          </m.div>
        </m.main>
      </m.div>
      <nav className="workbench-mobile-tabs" aria-label="移动端工作台面板">
        {MOBILE_PANELS.map((panel) => (
          <m.button
            key={panel.id}
            type="button"
            className={`workbench-mobile-tab${effectiveMobilePanel === panel.id ? ' workbench-mobile-tab--active' : ''}`}
            aria-current={effectiveMobilePanel === panel.id ? 'page' : undefined}
            layout
            transition={panelTransition}
            onClick={() => selectMobilePanel(panel.id)}
          >
            <AppIcon name={panel.icon} size={18} />
            <span>{panel.label}</span>
          </m.button>
        ))}
      </nav>
    </m.div>
  )
}

function formatThreadAge(value?: string | null) {
  if (!value) return ''
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时`
  if (diff < 604_800_000) return `${Math.max(1, Math.floor(diff / 86_400_000))} 天`
  return `${Math.max(1, Math.floor(diff / 604_800_000))} 周`
}
