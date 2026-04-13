import { type PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react'
import maplibregl, { LngLatBounds, Map, type StyleSpecification } from 'maplibre-gl'

import type { ArtifactRef, BasemapDescriptor } from '@geo-agent-platform/shared-types'

type GeoJsonPayload = GeoJSON.FeatureCollection

interface MapCanvasProps extends PropsWithChildren {
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  onSelectBasemap: (basemapKey: string) => void
  layers: Array<{ artifact: ArtifactRef; data: GeoJsonPayload }>
  selectedArtifactId?: string
  selectedArtifactName?: string
}

export function MapCanvas({
  basemaps,
  selectedBasemapKey,
  onSelectBasemap,
  layers,
  selectedArtifactId,
  selectedArtifactName,
  children,
}: MapCanvasProps) {
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
    if (!basemaps.length) {
      return
    }
    const currentIndex = basemaps.findIndex((item) => item.basemapKey === selectedBasemapKey)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % basemaps.length : 0
    onSelectBasemap(basemaps[nextIndex]?.basemapKey ?? basemaps[0].basemapKey)
  }, [basemaps, onSelectBasemap, selectedBasemapKey])

  const focusSelection = useCallback(() => {
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

      <div className="dc-map-stage__overlay">{children}</div>

      <div className="dc-map-stage__status">
        <span>{selectedArtifactName ?? '等待结果'}</span>
        <strong>{cursor}</strong>
      </div>

      <div className="dc-map-stage__controls">
        <div className="dc-map-stage__zoom">
          <button type="button" onClick={() => mapRef.current?.zoomIn()} aria-label="放大地图">
            <span className="material-symbols-outlined">add</span>
          </button>
          <div className="dc-map-stage__zoom-divider" />
          <button type="button" onClick={() => mapRef.current?.zoomOut()} aria-label="缩小地图">
            <span className="material-symbols-outlined">remove</span>
          </button>
        </div>
        <button type="button" className="dc-map-stage__icon" onClick={cycleBasemap} aria-label="切换底图">
          <span className="material-symbols-outlined">layers</span>
        </button>
        <button type="button" className="dc-map-stage__icon" onClick={focusSelection} aria-label="定位到当前结果">
          <span className="material-symbols-outlined">my_location</span>
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
