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

import { Compass, Database, Sparkles, Zap } from 'lucide-react'

interface TopBarProps {
  activeNav: 'analysis' | 'layers' | 'history' | 'compute'
  artifactCount: number; providerLabel: string; runStatusLabel: string
  onNavChange: (nav: 'analysis' | 'layers' | 'history' | 'compute') => void
  onPrimaryAction: () => void; primaryActionLabel: string
}

const NAV = [
  { id: 'analysis' as const, label: '分析', icon: Sparkles },
  { id: 'layers' as const, label: '图层', icon: Database },
  { id: 'history' as const, label: '历史', icon: Compass },
  { id: 'compute' as const, label: '计算', icon: Zap },
]

export function TopBar({ activeNav, artifactCount, providerLabel, runStatusLabel, onNavChange, onPrimaryAction, primaryActionLabel }: TopBarProps) {
  return (
    <header className="nav-bar">
      <div className="flex items-center gap-4 min-w-0 flex-1">
        <div className="w-8 h-8 grid place-items-center rounded-[10px] border border-white/42 bg-white/38 text-[#1c1c1e] shadow-[inset_0_1px_0_rgb(255_255_255/0.62),0_8px_18px_rgb(28_28_30/0.07)] backdrop-blur-xl">
          <Compass size={17} />
        </div>
        <nav className="flex items-center gap-0.5" aria-label="主导航">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button"
              className={`flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[13px] font-medium cursor-pointer transition-all duration-200 border-0 ${
                activeNav===id ? 'bg-white/42 text-[#1c1c1e] shadow-[inset_0_1px_0_rgb(255_255_255/0.62)] backdrop-blur-xl' : 'text-[#8e8e93] hover:text-[#3a3a3c] hover:bg-[#00000004]'
              }`}
              onClick={() => onNavChange(id)}>
              <Icon size={14} /><span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden lg:inline-flex items-center gap-1 h-7 px-2.5 rounded-[10px] text-[11px] text-[#8e8e93] font-medium bg-[#00000004]">
          <Sparkles size={11}/>{runStatusLabel}
        </span>
        <span className="hidden xl:inline-flex items-center gap-1 h-7 px-2.5 rounded-[10px] text-[11px] text-[#8e8e93] font-medium bg-[#00000004]">
          <Zap size={11}/>{providerLabel}
        </span>
        <span className="hidden lg:inline-flex items-center gap-1 h-7 px-2.5 rounded-[10px] text-[11px] text-[#8e8e93] font-medium bg-[#00000004]">
          <Database size={11}/>{artifactCount}
        </span>
        <button className="btn btn-primary btn-sm" onClick={onPrimaryAction}>{primaryActionLabel}</button>
      </div>
    </header>
  )
}
