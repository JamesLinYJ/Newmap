// +-------------------------------------------------------------------------
//
//   地理智能平台 - 顶部导航栏组件
//
//   文件:       TopBar.tsx
//
//   日期:       2026年05月09日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 提供 iOS 26 风格的全局导航玻璃栏，承接主工作区切换和首要操作入口。

import { Compass, Database, Sparkles, Wrench, Zap } from 'lucide-react'
import { LiquidGlassSurface } from '../../shared/components/LiquidGlassLayer'
import type { PrimaryNav } from '../types'

interface TopBarProps {
  activeNav: PrimaryNav
  artifactCount: number; providerLabel: string; runStatusLabel: string
  onNavChange: (nav: PrimaryNav) => void
  onPrimaryAction: () => void; primaryActionLabel: string
}

const NAV = [
  { id: 'analysis' as const, label: '分析', icon: Sparkles },
  { id: 'layers' as const, label: '图层', icon: Database },
  { id: 'history' as const, label: '历史', icon: Compass },
  { id: 'compute' as const, label: '计算', icon: Zap },
  { id: 'tools' as const, label: '工具', icon: Wrench },
]

export function TopBar({ activeNav, artifactCount, providerLabel, runStatusLabel, onNavChange, onPrimaryAction, primaryActionLabel }: TopBarProps) {
  return (
    <LiquidGlassSurface as="header" variant="bar" className="nav-bar">
      <div className="nav-bar__identity">
        <div className="nav-bar__mark liquid-chip">
          <Compass size={17} />
        </div>
        <div className="nav-bar__brand">
          <strong>地理智能</strong>
          <span>气象空间决策平台</span>
        </div>
        <nav className="nav-bar__nav" aria-label="主导航">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button"
              className={`nav-bar__nav-item ${
                activeNav === id ? 'nav-bar__nav-item--active liquid-chip' : ''
              }`}
              onClick={() => onNavChange(id)}>
              <Icon size={14} /><span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="nav-bar__status">
        <span className="nav-bar__status-chip liquid-chip hidden lg:inline-flex">
          <Sparkles size={11}/>{runStatusLabel}
        </span>
        <span className="nav-bar__status-chip liquid-chip hidden xl:inline-flex">
          <Zap size={11}/>{providerLabel}
        </span>
        <span className="nav-bar__status-chip liquid-chip hidden lg:inline-flex">
          <Database size={11}/>{artifactCount}
        </span>
        <button className="btn btn-primary btn-sm" onClick={onPrimaryAction}>{primaryActionLabel}</button>
      </div>
    </LiquidGlassSurface>
  )
}
