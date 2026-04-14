// +-------------------------------------------------------------------------
//
//   地理智能平台 - 应用图标适配器
//
//   文件:       AppIcon.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { SVGProps } from 'react'
import {
  Bot,
  Brain,
  Database,
  Gauge,
  History,
  Layers3,
  LocateFixed,
  Map,
  Minus,
  Plus,
  ScanSearch,
  Send,
  Settings2,
  Share2,
  Sparkles,
  TrendingUp,
  Upload,
} from 'lucide-react'

export type AppIconName =
  | 'psychology'
  | 'explore'
  | 'database'
  | 'settings_account_box'
  | 'ios_share'
  | 'analytics'
  | 'layers'
  | 'history'
  | 'tune'
  | 'deployed_code'
  | 'smart_toy'
  | 'insights'
  | 'auto_awesome'
  | 'send'
  | 'attach_file'
  | 'history_edu'
  | 'add'
  | 'remove'
  | 'my_location'

interface AppIconProps extends SVGProps<SVGSVGElement> {
  name: AppIconName
  size?: number | string
}

// 图标映射表
//
// 统一把业务语义图标名映射到 Lucide 图标，避免界面层直接散落第三方图标引用。
const ICONS: Record<AppIconName, typeof Bot> = {
  psychology: Brain,
  explore: ScanSearch,
  database: Database,
  settings_account_box: Settings2,
  ios_share: Share2,
  analytics: Gauge,
  layers: Layers3,
  history: History,
  tune: Settings2,
  deployed_code: Map,
  smart_toy: Bot,
  insights: TrendingUp,
  auto_awesome: Sparkles,
  send: Send,
  attach_file: Upload,
  history_edu: History,
  add: Plus,
  remove: Minus,
  my_location: LocateFixed,
}

export function AppIcon({ name, size = 18, ...props }: AppIconProps) {
  const Icon = ICONS[name]
  return <Icon aria-hidden="true" size={size} strokeWidth={2} {...props} />
}
