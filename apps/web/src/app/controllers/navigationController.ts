// +-------------------------------------------------------------------------
//
//   地理智能平台 - 视图导航控制器
//
//   文件:       navigationController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { useCallback, useState } from 'react'
import { SAMPLES } from '../../shared/constants'
import {
  buildWorkspaceShareUrl,
  readWorkspacePointer,
  syncCleanWorkspaceUrl,
} from '../../shared/workspacePointer'
import type { PanelMode, PrimaryNav, SidebarItemId } from '../types'

interface NavigationControllerOptions {
  currentThreadId?: string | null
  runId?: string
  sessionId?: string
  setUiError: (error?: string) => void
}

// 导航控制器持有用户编辑态和页面视图选择。
//
// URL 只在显式分享或恢复 thread/run 时编码，普通导航不会制造业务状态。
export function useNavigationController({
  currentThreadId,
  runId,
  sessionId,
  setUiError,
}: NavigationControllerOptions) {
  const [query, setQuery] = useState('')
  const [activeNav, setActiveNav] = useState<PrimaryNav>('analysis')
  const [panelMode, setPanelMode] = useState<PanelMode>('summary')
  const [activeSidebarItem, setActiveSidebarItem] = useState<SidebarItemId>('assistant')

  const focusQueryInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = document.getElementById('analysis-query-input')
      if (input instanceof HTMLInputElement) {
        input.focus()
        input.select()
      }
    })
  }, [])

  const showSources = useCallback(() => {
    setActiveNav('layers')
    setPanelMode('layerManager')
    setActiveSidebarItem('sources')
  }, [])

  const changePrimaryNav = useCallback((nav: PrimaryNav) => {
    setActiveNav(nav)
    if (nav === 'analysis') {
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      focusQueryInput()
      return
    }
    if (nav === 'layers') {
      showSources()
      return
    }
    if (nav === 'history') {
      setPanelMode('history')
      setActiveSidebarItem('assistant')
      return
    }
    if (nav === 'tools') {
      setPanelMode('tools')
      setActiveSidebarItem('tools')
      return
    }
    setPanelMode('compute')
    setActiveSidebarItem('assistant')
  }, [focusQueryInput, showSources])

  const selectSample = useCallback((value: string) => {
    setQuery(value)
    setActiveNav('analysis')
    setPanelMode('summary')
    setActiveSidebarItem('assistant')
    focusQueryInput()
  }, [focusQueryInput])

  const useNextTemplate = useCallback(() => {
    const currentIndex = SAMPLES.findIndex(item => item === query)
    selectSample(SAMPLES[(currentIndex + 1 + SAMPLES.length) % SAMPLES.length])
  }, [query, selectSample])

  const selectSidebarItem = useCallback((itemId: SidebarItemId) => {
    setActiveSidebarItem(itemId)
    if (itemId === 'assistant') {
      changePrimaryNav('analysis')
      return
    }
    if (itemId === 'query') {
      selectSample(SAMPLES[0])
      return
    }
    if (itemId === 'sources') {
      showSources()
      setPanelMode('sources')
      return
    }
    if (itemId === 'tools') {
      changePrimaryNav('tools')
      return
    }
    setActiveNav('analysis')
    setPanelMode(itemId === 'config' ? 'config' : 'export')
  }, [changePrimaryNav, selectSample, showSources])

  const copyShareLink = useCallback(async () => {
    try {
      const url = buildWorkspaceShareUrl(window.location.origin, sessionId, runId, currentThreadId ?? undefined)
      await navigator.clipboard.writeText(url)
    } catch {
      setUiError('复制分享链接失败，请稍后重试。')
    }
  }, [currentThreadId, runId, sessionId, setUiError])

  return {
    activeNav,
    activeSidebarItem,
    changePrimaryNav,
    copyShareLink,
    focusQueryInput,
    panelMode,
    query,
    readWorkspacePointer,
    selectSample,
    selectSidebarItem,
    setActiveNav,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    showSources,
    syncUrl: syncCleanWorkspaceUrl,
    useNextTemplate,
  }
}
