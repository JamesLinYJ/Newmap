// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布组件
//
//   文件:       MapCanvas.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 负责地图实例管理、底图切换、结果图层渲染和视角同步。

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, m, useReducedMotion } from 'framer-motion'
import maplibregl, { LngLatBounds, Map, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Ruler } from 'lucide-react'

import type { ArtifactRef, BasemapDescriptor } from '@geo-agent-platform/shared-types'
import { buildFadeMotion, buildFadeUpMotion, buildPressMotion } from '../motion'
import { AppIcon } from './AppIcon'

type GeoJsonPayload = GeoJSON.FeatureCollection
type MapManualDragState = {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  dragging: boolean
}

interface MapCanvasProps {
  artifactCount: number
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  runStatus?: string
  onSelectBasemap: (basemapKey: string) => void
  layers: Array<{
    artifact: ArtifactRef
    data: GeoJsonPayload
    visible: boolean
    opacity: number
    featureCount: number
    geometrySummary: string
  }>
  selectedArtifactId?: string
  selectedArtifactName?: string
  onSelectArtifact: (artifactId: string) => void
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
}

export function MapCanvas({
  basemaps,
  selectedBasemapKey,
  onSelectBasemap,
  layers,
  selectedArtifactId,
  selectedArtifactName,
  onSelectArtifact,
  placeResolution,
}: MapCanvasProps) {
  // 地图主画布
  //
  // 负责承载 MapLibre 地图实例、底图切换、结果图层渲染、自动视野定位，
  // 以及与主工作台之间的选中状态同步。
  const stageRef = useRef<HTMLElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const boundsRef = useRef<LngLatBounds | null>(null)
  const appliedBasemapKeyRef = useRef<string | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const manualDragRef = useRef<MapManualDragState | null>(null)
  const suppressNextMapClickRef = useRef(false)
  const measureModeRef = useRef(false)
  const layersRef = useRef(layers)
  const onSelectArtifactRef = useRef(onSelectArtifact)
  const [cursor, setCursor] = useState('114.0579, 22.5431')
  const [interactionHint, setInteractionHint] = useState('拖拽平移 · 滚轮缩放 · 点击对象查看详情')
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<Array<[number, number]>>([])
  const [showLayerLegend, setShowLayerLegend] = useState(true)
  const [mapError, setMapError] = useState<string | null>(null)
  const [tileWarning, setTileWarning] = useState<string | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const activeBasemap =
    basemaps.find((item) => item.basemapKey === selectedBasemapKey) ??
    basemaps.find((item) => item.isDefault) ??
    basemaps[0] ??
    FALLBACK_BASEMAP
  const initialBasemapRef = useRef(activeBasemap)

  const cycleBasemap = useCallback(() => {
    // 底图轮转
    //
    // 维持一个极简但高频可用的交互：不弹复杂菜单，直接在可用底图间循环切换。
    if (!basemaps.length) {
      return
    }
    const currentIndex = basemaps.findIndex((item) => item.basemapKey === selectedBasemapKey)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % basemaps.length : 0
    onSelectBasemap(basemaps[nextIndex]?.basemapKey ?? basemaps[0].basemapKey)
  }, [basemaps, onSelectBasemap, selectedBasemapKey])

  const focusSelection = useCallback(() => {
    // 定位到当前结果
    //
    // 有选中 artifact 时优先聚焦该结果；否则回退到当前所有结果的总 bounds，
    // 再不行才飞回默认城市视图。
    const map = mapRef.current
    if (!map) {
      return
    }
    const selectionBounds = selectedArtifactId
      ? boundsFromCollection(layers.find((item) => item.artifact.artifactId === selectedArtifactId)?.data)
      : boundsRef.current

    if (selectionBounds && !selectionBounds.isEmpty()) {
      map.fitBounds(selectionBounds, { padding: 120, duration: 900, maxZoom: 14 })
      return
    }

    map.flyTo({ center: [121.4737, 31.2304], zoom: 11.2 })
  }, [layers, selectedArtifactId])

  // 地点解析成功后自动飞行到目标坐标
  const lastFlownRef = useRef<string | null>(null)
  useEffect(() => {
    if (!placeResolution || placeResolution.status !== 'resolved') return
    const lat = placeResolution.selected?.latitude
    const lng = placeResolution.selected?.longitude
    if (lat == null || lng == null) return
    const key = `${lat},${lng}`
    if (key === lastFlownRef.current) return
    lastFlownRef.current = key
    const map = mapRef.current
    if (!map) return
    map.flyTo({ center: [lng, lat], zoom: 14, duration: 1200 })
  }, [placeResolution])

  const handlePointerMove = useCallback((lng: number, lat: number) => {
    setCursor(`${lng.toFixed(4)}, ${lat.toFixed(4)}`)
  }, [])

  const toggleMeasureMode = useCallback(() => {
    setMeasureMode((current) => {
      const next = !current
      setInteractionHint(next ? '测距模式已开启，点击地图连续落点即可计算距离' : '拖拽平移 · 滚轮缩放 · 点击对象查看详情')
      if (!next) {
        setMeasurePoints([])
      }
      return next
    })
  }, [])

  useEffect(() => {
    measureModeRef.current = measureMode
  }, [measureMode])

  useEffect(() => {
    // 地图拖拽边界
    //
    // 液体玻璃层与 Framer Motion 会让视觉层级更复杂，因此拖拽不只依赖
    // MapLibre 内建 handler；这里在地图舞台捕获 pointer 事件，直接平移地图。
    const stage = stageRef.current
    if (!stage) {
      return
    }

    const endDrag = (event?: PointerEvent) => {
      const state = manualDragRef.current
      if (!state) {
        return
      }

      if (event && event.pointerId !== state.pointerId) {
        return
      }

      if (!state.dragging && event && measureModeRef.current) {
        const map = mapRef.current
        const pointLngLat = map ? getMapPointerLngLat(map, event.clientX, event.clientY) : null
        if (pointLngLat) {
          setMeasurePoints((current) => [...current, [pointLngLat.lng, pointLngLat.lat]])
          suppressNextMapClickRef.current = true
        }
      }

      if (state.dragging) {
        suppressNextMapClickRef.current = true
        window.setTimeout(() => {
          suppressNextMapClickRef.current = false
        }, 0)
      } else if (suppressNextMapClickRef.current) {
        window.setTimeout(() => {
          suppressNextMapClickRef.current = false
        }, 0)
      }

      containerRef.current?.classList.remove('is-map-dragging')
      mapRef.current?.getCanvas().style.removeProperty('cursor')
      manualDragRef.current = null
      setInteractionHint(measureModeRef.current ? '测距模式已开启，点击地图继续加点' : '拖拽平移 · 滚轮缩放 · 点击对象查看详情')

      try {
        if (event) {
          stage.releasePointerCapture(event.pointerId)
        }
      } catch {
        // 某些浏览器会在 pointercancel 后自动释放，忽略即可。
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isMapControlTarget(event.target)) {
        return
      }
      if (!mapRef.current) {
        return
      }

      manualDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragging: false,
      }
      containerRef.current?.classList.add('is-map-dragging')
      setInteractionHint('拖拽地图中')

      try {
        stage.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture 只是增强移动过程稳定性，不支持时仍然走 window 监听。
      }
    }

    const handleDragPointerMove = (event: PointerEvent) => {
      const state = manualDragRef.current
      const map = mapRef.current
      if (!state || !map || event.pointerId !== state.pointerId) {
        return
      }

      const pointLngLat = getMapPointerLngLat(map, event.clientX, event.clientY)
      if (pointLngLat) {
        handlePointerMove(pointLngLat.lng, pointLngLat.lat)
      }

      const deltaX = event.clientX - state.lastX
      const deltaY = event.clientY - state.lastY
      const totalMove = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      if (!state.dragging && totalMove < 3) {
        return
      }

      state.dragging = true
      state.lastX = event.clientX
      state.lastY = event.clientY
      event.preventDefault()
      event.stopPropagation()
      map.panBy([-deltaX, -deltaY], { duration: 0, noMoveStart: true }, { source: 'manual-map-drag' })
    }

    stage.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('pointermove', handleDragPointerMove, { capture: true, passive: false })
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)

    return () => {
      stage.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('pointermove', handleDragPointerMove, true)
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
    }
  }, [handlePointerMove])

  useEffect(() => {
    layersRef.current = layers
  }, [layers])

  useEffect(() => {
    onSelectArtifactRef.current = onSelectArtifact
  }, [onSelectArtifact])

  useEffect(() => {
    // 地图实例初始化
    //
    // 只在组件首次挂载时创建 MapLibre 实例。
    // 当容器初始尺寸为零（CSS Grid / framer-motion 尚未完成布局）时，
    // 通过 ResizeObserver 等待容器获得尺寸后再创建。
    const target = containerRef.current
    if (!target || mapRef.current) {
      return
    }

    let disposed = false
    let sizeObserver: ResizeObserver | null = null
    let mapResizeObserver: ResizeObserver | null = null

    const tryCreateMap = () => {
      if (disposed || mapRef.current) return
      if (target.clientWidth === 0 || target.clientHeight === 0) return

      sizeObserver?.disconnect()
      sizeObserver = null

      let map: Map
      try {
        map = new maplibregl.Map({
          container: target,
          style: buildBasemapStyle(initialBasemapRef.current),
          center: [121.4737, 31.2304],
          zoom: 11.2,
          interactive: true,
          dragRotate: false,
          attributionControl: false,
        })
      } catch (error) {
        setMapError(error instanceof Error ? error.message : '当前浏览器无法创建 WebGL 地图上下文')
        setInteractionHint('当前浏览器无法创建地图渲染上下文')
        return
      }

      map.on('error', (event) => {
        const msg = event.error?.message ?? '地图资源加载失败'
        // 仅展示非阻塞警告，不切换底图（切换会调用 setStyle 清除所有图层）
        setTileWarning(msg)
      })

      map.scrollZoom.enable()
      map.dragPan.enable()
      map.doubleClickZoom.enable()
      map.boxZoom.enable()
      map.keyboard.enable()
      map.touchZoomRotate.enable()
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 132, unit: 'metric' }), 'bottom-left')

      map.on('mousemove', (event) => {
        handlePointerMove(event.lngLat.lng, event.lngLat.lat)
        if (measureModeRef.current) {
          map.getCanvas().style.cursor = 'crosshair'
          return
        }
        const features = queryRenderedArtifactFeatures(map, event.point)
        map.getCanvas().style.cursor = features.length ? 'pointer' : ''

        // 悬停气泡：停留 250ms 后显示要素摘要，移动即清除
        if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        const hoverFeature = features[0]
        if (hoverFeature) {
          hoverTimerRef.current = window.setTimeout(() => {
            if (!mapRef.current) return
            hoverPopupRef.current = new maplibregl.Popup({
              closeButton: false, closeOnClick: false, offset: 6,
              className: 'dc-map-stage__hover-popup',
            })
              .setLngLat(event.lngLat)
              .setHTML(buildHoverPopupHtml(hoverFeature))
              .addTo(mapRef.current)
          }, 250)
        }
      })
      map.on('mousedown', () => setInteractionHint('正在拖拽地图'))
      map.on('mouseup', () => setInteractionHint(measureModeRef.current ? '测距模式已开启，点击地图继续加点' : '拖拽平移 · 滚轮缩放 · 点击对象查看详情'))
      map.on('wheel', () => setInteractionHint('滚轮缩放中'))
      map.on('click', (event) => {
        if (suppressNextMapClickRef.current) {
          return
        }

        if (measureModeRef.current) {
          popupRef.current?.remove()
          popupRef.current = null
          setMeasurePoints((current) => [...current, [event.lngLat.lng, event.lngLat.lat]])
          return
        }

        const feature = queryRenderedArtifactFeatures(map, event.point)[0]
        if (!feature) {
          popupRef.current?.remove()
          popupRef.current = null
          return
        }

        const sourceId = typeof feature.layer.source === 'string' ? feature.layer.source : null
        const artifactId = sourceId?.startsWith('artifact-') ? sourceId.replace(/^artifact-/, '') : null
        if (artifactId) {
          onSelectArtifactRef.current(artifactId)
        }

        popupRef.current = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: true,
          offset: 14,
          className: 'dc-map-stage__popup',
        })
          .setLngLat(event.lngLat)
          .setHTML(buildFeaturePopupHtml(feature, layersRef.current.find((item) => item.artifact.artifactId === artifactId)?.artifact.name))
          .addTo(map)

        setInteractionHint('已选中地图对象，可继续切换图层或查看其他结果')
      })
      map.on('load', () => map.resize())

      mapResizeObserver = new ResizeObserver(() => {
        map.resize()
      })
      mapResizeObserver.observe(target)

      mapRef.current = map
      appliedBasemapKeyRef.current = initialBasemapRef.current.basemapKey
    }

    // 先立即尝试创建（大多数情况下容器已就绪）
    tryCreateMap()

    // 如果容器初始尺寸为零，通过 ResizeObserver 等待尺寸就绪后重试
    if (!mapRef.current && !disposed) {
      sizeObserver = new ResizeObserver(() => {
        tryCreateMap()
      })
      sizeObserver.observe(target)
    }

    return () => {
      disposed = true
      sizeObserver?.disconnect()
      if (mapRef.current) {
        mapResizeObserver?.disconnect()
        popupRef.current?.remove()
        popupRef.current = null
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [handlePointerMove])

  useEffect(() => {
    // 底图样式同步
    //
    // 通过 ref 记住已应用的 basemap，避免重复 setStyle 导致整张地图重建。
    const map = mapRef.current
    if (!map) {
      return
    }

    if (appliedBasemapKeyRef.current === activeBasemap.basemapKey) {
      return
    }

    appliedBasemapKeyRef.current = activeBasemap.basemapKey
    map.setStyle(buildBasemapStyle(activeBasemap))
  }, [activeBasemap])

  useEffect(() => {
    // 结果图层同步
    //
    // 输入框每次变更都会让 App 重渲染，所以这里必须只响应真正的图层事实变化。
    // 同步时优先更新已有 source 与 paint，避免全量删建造成地图闪烁和视角重置。
    const map = mapRef.current
    if (!map) {
      return
    }

    const syncLayers = () => {
      const bounds = syncArtifactLayers(map, layers, selectedArtifactId)
      const prevBounds = boundsRef.current
      boundsRef.current = bounds

      // 仅在选中 artifact 变化或 bounds 真正改变时才飞行，避免每次图层刷新都跳动
      const boundsChanged =
        bounds && !bounds.isEmpty() &&
        (!prevBounds || !prevBounds.isEmpty() &&
          (Math.abs(bounds.getWest() - prevBounds.getWest()) > 1e-7 ||
           Math.abs(bounds.getSouth() - prevBounds.getSouth()) > 1e-7 ||
           Math.abs(bounds.getEast() - prevBounds.getEast()) > 1e-7 ||
           Math.abs(bounds.getNorth() - prevBounds.getNorth()) > 1e-7))

      if (boundsChanged) {
        map.fitBounds(bounds, { padding: 120, duration: 900, maxZoom: 14 })
      }
    }

    if (map.isStyleLoaded()) {
      syncLayers()
      return
    }

    map.once('styledata', syncLayers)
  }, [layers, selectedArtifactId, activeBasemap])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    const syncMeasureLayers = () => {
      ensureMeasureLayers(map)
      const pointSource = map.getSource('measure-points') as maplibregl.GeoJSONSource | undefined
      const lineSource = map.getSource('measure-line') as maplibregl.GeoJSONSource | undefined
      if (!pointSource || !lineSource) {
        return
      }
      pointSource.setData(buildMeasurePointsCollection(measurePoints))
      lineSource.setData(buildMeasureLineCollection(measurePoints))
    }

    if (map.isStyleLoaded()) {
      syncMeasureLayers()
      return
    }

    map.once('styledata', syncMeasureLayers)
  }, [activeBasemap, measurePoints])

  const measurementLabel = formatMeasurementDistance(measurePoints)
  const pressMotion = buildPressMotion(reducedMotion)

  return (
    <m.section ref={stageRef} className="dc-map-stage relative h-[clamp(560px,68svh,780px)] overflow-hidden rounded-[28px] glass-strong" aria-label="地图画布" layout {...buildFadeUpMotion(reducedMotion, 0.06, 18)}>
      <div ref={containerRef} className="dc-map-stage__canvas" />
      <div className="dc-map-stage__wash" />

      {mapError ? (
        <m.div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-7 bg-[#f2f2f7]/95 backdrop-blur-xl text-center rounded-[28px]" role="status" layout {...buildFadeUpMotion(reducedMotion, 0.08, 12)}>
          <strong className="text-[17px] font-semibold text-[#1c1c1e]">地图无法渲染</strong>
          <p className="max-w-xs text-[14px] text-[#8e8e93]">当前浏览器不支持 WebGL。分析结果仍会保存。</p>
          <small className="text-[11px] text-[#8e8e93] font-mono break-all">{mapError}</small>
        </m.div>
      ) : tileWarning ? (
        <m.div className="absolute left-3 right-3 top-3 z-20 p-3 rounded-[18px] bg-[#ff950010] border border-[#ff950020] text-[#ff9500] text-[13px] font-medium backdrop-blur-xl" role="status" layout {...buildFadeUpMotion(reducedMotion, 0.08, 12)}>
          <span>{tileWarning}</span>
        </m.div>
      ) : null}

      <m.div className="dc-map-stage__hud" layout {...buildFadeMotion(reducedMotion, 0.08)}>
        <div className="dc-map-stage__status-copy">
          <span>{selectedArtifactName ?? '等待结果'}</span>
          <small>{measureMode ? measurementLabel : interactionHint}</small>
        </div>
        <strong>{cursor}</strong>
      </m.div>

      <AnimatePresence initial={false}>
      {layers.length && showLayerLegend ? (
        <m.div className="dc-map-stage__legend" aria-label="地图图层摘要" layout {...buildFadeUpMotion(reducedMotion, 0.14, 10)}>
          {layers.map(({ artifact, visible, featureCount }, idx) => {
            const color = artifact.artifactId === selectedArtifactId ? '#00687a' : ['#00a3bf', '#d48136', '#5b8def', '#4c956c'][idx % 4]
            return (
              <m.button
                key={artifact.artifactId}
                type="button"
                className={`dc-map-stage__legend-item${
                  artifact.artifactId === selectedArtifactId ? ' dc-map-stage__legend-item--active' : ''
                }`}
                onClick={() => onSelectArtifact(artifact.artifactId)}
                {...pressMotion}
              >
                <span className="dc-map-stage__legend-dot" style={{ background: color }} aria-hidden="true" />
                <strong>{artifact.name}</strong>
                <span className="dc-map-stage__legend-count">{featureCount}</span>
                {!visible ? <em>隐藏</em> : null}
              </m.button>
            )
          })}
        </m.div>
      ) : null}
      </AnimatePresence>

      <m.div className="dc-map-stage__controls" layout {...buildFadeUpMotion(reducedMotion, 0.16, 8)}>
        <div className="dc-map-stage__zoom">
          <m.button type="button" onClick={() => mapRef.current?.zoomIn()} aria-label="放大地图" disabled={Boolean(mapError)} {...pressMotion}>
            <AppIcon name="add" size={18} />
          </m.button>
          <div className="dc-map-stage__zoom-divider" />
          <m.button type="button" onClick={() => mapRef.current?.zoomOut()} aria-label="缩小地图" disabled={Boolean(mapError)} {...pressMotion}>
            <AppIcon name="remove" size={18} />
          </m.button>
        </div>
        <m.button type="button" className={`dc-map-stage__icon${measureMode ? ' dc-map-stage__icon--active' : ''}`} onClick={toggleMeasureMode} aria-label={measureMode ? '结束测距' : '开启测距'} disabled={Boolean(mapError)} {...pressMotion}>
          <Ruler size={18} />
        </m.button>
        <m.button type="button" className={`dc-map-stage__icon${showLayerLegend ? ' dc-map-stage__icon--active' : ''}`} onClick={() => setShowLayerLegend((current) => !current)} aria-label={showLayerLegend ? '隐藏图层摘要' : '显示图层摘要'} disabled={!layers.length} title={showLayerLegend ? '隐藏图层' : '显示图层'} {...pressMotion}>
          <AppIcon name="layers" size={18} />
        </m.button>
        <m.button type="button" className="dc-map-stage__icon" onClick={cycleBasemap} aria-label="切换底图" title={activeBasemap.name} {...pressMotion}>
          <AppIcon name="deployed_code" size={18} />
        </m.button>
        <m.button type="button" className="dc-map-stage__icon" onClick={focusSelection} aria-label="定位到当前结果" disabled={Boolean(mapError)} {...pressMotion}>
          <AppIcon name="my_location" size={18} />
        </m.button>
      </m.div>
    </m.section>
  )
}

const FALLBACK_BASEMAP: BasemapDescriptor = {
  basemapKey: 'osm',
  name: 'OpenStreetMap',
  provider: 'osm',
  kind: 'vector',
  attribution: '&copy; OpenStreetMap Contributors',
  tileUrls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  labelTileUrls: [],
  available: true,
  isDefault: true,
}

function buildBasemapStyle(basemap?: BasemapDescriptor): StyleSpecification {
  const sources: StyleSpecification['sources'] = {}
  const layers: StyleSpecification['layers'] = []

  if (basemap) {
    sources.basemap = {
      type: 'raster',
      tiles: basemap.tileUrls,
      tileSize: 256,
      attribution: basemap.attribution,
    }
    layers.push({
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: { 'raster-opacity': 0.66 },
    })

    if (basemap.labelTileUrls.length) {
      sources.labels = {
        type: 'raster',
        tiles: basemap.labelTileUrls,
        tileSize: 256,
        attribution: basemap.attribution,
      }
      layers.push({
        id: 'labels',
        type: 'raster',
        source: 'labels',
        paint: { 'raster-opacity': 0.78 },
      })
    }
  }

  return {
    version: 8,
    sources,
    layers,
  }
}

function isMapControlTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(
    target.closest(
      'button,a,input,textarea,select,[role="button"],.dc-map-stage__controls,.dc-map-stage__legend-item,.maplibregl-popup',
    ),
  )
}

function getMapPointerLngLat(map: Map, clientX: number, clientY: number) {
  const rect = map.getCanvasContainer().getBoundingClientRect()
  const x = clientX - rect.left
  const y = clientY - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    return null
  }
  return map.unproject([x, y])
}

function syncArtifactLayers(
  map: Map,
  layers: MapCanvasProps['layers'],
  selectedArtifactId?: string,
) {
  const activeSourceIds = new Set(layers.map(({ artifact }) => `artifact-${artifact.artifactId}`))
  removeStaleArtifactLayers(map, activeSourceIds)

  const bounds = new LngLatBounds()
  let hasBounds = false

  layers.forEach((layer, index) => {
    const { artifact, data, visible, opacity } = layer
    const sourceId = `artifact-${artifact.artifactId}`
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined
    if (source) {
      source.setData(data)
    } else {
      map.addSource(sourceId, {
        type: 'geojson',
        data,
      })
    }

    if (data.features.length) {
      extendBounds(bounds, data)
      hasBounds = true
    }

    syncArtifactLayerSet({
      map,
      layer,
      sourceId,
      color: artifact.artifactId === selectedArtifactId ? '#00687a' : ['#00a3bf', '#d48136', '#5b8def', '#4c956c'][index % 4],
      selected: artifact.artifactId === selectedArtifactId,
      visible,
      opacity,
    })
  })

  return hasBounds ? bounds : null
}

function removeStaleArtifactLayers(map: Map, activeSourceIds: Set<string>) {
  const style = map.getStyle()
  style.layers
    ?.filter((layer) => {
      const sourceId = 'source' in layer ? String(layer.source) : ''
      return layer.id.startsWith('artifact-') && !activeSourceIds.has(sourceId)
    })
    .forEach((layer) => {
      if (map.getLayer(layer.id)) {
        map.removeLayer(layer.id)
      }
    })

  Object.keys(style.sources)
    .filter((sourceId) => sourceId.startsWith('artifact-') && !activeSourceIds.has(sourceId))
    .forEach((sourceId) => {
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId)
      }
    })
}

function syncArtifactLayerSet({
  map,
  layer,
  sourceId,
  color,
  selected,
  visible,
  opacity,
}: {
  map: Map
  layer: MapCanvasProps['layers'][number]
  sourceId: string
  color: string
  selected: boolean
  visible: boolean
  opacity: number
}) {
  const geometryTypes = collectGeometryTypes(layer.data)
  const visibility = visible ? 'visible' : 'none'

  syncMapLayer(map, {
    id: `${sourceId}-fill`,
    type: 'fill',
    sourceId,
    enabled: geometryTypes.has('Polygon') || geometryTypes.has('MultiPolygon'),
    visibility,
    paint: {
      'fill-color': color,
      'fill-opacity': (selected ? 0.24 : 0.16) * opacity,
    },
  })
  syncMapLayer(map, {
    id: `${sourceId}-outline`,
    type: 'line',
    sourceId,
    enabled: geometryTypes.has('Polygon') || geometryTypes.has('MultiPolygon'),
    visibility,
    paint: {
      'line-color': color,
      'line-width': selected ? 3 : 2,
      'line-opacity': 0.85 * opacity,
    },
  })
  syncMapLayer(map, {
    id: `${sourceId}-path`,
    type: 'line',
    sourceId,
    enabled: geometryTypes.has('LineString') || geometryTypes.has('MultiLineString'),
    visibility,
    paint: {
      'line-color': color,
      'line-width': selected ? 4 : 2.4,
      'line-opacity': 0.92 * opacity,
    },
  })
  syncMapLayer(map, {
    id: `${sourceId}-point`,
    type: 'circle',
    sourceId,
    enabled: geometryTypes.has('Point') || geometryTypes.has('MultiPoint'),
    visibility,
    paint: {
      'circle-radius': selected ? 8 : 6,
      'circle-color': color,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': opacity,
    },
  })
}

function syncMapLayer(
  map: Map,
  {
    id,
    type,
    sourceId,
    enabled,
    visibility,
    paint,
  }: {
    id: string
    type: 'fill' | 'line' | 'circle'
    sourceId: string
    enabled: boolean
    visibility: 'visible' | 'none'
    paint: Record<string, unknown>
  },
) {
  if (!enabled) {
    if (map.getLayer(id)) {
      map.removeLayer(id)
    }
    return
  }

  if (!map.getLayer(id)) {
    map.addLayer({
      id,
      type,
      source: sourceId,
      paint,
      layout: { visibility },
    } as Parameters<Map['addLayer']>[0])
    return
  }

  map.setLayoutProperty(id, 'visibility', visibility)
  Object.entries(paint).forEach(([property, value]) => {
    map.setPaintProperty(id, property, value)
  })
}

function collectGeometryTypes(collection: GeoJSON.FeatureCollection) {
  const types = new Set<string>()
  collection.features.forEach((feature) => {
    if (feature.geometry?.type) {
      types.add(feature.geometry.type)
    }
  })
  return types
}

function extendBounds(bounds: LngLatBounds, collection: GeoJSON.FeatureCollection) {
  collection.features.forEach((feature) => {
    const geometry = feature.geometry
    if (!geometry) {
      return
    }
    appendGeometry(bounds, geometry)
  })
}

function boundsFromCollection(collection?: GeoJSON.FeatureCollection) {
  if (!collection?.features.length) {
    return null
  }
  const bounds = new LngLatBounds()
  extendBounds(bounds, collection)
  return bounds.isEmpty() ? null : bounds
}

function appendGeometry(bounds: LngLatBounds, geometry: GeoJSON.Geometry) {
  if (geometry.type === 'GeometryCollection') {
    geometry.geometries.forEach((child) => appendGeometry(bounds, child))
    return
  }
  appendCoordinates(bounds, geometry.coordinates)
}

function appendCoordinates(bounds: LngLatBounds, coordinates: unknown) {
  if (!Array.isArray(coordinates)) {
    return
  }
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    bounds.extend([coordinates[0], coordinates[1]])
    return
  }
  coordinates.forEach((child) => appendCoordinates(bounds, child))
}

function queryRenderedArtifactFeatures(map: Map, point: maplibregl.PointLike) {
  const layerIds =
    map
      .getStyle()
      .layers?.filter((layer) => layer.id.startsWith('artifact-'))
      .map((layer) => layer.id) ?? []
  if (!layerIds.length) {
    return []
  }
  return map.queryRenderedFeatures(point, { layers: layerIds })
}

function buildHoverPopupHtml(feature: maplibregl.MapGeoJSONFeature) {
  const props = (feature.properties as Record<string, unknown>) ?? {}
  const name = props.name ?? props.Name ?? props.NAME ?? props.title ?? props.label ?? ''
  const category = props.category ?? props.type ?? props.kind ?? props.amenity ?? ''
  const parts: string[] = []
  if (name) parts.push(`<strong>${escapeHtml(String(name))}</strong>`)
  if (category) parts.push(`<span class="dc-hover-category">${escapeHtml(String(category))}</span>`)
  if (!parts.length) {
    const first = Object.entries(props).find(([, v]) => v != null && String(v).trim())
    if (first) parts.push(`<span>${escapeHtml(String(first[1]))}</span>`)
  }
  return `<div class="dc-hover-popup">${parts.join('')}</div>`
}

function buildFeaturePopupHtml(feature: maplibregl.MapGeoJSONFeature, layerName?: string) {
  const props = (feature.properties as Record<string, unknown>) ?? {}
  const entries = Object.entries(props)
    .filter(([, value]) => value != null && String(value).trim())
    .slice(0, 10)
  const priorityKeys = ['name', 'Name', 'NAME', 'title', 'category', 'type', 'amenity', 'addr:street', 'addr:city']
  entries.sort(([a], [b]) => {
    const ai = priorityKeys.indexOf(a); const bi = priorityKeys.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return 0
  })
  const rows = entries.length
    ? entries.map(([key, rawValue]) => {
        const value = formatPopupValue(rawValue)
        return `<div><span>${escapeHtml(key)}</span><strong>${value}</strong></div>`
      }).join('')
    : '<div><span>属性</span><strong>当前对象没有可展示字段</strong></div>'
  return `
    <div class="dc-map-popup">
      <h4>${escapeHtml(layerName ?? '地图对象')}</h4>
      ${rows}
    </div>
  `
}

function formatPopupValue(value: unknown) {
  if (value == null) return '<em class="dc-null">未设置</em>'
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const s = String(value).trim()
  if (/^https?:\/\/\S+$/i.test(s)) return `<a href="${escapeHtml(s)}" target="_blank" rel="noopener">${escapeHtml(new URL(s).hostname)}</a>`
  return escapeHtml(s)
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function ensureMeasureLayers(map: Map) {
  if (!map.getSource('measure-points')) {
    map.addSource('measure-points', {
      type: 'geojson',
      data: buildMeasurePointsCollection([]),
    })
  }
  if (!map.getSource('measure-line')) {
    map.addSource('measure-line', {
      type: 'geojson',
      data: buildMeasureLineCollection([]),
    })
  }
  if (!map.getLayer('measure-line-layer')) {
    map.addLayer({
      id: 'measure-line-layer',
      type: 'line',
      source: 'measure-line',
      paint: {
        'line-color': '#172554',
        'line-width': 3,
        'line-dasharray': [1, 1.5],
      },
    })
  }
  if (!map.getLayer('measure-point-layer')) {
    map.addLayer({
      id: 'measure-point-layer',
      type: 'circle',
      source: 'measure-points',
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#172554',
        'circle-stroke-width': 2,
      },
    })
  }
}

function buildMeasurePointsCollection(points: Array<[number, number]>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((point, index) => ({
      type: 'Feature',
      properties: { index: index + 1 },
      geometry: { type: 'Point', coordinates: point },
    })),
  }
}

function buildMeasureLineCollection(points: Array<[number, number]>): GeoJSON.FeatureCollection {
  if (points.length < 2) {
    return { type: 'FeatureCollection', features: [] }
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: points },
      },
    ],
  }
}

function formatMeasurementDistance(points: Array<[number, number]>) {
  if (!points.length) {
    return '未开始测距'
  }
  if (points.length === 1) {
    return '已落下第 1 个点'
  }
  const distance = totalDistanceMeters(points)
  return distance >= 1000 ? `当前量距 ${(distance / 1000).toFixed(2)} km` : `当前量距 ${Math.round(distance)} m`
}

function totalDistanceMeters(points: Array<[number, number]>) {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(points[index - 1], points[index])
  }
  return total
}

function haversineMeters(start: [number, number], end: [number, number]) {
  const toRad = (value: number) => (value * Math.PI) / 180
  const earthRadius = 6371000
  const dLat = toRad(end[1] - start[1])
  const dLng = toRad(end[0] - start[0])
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(start[1])) * Math.cos(toRad(end[1])) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
