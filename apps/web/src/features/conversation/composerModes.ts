// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入模式
//
//   文件:       composerModes.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ComposerMode } from './types'

export interface ComposerModeOption {
  id: ComposerMode
  label: string
  description: string
  badge: string
}

export const COMPOSER_MODES: readonly ComposerModeOption[] = [
  {
    id: 'auto',
    label: '自动模式',
    description: '自动规划、调用工具并推进结果。',
    badge: 'Todo 跟踪 · 自动推进',
  },
  {
    id: 'plan',
    label: '计划模式',
    description: '先生成执行计划，确认后再继续。',
    badge: '先审阅 · 后执行',
  },
] as const
