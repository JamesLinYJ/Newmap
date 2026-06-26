// +-------------------------------------------------------------------------
//
//   地理智能平台 - 状态徽标组件
//
//   文件:       StatusPill.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ReactNode } from 'react'

export type StatusPillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'error'

interface StatusPillProps {
  label: ReactNode
  tone?: StatusPillTone | string
  title?: string
}

export function StatusPill({ label, tone = 'neutral', title }: StatusPillProps) {
  const normalizedTone = tone === 'error' ? 'danger' : tone
  return (
    <span className={`status-pill status-pill--${normalizedTone}`} title={title}>
      {label}
    </span>
  )
}
