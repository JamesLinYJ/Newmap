// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区模式规则模型
//
//   文件:       workspaceModeModel.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 将 chat / map 主副位置的切换规则收敛为纯函数。左侧功能项、顶部导航和
// 移动端面板只选择内容视图，不能成为工作区空间布局的事实源。

import type { PrimaryNav, SidebarItemId, WorkspaceMode } from './types'

export type WorkspaceModeIntent =
  | { kind: 'mode-tab'; mode: WorkspaceMode }
  | { kind: 'sidebar-item'; id: SidebarItemId }
  | { kind: 'top-nav'; nav: PrimaryNav }
  | { kind: 'mobile-panel'; panel: 'chat' | 'map' | 'results' | 'tools' }

export function reduceWorkspaceMode(current: WorkspaceMode, intent: WorkspaceModeIntent): WorkspaceMode {
  if (intent.kind === 'mode-tab') {
    return intent.mode
  }
  return current
}

export function isMapWorkspaceMode(mode: WorkspaceMode) {
  return mode === 'map'
}
