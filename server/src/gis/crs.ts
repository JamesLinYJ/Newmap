// +-------------------------------------------------------------------------
//
//   地理智能平台 - CRS 与投影工具
//
//   文件:       crs.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import proj4 from 'proj4'

export interface GeoJsonGeometry {
  type: string
  coordinates: unknown
}

// UTM 局部米制 EPSG
export function chooseLocalMetricEpsg(longitude: number, latitude: number): number {
  const zone = Math.floor((longitude + 180) / 6) + 1
  const north = latitude >= 0
  return (north ? 32600 : 32700) + zone
}

// 重投影单个几何
export function transformGeometry(geometry: GeoJsonGeometry, srcEpsg: number, dstEpsg: number): GeoJsonGeometry {
  if (srcEpsg === dstEpsg) return geometry
  const fromProj = `EPSG:${srcEpsg}`
  const toProj = `EPSG:${dstEpsg}`

  function convert(coords: unknown): unknown {
    if (typeof coords === 'number') return coords
    if (!Array.isArray(coords)) return coords
    if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      return proj4(fromProj, toProj, [coords[0] as number, coords[1] as number])
    }
    return coords.map(convert)
  }

  return { ...geometry, coordinates: convert(geometry.coordinates) }
}
