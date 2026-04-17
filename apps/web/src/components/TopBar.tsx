// +-------------------------------------------------------------------------
//
//   地理智能平台 - 顶部导航栏组件
//
//   文件:       TopBar.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { Compass, Database, Sparkles } from 'lucide-react'

interface TopBarProps {
  activeNav: 'analysis' | 'layers' | 'history' | 'compute'
  artifactCount: number
  providerLabel: string
  runStatusLabel: string
  onNavChange: (nav: 'analysis' | 'layers' | 'history' | 'compute') => void
  onPrimaryAction: () => void
  primaryActionLabel: string
}

const NAV_ITEMS = [
  { id: 'analysis', label: '分析' },
  { id: 'layers', label: '图层' },
  { id: 'history', label: '历史' },
  { id: 'compute', label: '计算' },
] as const

export function TopBar({ activeNav, artifactCount, providerLabel, runStatusLabel, onNavChange, onPrimaryAction, primaryActionLabel }: TopBarProps) {
  // 顶部导航栏
  //
  // 负责主导航切换与全局主操作入口，保持桌面端与移动端信息架构的顶层一致性。
  return (
    <header className="dc-topbar">
      <div className="dc-topbar__brand">
        <div className="dc-topbar__identity">
          <div className="dc-topbar__brand-mark" aria-hidden="true">
            <Compass size={18} />
          </div>
          <div>
            <div className="dc-topbar__eyebrow">Geo Agent Platform</div>
            <h1>空间智能工作台</h1>
          </div>
        </div>
        <nav className="dc-topbar__nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeNav === item.id ? 'dc-topbar__nav-item dc-topbar__nav-item--active' : 'dc-topbar__nav-item'}
              onClick={() => onNavChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="dc-topbar__actions">
        <div className="dc-topbar__meta" aria-label="当前工作台状态">
          <div className="dc-topbar__meta-item">
            <Sparkles size={14} aria-hidden="true" />
            <span>{runStatusLabel}</span>
          </div>
          <div className="dc-topbar__meta-item">
            <Database size={14} aria-hidden="true" />
            <span>{artifactCount} 个结果</span>
          </div>
          <div className="dc-topbar__meta-item">
            <Compass size={14} aria-hidden="true" />
            <span>{providerLabel}</span>
          </div>
        </div>
        <button className="dc-topbar__cta" type="button" onClick={onPrimaryAction}>
          {primaryActionLabel}
        </button>
      </div>
    </header>
  )
}
