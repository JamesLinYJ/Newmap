interface TopBarProps {
  activeNav: 'analysis' | 'layers' | 'history' | 'compute'
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

export function TopBar({ activeNav, onNavChange, onPrimaryAction, primaryActionLabel }: TopBarProps) {
  return (
    <header className="dc-topbar">
      <div className="dc-topbar__brand">
        <h1>空间智能工作台</h1>
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
        <button className="dc-topbar__cta" type="button" onClick={onPrimaryAction}>
          {primaryActionLabel}
        </button>
      </div>
    </header>
  )
}
