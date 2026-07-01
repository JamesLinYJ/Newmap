// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区模式规则测试
//
//   文件:       workspaceModeModel.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { isMapWorkspaceMode, reduceWorkspaceMode } from '../app/workspaceModeModel'
import type { SidebarItemId, WorkspaceMode } from '../app/types'

describe('workspace mode model', () => {
  it('only mode tabs switch the chat and map layout role', () => {
    // 工作区空间布局只接受顶部模式切换意图；功能入口不能隐式交换主副面板。
    expect(reduceWorkspaceMode('meteorology', { kind: 'mode-tab', mode: 'map' })).toBe('map')
    expect(reduceWorkspaceMode('map', { kind: 'mode-tab', mode: 'meteorology' })).toBe('meteorology')
  })

  it('keeps workspace mode stable when sidebar items select content panels', () => {
    const sidebarItems: SidebarItemId[] = ['assistant', 'query', 'sources', 'tools', 'config', 'export']
    const modes: WorkspaceMode[] = ['meteorology', 'map']

    for (const mode of modes) {
      for (const id of sidebarItems) {
        expect(reduceWorkspaceMode(mode, { kind: 'sidebar-item', id })).toBe(mode)
      }
    }
  })

  it('keeps workspace mode stable for top nav and mobile panel intents', () => {
    expect(reduceWorkspaceMode('meteorology', { kind: 'top-nav', nav: 'layers' })).toBe('meteorology')
    expect(reduceWorkspaceMode('map', { kind: 'top-nav', nav: 'analysis' })).toBe('map')
    expect(reduceWorkspaceMode('meteorology', { kind: 'mobile-panel', panel: 'map' })).toBe('meteorology')
    expect(reduceWorkspaceMode('map', { kind: 'mobile-panel', panel: 'chat' })).toBe('map')
  })

  it('derives map primary layout only from workspace mode', () => {
    expect(isMapWorkspaceMode('meteorology')).toBe(false)
    expect(isMapWorkspaceMode('map')).toBe(true)
  })
})
