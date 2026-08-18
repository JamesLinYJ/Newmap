// +-------------------------------------------------------------------------
//
//   地理智能平台 - 液体玻璃渲染层
//
//   文件:       LiquidGlassLayer.tsx
//
//   日期:       2026年06月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-08-18):
//     作者: JamesLinYJ
//     协助: OpenAI ChatGPT:GPT-5.6 Pro
//     说明: 收敛为单一权威玻璃材质；旧 variant 仅保留调用兼容，不再改变视觉。
// --------------------------------------------------------------------------

// 位移图由 scripts/generate-liquid-glass-maps.mjs 预生成并由 Vite 加内容哈希。
// 首帧只显示稳定 CSS 表面，浏览器空闲后再启用唯一的共享 SVG 折射滤镜。

import { createElement, useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import surfaceMap from '../../assets/liquid-glass/panel.png'

type LegacyGlassVariant = 'panel' | 'strong' | 'chip' | 'bar'
type GlassElement = 'div' | 'section' | 'article' | 'aside' | 'header'

interface LiquidGlassSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  as?: GlassElement
  children: ReactNode
  /**
   * @deprecated 仅用于兼容旧调用。所有值都映射到同一材质，
   * 层级差异应通过布局、间距和语义表面表达。
   */
  variant?: LegacyGlassVariant
}

const CANONICAL_FILTER = {
  id: 'dc-liquid-glass-surface',
  href: surfaceMap,
  scale: 0.09,
} as const

export function LiquidGlassLayer() {
  const [enhanced, setEnhanced] = useState(false)

  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const prefersContrast = window.matchMedia('(prefers-contrast: more)').matches
    if (connection?.saveData || prefersReducedMotion || prefersContrast) return

    let idleHandle: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const enable = () => setEnhanced(true)
    if ('requestIdleCallback' in window) {
      idleHandle = window.requestIdleCallback(enable, { timeout: 1800 })
    } else {
      timer = setTimeout(enable, 250)
    }
    return () => {
      if (idleHandle !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle)
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <svg className="liquid-glass-defs" aria-hidden="true" focusable="false" width="0" height="0">
      <defs>
        <filter
          id={CANONICAL_FILTER.id}
          x="-0.08"
          y="-0.08"
          width="1.16"
          height="1.16"
          filterUnits="objectBoundingBox"
          primitiveUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feImage
            href={enhanced ? CANONICAL_FILTER.href : undefined}
            x="0"
            y="0"
            width="1"
            height="1"
            preserveAspectRatio="none"
            result="surface-map"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="surface-map"
            xChannelSelector="R"
            yChannelSelector="G"
            scale={enhanced ? CANONICAL_FILTER.scale : 0}
          />
        </filter>
      </defs>
    </svg>
  )
}

export function LiquidGlassSurface({
  as = 'div',
  children,
  className = '',
  style,
  variant: legacyVariant,
  ...props
}: LiquidGlassSurfaceProps) {
  // 保留旧 prop 只为避免调用方迁移噪声；视觉事实源始终只有一个。
  void legacyVariant
  const filter = `url("#${CANONICAL_FILTER.id}")`
  const liquidStyle = {
    ...style,
    '--ui-glass-filter': filter,
    '--liquid-filter': filter,
  } as CSSProperties

  return createElement(as, {
    ...props,
    'data-ui-surface': 'glass',
    className: `liquid-glass-surface ${className}`.trim(),
    style: liquidStyle,
  }, children)
}
