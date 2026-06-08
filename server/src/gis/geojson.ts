// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON 工具
//
//   文件:       geojson.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { GeoJsonGeometry } from './crs.js'

export interface GeoJsonFeature {
  type: 'Feature'
  properties: Record<string, unknown>
  geometry: GeoJsonGeometry
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

export function ensureFeatureCollection(data: unknown): GeoJsonFeatureCollection {
  if (typeof data !== 'object' || data === null) {
    return { type: 'FeatureCollection', features: [] }
  }
  const obj = data as Record<string, unknown>
  if (obj.type === 'FeatureCollection') return data as GeoJsonFeatureCollection
  if (obj.type === 'Feature') return { type: 'FeatureCollection', features: [data as GeoJsonFeature] }
  if (obj.type === 'GeometryCollection' || obj.type?.toString().startsWith('Multi')) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: data as GeoJsonGeometry }] }
  }
  return { type: 'FeatureCollection', features: [] }
}
