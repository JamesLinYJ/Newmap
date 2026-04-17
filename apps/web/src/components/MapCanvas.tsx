// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布组件
//
//   文件:       MapCanvas.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import maplibregl, { LngLatBounds, Map, type StyleSpecification } from 'maplibre-gl'

import type { ArtifactRef, BasemapDescriptor } from '@geo-agent-platform/shared-types'
import { AppIcon } from './AppIcon'

type GeoJsonPayload = GeoJSON.FeatureCollection

interface MapCanvasProps {
  artifactCount: number
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  runStatus?: string
  onSelectBasemap: (basemapKey: string) => void
  layers: Array<{ artifact: ArtifactRef; data: GeoJsonPayload }>
  selectedArtifactId?: string
  selectedArtifactName?: string
}

export function MapCanvas({
  artifactCount,
  basemaps,
  selectedBasemapKey,
  runStatus,
  onSelectBasemap,
  layers,
  selectedArtifactId,
  selectedArtifactName,
}: MapCanvasProps) {
  // 地图主画布
  //
  // 负责承载 MapLibre 地图实例、底图切换、结果图层渲染、自动视野定位，
  // 以及与主工作台之间的选中状态同步。
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const boundsRef = useRef<LngLatBounds | null>(null)
  const appliedBasemapKeyRef = useRef<string | null>(null)
  const [cursor, setCursor] = useState('114.0579, 22.5431')
  const activeBasemap =
    basemaps.find((item) => item.basemapKey === selectedBasemapKey) ??
    basemaps.find((item) => item.isDefault) ??
    basemaps[0] ??
    FALLBACK_BASEMAP

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

  const handlePointerMove = useCallback((lng: number, lat: number) => {
    setCursor(`${lng.toFixed(4)}, ${lat.toFixed(4)}`)
  }, [])

  useEffect(() => {
    // 地图实例初始化
    //
    // 只在组件首次挂载时创建 MapLibre 实例，并在这里接上 resize 和鼠标坐标监听。
    if (!containerRef.current || mapRef.current) {
      return
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildBasemapStyle(activeBasemap),
      center: [121.4737, 31.2304],
      zoom: 11.2,
      attributionControl: false,
    })

    map.on('mousemove', (event) => handlePointerMove(event.lngLat.lng, event.lngLat.lat))
    map.on('load', () => map.resize())

    const resizeObserver = new ResizeObserver(() => {
      map.resize()
    })
    resizeObserver.observe(containerRef.current)

    mapRef.current = map
    appliedBasemapKeyRef.current = activeBasemap.basemapKey

    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [activeBasemap, handlePointerMove])

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
    // 每次 artifacts 或选中态变化时，先清理旧 source/layer，再按当前结果重建，
    // 并同步刷新总 bounds，保证地图展示与右侧结果列表一致。
    const map = mapRef.current
    if (!map) {
      return
    }

    const syncLayers = () => {
      removeArtifactLayers(map)
      const bounds = new LngLatBounds()
      let hasBounds = false

      layers.forEach(({ artifact, data }, index) => {
        if (!data.features.length) {
          return
        }

        const sourceId = `artifact-${artifact.artifactId}`
        const fillId = `${sourceId}-fill`
        const outlineId = `${sourceId}-outline`
        const pathId = `${sourceId}-path`
        const pointId = `${sourceId}-point`
        const color =
          artifact.artifactId === selectedArtifactId
            ? '#00687a'
            : ['#00a3bf', '#d48136', '#5b8def', '#4c956c'][index % 4]

        map.addSource(sourceId, {
          type: 'geojson',
          data,
        })

        const geometryTypes = collectGeometryTypes(data)

        if (geometryTypes.has('Polygon') || geometryTypes.has('MultiPolygon')) {
          map.addLayer({
            id: fillId,
            type: 'fill',
            source: sourceId,
            paint: {
              'fill-color': color,
              'fill-opacity': artifact.artifactId === selectedArtifactId ? 0.24 : 0.16,
            },
          })
          map.addLayer({
            id: outlineId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': color,
              'line-width': artifact.artifactId === selectedArtifactId ? 3 : 2,
              'line-opacity': 0.85,
            },
          })
        }

        if (geometryTypes.has('LineString') || geometryTypes.has('MultiLineString')) {
          map.addLayer({
            id: pathId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': color,
              'line-width': artifact.artifactId === selectedArtifactId ? 4 : 2.4,
              'line-opacity': 0.92,
            },
          })
        }

        if (geometryTypes.has('Point') || geometryTypes.has('MultiPoint')) {
          map.addLayer({
            id: pointId,
            type: 'circle',
            source: sourceId,
            paint: {
              'circle-radius': artifact.artifactId === selectedArtifactId ? 8 : 6,
              'circle-color': color,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          })
        }

        extendBounds(bounds, data)
        hasBounds = true
      })

      boundsRef.current = hasBounds ? bounds : null

      if (hasBounds && !bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 120, duration: 900, maxZoom: 14 })
      }
    }

    if (map.isStyleLoaded()) {
      syncLayers()
      return
    }

    map.once('styledata', syncLayers)
  }, [layers, selectedArtifactId, activeBasemap])

  return (
    <section className="dc-map-stage" aria-label="地图画布">
      <div ref={containerRef} className="dc-map-stage__canvas" />
      <div className="dc-map-stage__wash" />

      <div className="dc-map-stage__status">
        <span>{selectedArtifactName ?? '等待结果'}</span>
        <strong>{cursor}</strong>
      </div>

      <div className="dc-map-stage__summary" aria-label="地图工作台状态">
        <article className="dc-map-stage__summary-card">
          <span>运行</span>
          <strong>{formatMapRunStatus(runStatus)}</strong>
          <p>{artifactCount ? `地图中已载入 ${artifactCount} 个结果图层。` : '提交分析后会把结果直接绘制到这里。'}</p>
        </article>
        <article className="dc-map-stage__summary-card">
          <span>底图</span>
          <strong>{activeBasemap.name}</strong>
          <p>{layers.length ? `${layers.length} 组空间结果正在可视化。` : '当前没有活动结果图层。'}</p>
        </article>
      </div>

      {layers.length ? (
        <div className="dc-map-stage__legend" aria-label="地图图层摘要">
          {layers.slice(0, 4).map(({ artifact }) => (
            <div
              key={artifact.artifactId}
              className={`dc-map-stage__legend-item${
                artifact.artifactId === selectedArtifactId ? ' dc-map-stage__legend-item--active' : ''
              }`}
            >
              <span className="dc-map-stage__legend-dot" aria-hidden="true" />
              <strong>{artifact.name}</strong>
            </div>
          ))}
        </div>
      ) : null}

      <div className="dc-map-stage__controls">
        <div className="dc-map-stage__zoom">
          <button type="button" onClick={() => mapRef.current?.zoomIn()} aria-label="放大地图">
            <AppIcon name="add" size={18} />
          </button>
          <div className="dc-map-stage__zoom-divider" />
          <button type="button" onClick={() => mapRef.current?.zoomOut()} aria-label="缩小地图">
            <AppIcon name="remove" size={18} />
          </button>
        </div>
        <button type="button" className="dc-map-stage__icon" onClick={cycleBasemap} aria-label="切换底图">
          <AppIcon name="layers" size={18} />
        </button>
        <button type="button" className="dc-map-stage__icon" onClick={focusSelection} aria-label="定位到当前结果">
          <AppIcon name="my_location" size={18} />
        </button>
      </div>

      <div className="dc-map-stage__basemap-chip">
        <button type="button" className="dc-map-stage__basemap dc-map-stage__basemap--active" onClick={cycleBasemap}>
          {formatBasemapName(activeBasemap)}
        </button>
      </div>
    </section>
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

function formatBasemapName(basemap?: BasemapDescriptor) {
  if (!basemap) {
    return '标准地图'
  }
  if (basemap.provider === 'osm') {
    return '开源地图'
  }
  if (basemap.kind === 'imagery') {
    return '影像地图'
  }
  return '标准地图'
}

function formatMapRunStatus(status?: string) {
  if (status === 'completed') {
    return '分析完成'
  }
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'running') {
    return '执行中'
  }
  if (status === 'failed') {
    return '运行失败'
  }
  return '等待开始'
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
    layers.push({ id: 'basemap', type: 'raster', source: 'basemap' })

    if (basemap.labelTileUrls.length) {
      sources.labels = {
        type: 'raster',
        tiles: basemap.labelTileUrls,
        tileSize: 256,
        attribution: basemap.attribution,
      }
      layers.push({ id: 'labels', type: 'raster', source: 'labels' })
    }
  }

  return {
    version: 8,
    sources,
    layers,
  }
}

function removeArtifactLayers(map: Map) {
  const style = map.getStyle()
  style.layers
    ?.filter((layer) => layer.id.startsWith('artifact-'))
    .forEach((layer) => {
      if (map.getLayer(layer.id)) {
        map.removeLayer(layer.id)
      }
    })

  Object.keys(style.sources)
    .filter((sourceId) => sourceId.startsWith('artifact-'))
    .forEach((sourceId) => {
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId)
      }
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
