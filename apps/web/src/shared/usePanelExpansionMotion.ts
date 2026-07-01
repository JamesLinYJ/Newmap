// +-------------------------------------------------------------------------
//
//   地理智能平台 - 通用面板展开动效控制器
//
//   文件:       usePanelExpansionMotion.ts
//
//   日期:       2026年06月26日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 统一管理工作台面板从原位置形变到全屏的 iOS 风格动效。这里保存源面板
// DOM、目标视口矩形、重复点击节流和滚动锁，避免展开态组件覆盖源位置后
// 下一次动画丢失起点。

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Transition } from 'framer-motion'

export type PanelRect = { top: number; left: number; width: number; height: number }
export type PanelSurfaceStyle = {
  borderRadius: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
}

export interface PanelExpansionGeometry {
  origin: PanelRect
  target: PanelRect
  originStyle: PanelSurfaceStyle
  targetStyle: PanelSurfaceStyle
}

interface PanelExpansionMotionOptions {
  reducedMotion: boolean
}

export interface PanelExpansionMotion {
  sourceRef: RefObject<HTMLElement | null>
  isExpanded: boolean
  isMorphing: boolean
  canUsePortal: boolean
  geometry: PanelExpansionGeometry
  spring: Transition
  backdropTransition: Transition
  expand: () => void
  collapse: () => void
  markSettled: () => void
}

const FALLBACK_RECT: PanelRect = { top: 0, left: 0, width: 1024, height: 720 }
const FALLBACK_SURFACE_STYLE: PanelSurfaceStyle = {
  borderRadius: 28,
  paddingTop: 28,
  paddingRight: 48,
  paddingBottom: 24,
  paddingLeft: 48,
}
const MORPH_SETTLE_MS = 420

export function usePanelExpansionMotion({ reducedMotion }: PanelExpansionMotionOptions): PanelExpansionMotion {
  const sourceRef = useRef<HTMLElement | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isMorphing, setIsMorphing] = useState(false)
  const [geometry, setGeometry] = useState<PanelExpansionGeometry | null>(null)
  const canUsePortal = typeof document !== 'undefined'

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current === null || typeof window === 'undefined') return
    window.clearTimeout(settleTimerRef.current)
    settleTimerRef.current = null
  }, [])

  const markSettled = useCallback(() => {
    clearSettleTimer()
    setIsMorphing(false)
  }, [clearSettleTimer])

  const beginMorph = useCallback(() => {
    setIsMorphing(true)
    clearSettleTimer()
    if (reducedMotion || typeof window === 'undefined') {
      setIsMorphing(false)
      return
    }
    settleTimerRef.current = window.setTimeout(markSettled, MORPH_SETTLE_MS)
  }, [clearSettleTimer, markSettled, reducedMotion])

  const expand = useCallback(() => {
    if (isMorphing) return
    const target = getExpandedPanelRect()
    const targetStyle = getExpandedPanelStyle()
    const origin = sourceRef.current
      ? rectFromDomRect(sourceRef.current.getBoundingClientRect())
      : geometry?.origin ?? target
    const originStyle = sourceRef.current
      ? readSurfaceStyle(sourceRef.current)
      : geometry?.originStyle ?? targetStyle
    setGeometry({ origin, target, originStyle, targetStyle })
    beginMorph()
    setIsExpanded(true)
  }, [beginMorph, geometry?.origin, geometry?.originStyle, isMorphing])

  const collapse = useCallback(() => {
    if (isMorphing) return
    const target = getExpandedPanelRect()
    const targetStyle = getExpandedPanelStyle()
    setGeometry((current) => current
      ? { ...current, target, targetStyle }
      : { origin: target, target, originStyle: targetStyle, targetStyle })
    beginMorph()
    setIsExpanded(false)
  }, [beginMorph, isMorphing])

  useEffect(() => () => clearSettleTimer(), [clearSettleTimer])

  useEffect(() => {
    if (!isExpanded) return
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') collapse()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [collapse, isExpanded])

  useEffect(() => {
    if (!isExpanded || typeof document === 'undefined') return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isExpanded])

  useEffect(() => {
    if (!isExpanded || typeof window === 'undefined') return
    const handleResize = () => {
      setGeometry((current) => current
        ? { ...current, target: getExpandedPanelRect(), targetStyle: getExpandedPanelStyle() }
        : current)
    }
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [isExpanded])

  const transitions = useMemo(() => {
    if (reducedMotion) {
      const instant = { duration: 0 } satisfies Transition
      return {
        spring: instant,
        backdropTransition: instant,
      }
    }
    return {
      spring: {
        type: 'spring',
        stiffness: 290,
        damping: 34,
        mass: 0.88,
      } satisfies Transition,
      backdropTransition: {
        duration: 0.22,
        ease: [0.25, 0.1, 0.25, 1],
      } satisfies Transition,
    }
  }, [reducedMotion])

  const safeGeometry = geometry ?? {
    origin: getExpandedPanelRect(),
    target: getExpandedPanelRect(),
    originStyle: FALLBACK_SURFACE_STYLE,
    targetStyle: getExpandedPanelStyle(),
  }

  return {
    sourceRef,
    isExpanded,
    isMorphing,
    canUsePortal,
    geometry: safeGeometry,
    expand,
    collapse,
    markSettled,
    ...transitions,
  }
}

export function rectToMotion(rect: PanelRect) {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  }
}

export function surfaceStyleToMotion(style: PanelSurfaceStyle) {
  return {
    borderRadius: style.borderRadius,
    paddingTop: style.paddingTop,
    paddingRight: style.paddingRight,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
  }
}

function rectFromDomRect(rect: DOMRect): PanelRect {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  }
}

function readSurfaceStyle(element: HTMLElement): PanelSurfaceStyle {
  const style = window.getComputedStyle(element)
  return {
    borderRadius: parsePixelValue(style.borderTopLeftRadius),
    paddingTop: parsePixelValue(style.paddingTop),
    paddingRight: parsePixelValue(style.paddingRight),
    paddingBottom: parsePixelValue(style.paddingBottom),
    paddingLeft: parsePixelValue(style.paddingLeft),
  }
}

function getExpandedPanelRect(): PanelRect {
  if (typeof window === 'undefined') {
    return FALLBACK_RECT
  }
  const viewport = window.visualViewport
  const width = viewport?.width ?? window.innerWidth
  const height = viewport?.height ?? window.innerHeight
  const offsetLeft = viewport?.offsetLeft ?? 0
  const offsetTop = viewport?.offsetTop ?? 0
  const inset = width <= 900 ? 10 : Math.min(Math.max(width * 0.024, 18), 34)
  return {
    top: offsetTop + inset,
    left: offsetLeft + inset,
    width: Math.max(280, width - inset * 2),
    height: Math.max(420, height - inset * 2),
  }
}

function getExpandedPanelStyle(): PanelSurfaceStyle {
  if (typeof window === 'undefined') {
    return FALLBACK_SURFACE_STYLE
  }
  const width = window.visualViewport?.width ?? window.innerWidth
  const height = window.visualViewport?.height ?? window.innerHeight
  if (width <= 900) {
    return {
      borderRadius: 22,
      paddingTop: 18,
      paddingRight: 14,
      paddingBottom: 14,
      paddingLeft: 14,
    }
  }
  return {
    borderRadius: 28,
    paddingTop: clampNumber(height * 0.03, 22, 34),
    paddingRight: clampNumber(width * 0.042, 24, 58),
    paddingBottom: clampNumber(height * 0.024, 18, 28),
    paddingLeft: clampNumber(width * 0.042, 24, 58),
  }
}

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
