import { ClipboardList, Zap, type LucideIcon } from 'lucide-react'

import type { ComposerMode } from './types'

export const COMPOSER_MODES = [
  {
    id: 'plan',
    label: '计划模式',
    description: '先整理步骤和风险，确认后再执行分析。',
    icon: ClipboardList,
  },
  {
    id: 'auto',
    label: '自动模式',
    description: '自动执行安全分析，高风险动作仍会停下确认。',
    icon: Zap,
  },
] as const satisfies ReadonlyArray<{
  id: ComposerMode
  label: string
  description: string
  icon: LucideIcon
}>
