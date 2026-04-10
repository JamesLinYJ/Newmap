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
