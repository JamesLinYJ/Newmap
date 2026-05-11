// +-------------------------------------------------------------------------
//
//   地理智能平台 - 状态标签组件
//
//   文件:       StatusPill.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 提供统一的状态标签渲染，复用在调试页、运行态和详情面板。

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
