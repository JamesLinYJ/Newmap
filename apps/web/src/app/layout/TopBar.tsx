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
// 提供浅色 Workbench 顶部控制条。它只承接全局导航入口和运行状态，
// 不再承担旧主导航的信息架构，避免与三栏工作台骨架互相挤压。

import { ArrowLeft, ArrowRight, Database, Menu, PanelLeft, PanelRight, Search, Sparkles, Zap } from 'lucide-react'
import type { PrimaryNav } from '../types'

interface TopBarProps {
  activeNav: PrimaryNav
  artifactCount: number; providerLabel: string; runStatusLabel: string
  onNavChange: (nav: PrimaryNav) => void
  onPrimaryAction: () => void; primaryActionLabel: string
}

const QUICK_NAV: ReadonlyArray<{ id: PrimaryNav; label: string }> = [
  { id: 'analysis', label: '分析' },
  { id: 'layers', label: '图层' },
  { id: 'tools', label: '工具' },
]

export function TopBar({ activeNav, artifactCount, providerLabel, runStatusLabel, onNavChange, onPrimaryAction, primaryActionLabel }: TopBarProps) {
  return (
    <header className="workbench-chrome">
      <div className="workbench-chrome__left" aria-label="工作台控制">
        <span className="workbench-chrome__icon workbench-chrome__icon--passive" aria-hidden="true">
          <Menu size={18} />
        </span>
        <span className="workbench-chrome__icon workbench-chrome__icon--passive" aria-hidden="true">
          <PanelLeft size={17} />
        </span>
        <span className="workbench-chrome__icon workbench-chrome__icon--passive" aria-hidden="true">
          <Search size={17} />
        </span>
        <span className="workbench-chrome__divider" />
        <button className="workbench-chrome__icon" type="button" aria-label="返回" onClick={() => window.history.back()}>
          <ArrowLeft size={17} />
        </button>
        <button className="workbench-chrome__icon" type="button" aria-label="前进" onClick={() => window.history.forward()}>
          <ArrowRight size={17} />
        </button>
      </div>

      <nav className="workbench-chrome__center" aria-label="快速导航">
        {QUICK_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={activeNav === item.id ? 'workbench-chrome__nav workbench-chrome__nav--active' : 'workbench-chrome__nav'}
            onClick={() => onNavChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="workbench-chrome__right">
        <span className="workbench-chrome__icon workbench-chrome__icon--passive workbench-chrome__panel" aria-hidden="true">
          <PanelRight size={17} />
        </span>
        <span className="workbench-chrome__status">
          <Sparkles size={11}/>{runStatusLabel}
        </span>
        <span className="workbench-chrome__status workbench-chrome__status--wide">
          <Zap size={11}/>{providerLabel}
        </span>
        <span className="workbench-chrome__status">
          <Database size={11}/>{artifactCount}
        </span>
        <button className="workbench-chrome__primary" type="button" onClick={onPrimaryAction}>{primaryActionLabel}</button>
      </div>
    </header>
  )
}
