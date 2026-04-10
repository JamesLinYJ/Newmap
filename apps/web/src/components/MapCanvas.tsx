import { useEffect, useEffectEvent, useRef, useState } from 'react'
import maplibregl, { LngLatBounds, Map, type StyleSpecification } from 'maplibre-gl'

import type { ArtifactRef, BasemapDescriptor } from '@geo-agent-platform/shared-types'

type GeoJsonPayload = GeoJSON.FeatureCollection

interface MapCanvasProps {
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  onSelectBasemap: (basemapKey: string) => void
  layers: Array<{ artifact: ArtifactRef; data: GeoJsonPayload }>
  selectedArtifactId?: string
  selectedArtifactName?: string
  layerCount: number
  runStatus?: string
}

export function MapCanvas({
  basemaps,
  selectedBasemapKey,
  onSelectBasemap,
  layers,
  selectedArtifactId,
  selectedArtifactName,
  layerCount,
  runStatus,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const [cursor, setCursor] = useState('114.0579, 22.5431')
  const activeBasemap =
    basemaps.find((item) => item.basemapKey === selectedBasemapKey) ??
    basemaps.find((item) => item.isDefault) ??
    basemaps[0] ??
    FALLBACK_BASEMAP
  const visibleArtifactCount = layers.filter((item) => item.data.features.length).length

  const handlePointerMove = useEffectEvent((lng: number, lat: number) => {
    setCursor(`${lng.toFixed(4)}, ${lat.toFixed(4)}`)
  })

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildBasemapStyle(activeBasemap),
      center: [13.4049, 52.52],
      zoom: 3.2,
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    map.on('mousemove', (event) => handlePointerMove(event.lngLat.lng, event.lngLat.lat))
    map.on('load', () => {
      map.resize()
    })

    mapRef.current = map

    const resizeObserver = new ResizeObserver(() => {
      map.resize()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [activeBasemap, handlePointerMove])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !activeBasemap) {
      return
    }

    map.setStyle(buildBasemapStyle(activeBasemap))
  }, [activeBasemap])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !activeBasemap) {
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
        const lineId = `${sourceId}-line`
        const strokeId = `${sourceId}-stroke`
        const circleId = `${sourceId}-circle`
        const color =
          artifact.artifactId === selectedArtifactId
            ? '#ca8a04'
            : ['#2563eb', '#0f766e', '#1d4ed8', '#7c3aed'][index % 4]

        map.addSource(sourceId, {
          type: 'geojson',
          data: data,
        })

        const geometryTypes = collectGeometryTypes(data)
        if (geometryTypes.has('Polygon') || geometryTypes.has('MultiPolygon')) {
          map.addLayer({
            id: fillId,
            type: 'fill',
            source: sourceId,
            paint: {
              'fill-color': color,
              'fill-opacity': artifact.artifactId === selectedArtifactId ? 0.24 : 0.12,
            },
          })
          map.addLayer({
            id: lineId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': color,
              'line-width': artifact.artifactId === selectedArtifactId ? 3 : 2,
            },
          })
        }

        if (geometryTypes.has('LineString') || geometryTypes.has('MultiLineString')) {
          map.addLayer({
            id: strokeId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': color,
              'line-width': artifact.artifactId === selectedArtifactId ? 4 : 2.5,
              'line-opacity': artifact.artifactId === selectedArtifactId ? 0.95 : 0.75,
            },
          })
        }

        if (geometryTypes.has('Point') || geometryTypes.has('MultiPoint')) {
          map.addLayer({
            id: circleId,
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
        hasBounds = hasBounds || Boolean(data.features?.length)
      })

      if (hasBounds && !bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 64, duration: 800, maxZoom: 13 })
      }
    }

    if (map.isStyleLoaded()) {
      syncLayers()
      return
    }

    map.once('styledata', syncLayers)
  }, [activeBasemap, layers, selectedArtifactId])

  return (
    <section className="map-shell" aria-label="地图主视图">
      <div ref={containerRef} className="map-shell__canvas" />
      <div className="map-shell__hud">
        <div className="map-shell__chip">
          <span>当前查看</span>
          <strong>{selectedArtifactName ?? '等待分析结果'}</strong>
        </div>
        <div className="map-shell__chip">
          <span>已上图结果</span>
          <strong>{visibleArtifactCount || layerCount}</strong>
        </div>
        <div className="map-shell__chip">
          <span>当前状态</span>
          <strong>{formatRunStatus(runStatus)}</strong>
        </div>
      </div>
      <div className="map-shell__overlay">
        <div className="map-shell__legend">
          <span>底图</span>
          <strong>{formatBasemapName(activeBasemap)}</strong>
        </div>
        <div className="map-shell__legend">
          <span>坐标</span>
          <strong>{cursor}</strong>
        </div>
      </div>
      {basemaps.length ? (
        <div className="map-shell__basemap-switch" aria-label="底图切换">
          {basemaps.map((basemap) => (
            <button
              key={basemap.basemapKey}
            className={`map-shell__basemap-button${
                basemap.basemapKey === selectedBasemapKey ? ' map-shell__basemap-button--active' : ''
              }`}
              type="button"
              onClick={() => onSelectBasemap(basemap.basemapKey)}
            >
              {formatBasemapName(basemap)}
            </button>
          ))}
        </div>
      ) : null}
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

function formatRunStatus(runStatus?: string) {
  if (runStatus === 'running') {
    return '正在分析'
  }
  if (runStatus === 'completed') {
    return '已完成'
  }
  if (runStatus === 'clarification_needed') {
    return '等待确认'
  }
  if (runStatus === 'failed') {
    return '未完成'
  }
  return '等待开始'
}

function formatBasemapName(basemap?: BasemapDescriptor) {
  if (!basemap) {
    return '未选择'
  }
  if (basemap.kind === 'imagery') {
    return '影像地图'
  }
  if (basemap.provider === 'osm') {
    return '开源地图'
  }
  return '标准地图'
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
    })

    if (basemap.labelTileUrls.length) {
      sources.basemap_labels = {
        type: 'raster',
        tiles: basemap.labelTileUrls,
        tileSize: 256,
        attribution: basemap.attribution,
      }
      layers.push({
        id: 'basemap-labels',
        type: 'raster',
        source: 'basemap_labels',
      })
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

function collectGeometryTypes(payload: GeoJsonPayload) {
  const geometryTypes = new Set<string>()
  payload.features?.forEach((feature) => {
    if (feature.geometry?.type) {
      geometryTypes.add(feature.geometry.type)
    }
  })
  return geometryTypes
}

function extendBounds(bounds: LngLatBounds, payload: GeoJsonPayload) {
  payload.features?.forEach((feature) => {
    visitCoordinates(feature.geometry, (lng, lat) => bounds.extend([lng, lat]))
  })
}

function visitCoordinates(
  geometry: GeoJSON.Geometry | null,
  visitor: (lng: number, lat: number) => void,
) {
  if (!geometry) {
    return
  }

  const walk = (value: unknown) => {
    if (geometry.type === 'GeometryCollection' && 'geometries' in geometry) {
      geometry.geometries.forEach((item) => visitCoordinates(item, visitor))
      return
    }
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
      visitor(value[0], value[1])
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
    }
  }

  if ('coordinates' in geometry) {
    walk(geometry.coordinates)
  }
}
