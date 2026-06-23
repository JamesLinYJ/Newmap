// +-------------------------------------------------------------------------
//
//   地理智能平台 - 空间分析工具（Turf.js）
//
//   文件:       spatialAnalysis.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 每个操作先把 GeoJSON 收窄到 Turf 真正支持的几何契约。
// 错误类型、空结果和未知单位必须显式失败，不能返回伪成功 payload。

import {
  along,
  area,
  bbox,
  bboxPolygon,
  bearing,
  booleanContains,
  booleanIntersects,
  booleanWithin,
  buffer,
  centroid,
  destination,
  difference,
  distance,
  greatCircle,
  intersect,
  length,
  midpoint,
  nearestPoint,
  pointsWithinPolygon,
  union,
} from '@turf/turf'
import type { Feature, LineString } from 'geojson'
import type { ToolDef } from '../../framework/types.js'
import {
  combinePolygonFeatures,
  parseGeoJsonEntity,
  requireLineFeature,
  requirePointCollection,
  requirePointFeature,
  requirePolygonCollection,
  requirePolygonFeature,
  requireSingleFeature,
} from '../../gis/geojson.js'
import { makeId } from '../../utils/ids.js'

type TurfUnits = 'kilometers' | 'meters' | 'miles'
const UNITS = new Set<TurfUnits>(['kilometers', 'meters', 'miles'])

export function createSpatialAnalysisTool(): ToolDef {
  return {
    name: 'spatial_analysis',
    label: '空间分析',
    description: '执行确定性 GIS 空间分析。支持面积、距离、缓冲、相交、合并、路径插值、方位角等操作。',
    group: '空间分析',
    tags: ['turf', 'analysis', 'gis'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'area', 'length', 'distance', 'buffer', 'centroid', 'bbox',
            'intersects', 'contains', 'within', 'intersect', 'union', 'difference',
            'along', 'bearing', 'destination', 'midpoint', 'nearest',
            'points_within_polygon', 'great_circle',
          ],
          description: '空间分析操作类型',
        },
        sourceGeojson: { type: 'object', additionalProperties: true, description: '主 GeoJSON 输入（Feature/FeatureCollection/Geometry）', 'x-source': 'json' },
        targetGeojson: { type: 'object', additionalProperties: true, description: '第二 GeoJSON 输入', 'x-source': 'json' },
        radius: { type: 'number', minimum: 0, description: '缓冲半径' },
        bearing: { type: 'number', description: '目标方位角（度）' },
        units: { type: 'string', enum: [...UNITS], default: 'kilometers' },
        distance: { type: 'number', minimum: 0, description: '沿路径或目标距离' },
        steps: { type: 'integer', minimum: 2, maximum: 1000, default: 100 },
      },
      required: ['operation', 'sourceGeojson'],
    },
    async handler(args) {
      const operation = requiredText(args, 'operation')
      const source = parseGeoJsonEntity(args.sourceGeojson, 'sourceGeojson')
      const target = args.targetGeojson === undefined ? null : parseGeoJsonEntity(args.targetGeojson, 'targetGeojson')
      const units = parseUnits(args.units)

      switch (operation) {
        case 'area': {
          const areaSqm = area(source)
          return success('面积计算完成', { operation, areaSqm, areaSqKm: areaSqm / 1_000_000 })
        }
        case 'length': {
          const result = length(requireLineFeature(source, 'sourceGeojson'), { units })
          return success('长度计算完成', { operation, length: result, units })
        }
        case 'distance': {
          const result = distance(requirePointFeature(source, 'sourceGeojson'), requireTargetPoint(target), { units })
          return success('距离计算完成', { operation, distance: result, units })
        }
        case 'buffer': {
          const radius = finiteNumber(args.radius, 'radius', 1)
          const result = source.type === 'FeatureCollection'
            ? buffer(source, radius, { units })
            : buffer(source, radius, { units })
          if (!result) throw new Error('buffer 未生成有效几何')
          return success(`缓冲半径 ${radius} ${units}`, { operation, radius, units, result })
        }
        case 'centroid': {
          const result = centroid(source)
          return success('质心计算完成', { operation, point: result.geometry.coordinates, result })
        }
        case 'bbox': {
          const bounds = bbox(source)
          return success('边界框计算完成', { operation, bbox: bounds, result: bboxPolygon(bounds) })
        }
        case 'intersects':
          return relationship(operation, source, target, booleanIntersects, '两个要素相交', '两个要素不相交')
        case 'contains':
          return relationship(operation, source, target, booleanContains, '要素 A 包含要素 B', '要素 A 不包含要素 B')
        case 'within':
          return relationship(operation, source, target, booleanWithin, '要素 A 在要素 B 内', '要素 A 不在要素 B 内')
        case 'intersect': {
          const result = intersect(polygonPair(source, target))
          return success(result ? '求交完成' : '两个要素无交集', { operation, result, hasIntersection: Boolean(result) })
        }
        case 'union':
          return success('合并完成', { operation, result: union(polygonPair(source, target)) })
        case 'difference':
          return success('差集完成', { operation, result: difference(polygonPair(source, target)) })
        case 'along': {
          const line = requireLineFeature(source, 'sourceGeojson', false) as Feature<LineString>
          const alongDistance = finiteNumber(args.distance, 'distance', 0)
          const result = along(line, alongDistance, { units })
          return success(`沿路径 ${alongDistance} ${units} 处插值`, {
            operation, distance: alongDistance, units, point: result.geometry.coordinates, result,
          })
        }
        case 'bearing': {
          const result = bearing(requirePointFeature(source, 'sourceGeojson'), requireTargetPoint(target))
          return success('方位角计算完成', { operation, bearingDegrees: result })
        }
        case 'destination': {
          const travelDistance = finiteNumber(args.distance, 'distance', 1)
          const heading = finiteNumber(args.bearing, 'bearing', 0)
          const result = destination(requirePointFeature(source, 'sourceGeojson'), travelDistance, heading, { units })
          return success(`目标点 ${travelDistance} ${units} 方位 ${heading}°`, { operation, point: result.geometry.coordinates, result })
        }
        case 'midpoint': {
          const result = midpoint(requirePointFeature(source, 'sourceGeojson'), requireTargetPoint(target))
          return success('中点计算完成', { operation, point: result.geometry.coordinates, result })
        }
        case 'nearest': {
          if (!target) throw new Error('nearest 需要 targetGeojson 点集')
          const sourcePoint = requirePointFeature(source, 'sourceGeojson')
          const result = nearestPoint(sourcePoint, requirePointCollection(target, 'targetGeojson'))
          return success('最近点查找完成', {
            operation,
            point: result.geometry.coordinates,
            distance: distance(sourcePoint, result, { units }),
            units,
            result,
          })
        }
        case 'points_within_polygon': {
          if (!target) throw new Error('points_within_polygon 需要 targetGeojson 面')
          const result = pointsWithinPolygon(
            requirePointCollection(source, 'sourceGeojson'),
            requirePolygonCollection(target, 'targetGeojson'),
          )
          return success(`${result.features.length} 个点落在面内`, { operation, count: result.features.length, result })
        }
        case 'great_circle': {
          const steps = integerNumber(args.steps, 'steps', 100)
          const result = greatCircle(
            requirePointFeature(source, 'sourceGeojson').geometry.coordinates,
            requireTargetPoint(target).geometry.coordinates,
            { npoints: steps },
          )
          return success(`大圆路径 ${steps} 点`, { operation, result })
        }
        default:
          throw new Error(`不支持的空间分析操作：${operation}`)
      }
    },
  }
}

function relationship(
  operation: string,
  source: ReturnType<typeof parseGeoJsonEntity>,
  target: ReturnType<typeof parseGeoJsonEntity> | null,
  execute: (first: ReturnType<typeof requireSingleFeature>, second: ReturnType<typeof requireSingleFeature>) => boolean,
  yes: string,
  no: string,
) {
  if (!target) throw new Error(`${operation} 需要 targetGeojson`)
  const result = execute(requireSingleFeature(source, 'sourceGeojson'), requireSingleFeature(target, 'targetGeojson'))
  return success(result ? yes : no, { operation, [operation]: result })
}

function polygonPair(source: ReturnType<typeof parseGeoJsonEntity>, target: ReturnType<typeof parseGeoJsonEntity> | null) {
  if (!target) throw new Error('面运算需要 targetGeojson')
  return combinePolygonFeatures(
    requirePolygonFeature(source, 'sourceGeojson'),
    requirePolygonFeature(target, 'targetGeojson'),
  )
}

function requireTargetPoint(target: ReturnType<typeof parseGeoJsonEntity> | null) {
  if (!target) throw new Error('该操作需要 targetGeojson Point')
  return requirePointFeature(target, 'targetGeojson')
}

function parseUnits(value: unknown): TurfUnits {
  const units = value === undefined ? 'kilometers' : String(value)
  if (!UNITS.has(units as TurfUnits)) throw new Error(`不支持的单位：${units}`)
  return units as TurfUnits
}

function finiteNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`)
  return value
}

function integerNumber(value: unknown, field: string, fallback: number): number {
  const result = finiteNumber(value, field, fallback)
  if (!Number.isInteger(result)) throw new Error(`${field} 必须是整数`)
  return result
}

function requiredText(args: Record<string, unknown>, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  return value.trim()
}

function success(message: string, payload: Record<string, unknown>) {
  const resultId = makeId('result')
  return {
    message,
    payload,
    warnings: [] as string[],
    resultId,
    source: 'turf',
    provenance: { backend: 'turf', deterministic: true },
    valueRefs: buildValueRefs(payload),
  }
}

function buildValueRefs(payload: Record<string, unknown>) {
  const refs = []
  if (typeof payload.areaSqm === 'number') {
    refs.push({ refId: makeId('ref'), kind: 'area', label: '面积（m²）', value: payload.areaSqm, unit: 'm²' })
  }
  if (typeof payload.distance === 'number') {
    refs.push({ refId: makeId('ref'), kind: 'distance', label: '距离', value: payload.distance, unit: typeof payload.units === 'string' ? payload.units : 'km' })
  }
  if (Array.isArray(payload.point)) {
    refs.push({ refId: makeId('ref'), kind: 'point', label: '坐标点', value: payload.point })
  }
  if (payload.result && typeof payload.result === 'object') {
    refs.push({ refId: makeId('ref'), kind: 'geojson', label: 'GeoJSON 结果', value: payload.result })
  }
  return refs
}
