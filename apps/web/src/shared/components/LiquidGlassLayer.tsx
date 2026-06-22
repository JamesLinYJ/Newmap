// +-------------------------------------------------------------------------
//
//   地理智能平台 - 液体玻璃渲染层
//
//   文件:       LiquidGlassLayer.tsx
//
//   日期:       2026年06月18日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 位移图由 scripts/generate-liquid-glass-maps.mjs 预生成并由 Vite 加内容哈希。
// 首帧只显示 CSS 玻璃，浏览器空闲后再启用共享 SVG 折射滤镜。

import { createElement, useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import panelMap from '../../assets/liquid-glass/panel.png'
import strongMap from '../../assets/liquid-glass/strong.png'
import chipMap from '../../assets/liquid-glass/chip.png'
import barMap from '../../assets/liquid-glass/bar.png'

type GlassVariant = 'panel' | 'strong' | 'chip' | 'bar'
type GlassElement = 'div' | 'section' | 'article' | 'aside' | 'header'

interface LiquidGlassSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  as?: GlassElement
  children: ReactNode
  variant?: GlassVariant
}

const FILTERS: Record<GlassVariant, { id: string; href: string; scale: number }> = {
  panel: { id: 'dc-liquid-glass-panel', href: panelMap, scale: 0.072 },
  strong: { id: 'dc-liquid-glass-strong', href: strongMap, scale: 0.105 },
  chip: { id: 'dc-liquid-glass-chip', href: chipMap, scale: 0.062 },
  bar: { id: 'dc-liquid-glass-bar', href: barMap, scale: 0.052 },
}

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
        {(Object.entries(FILTERS) as Array<[GlassVariant, (typeof FILTERS)[GlassVariant]]>).map(([variant, filter]) => (
          <filter
            key={variant}
            id={filter.id}
            x="-0.08"
            y="-0.08"
            width="1.16"
            height="1.16"
            filterUnits="objectBoundingBox"
            primitiveUnits="objectBoundingBox"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={enhanced ? filter.href : undefined}
              x="0"
              y="0"
              width="1"
              height="1"
              preserveAspectRatio="none"
              result={`${variant}-map`}
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2={`${variant}-map`}
              xChannelSelector="R"
              yChannelSelector="G"
              scale={enhanced ? filter.scale : 0}
            />
          </filter>
        ))}
      </defs>
    </svg>
  )
}

export function LiquidGlassSurface({
  as = 'div',
  children,
  className = '',
  style,
  variant = 'panel',
  ...props
}: LiquidGlassSurfaceProps) {
  const liquidStyle = {
    ...style,
    '--liquid-filter': `url("#${FILTERS[variant].id}")`,
  } as CSSProperties

  return createElement(as, {
    ...props,
    className: `liquid-glass-surface liquid-glass-surface--${variant} ${className}`.trim(),
    style: liquidStyle,
  }, children)
}
