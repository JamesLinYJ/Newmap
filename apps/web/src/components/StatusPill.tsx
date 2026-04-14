// +-------------------------------------------------------------------------
//
//   地理智能平台 - 状态标签组件
//
//   文件:       StatusPill.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

interface StatusPillProps {
  label: string
  tone?: 'neutral' | 'success' | 'warning' | 'accent' | 'danger'
}

export function StatusPill({ label, tone = 'neutral' }: StatusPillProps) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className="status-pill__dot" aria-hidden="true" />
      {label}
    </span>
  )
}
