import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Point, Polygon, MultiPolygon } from 'geojson'
import type { PostGisRepository } from '../../gis/postgis.js'
import type { ToolDef } from '../../tools.js'
import { makeId } from '../../utils/ids.js'

type AnyFeature = Feature<Geometry, GeoJsonProperties>
type AnyFeatureCollection = FeatureCollection<Geometry, GeoJsonProperties>

export function createSpatialAnalysisTool(postgis: PostGisRepository): ToolDef {
  return {
    name: 'spatial_analysis',
    label: '空间分析',
    description: '对 GeoJSON 或 PostGIS 图层执行缓冲区、相交、距离、面积、质心等空间分析。',
    group: '地理',
    toolKind: 'registry',
    tags: ['geo', 'analysis'],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,

    jsonSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['buffer', 'intersect', 'distance', 'area', 'centroid'], description: '分析操作类型' },
        layerKey: { type: 'string', description: '目标图层；未提供 sourceGeojson 时从 PostGIS 读取' },
        bbox: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: '读取 layerKey 时可选的空间范围 [minLon, minLat, maxLon, maxLat]',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '读取 layerKey 时的要素上限', default: 200 },
        distanceM: { type: 'number', description: '缓冲区距离，单位米' },
        sourceGeojson: { type: 'object', description: '源 GeoJSON Feature、FeatureCollection 或 Geometry' },
        targetGeojson: { type: 'object', description: 'intersect/distance 的第二个 GeoJSON 对象' },
      },
      required: ['operation'],
    },

    async handler(args) {
      const operation = requireOperation(args.operation)
      const source = await loadSourceGeojson(args, postgis)
      const result = runOperation(operation, source, args.targetGeojson, args.distanceM)

      return {
        message: formatMessage(operation, result),
        payload: {
          operation,
          inputFeatureCount: source.features.length,
          result,
        },
        warnings: [],
        valueRefs: [{
          refId: makeId('ref'),
          kind: 'spatial_analysis',
          label: `空间分析: ${operation}`,
          value: result,
          metadata: { operation, inputFeatureCount: source.features.length },
        }],
        resultId: makeId('result'),
        source: 'turf-postgis',
      }
    },
  }
}

function runOperation(
  operation: string,
  source: AnyFeatureCollection,
  targetGeojson: unknown,
  distanceM: unknown,
): Record<string, unknown> {
  if (operation === 'area') {
    return { areaSqm: turf.area(source) }
  }

  if (operation === 'centroid') {
    return { feature: turf.centroid(source) }
  }

  if (operation === 'buffer') {
    const distance = requireDistance(distanceM)
    const feature = turf.buffer(source, distance, { units: 'meters' })
    if (!feature) throw new Error('buffer 没有生成结果')
    return { feature, distanceM: distance }
  }

  if (operation === 'distance') {
    const [left, right] = pickDistanceFeatures(source, targetGeojson)
    const leftPoint = pointForDistance(left)
    const rightPoint = pointForDistance(right)
    return {
      distanceM: turf.distance(leftPoint, rightPoint, { units: 'meters' }),
      from: leftPoint,
      to: rightPoint,
    }
  }

  if (operation === 'intersect') {
    const [left, right] = pickIntersectionFeatures(source, targetGeojson)
    const collection = turf.featureCollection([left, right]) as FeatureCollection<Polygon | MultiPolygon>
    const feature = turf.intersect(collection)
    return {
      intersects: feature !== null,
      feature,
      areaSqm: feature ? turf.area(feature) : 0,
    }
  }

  throw new Error(`不支持的空间分析操作: ${operation}`)
}

async function loadSourceGeojson(args: Record<string, unknown>, postgis: PostGisRepository): Promise<AnyFeatureCollection> {
  if (args.sourceGeojson != null) {
    return normalizeGeojson(args.sourceGeojson)
  }

  const layerKey = typeof args.layerKey === 'string' ? args.layerKey.trim() : ''
  if (!layerKey) {
    throw new Error('sourceGeojson 或 layerKey 至少需要提供一个')
  }

  const layer = await postgis.getLayer(layerKey)
  if (!layer) {
    throw new Error(`图层 '${layerKey}' 不存在或不可用`)
  }

  const rows = await postgis.queryFeatures(layerKey, parseBbox(args.bbox), parseLimit(args.limit, 200))
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      geometry: row.geometry as Geometry,
      properties: isRecord(row.properties) ? row.properties : {},
    })),
  }
}

function normalizeGeojson(value: unknown): AnyFeatureCollection {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('GeoJSON 必须是 Feature、FeatureCollection 或 Geometry object')
  }

  if (value.type === 'FeatureCollection') {
    const features = Array.isArray(value.features) ? value.features.map(normalizeFeature) : []
    if (!features.length) throw new Error('FeatureCollection 至少需要一个 feature')
    return { type: 'FeatureCollection', features }
  }

  if (value.type === 'Feature') {
    return { type: 'FeatureCollection', features: [normalizeFeature(value)] }
  }

  if (!isGeometry(value)) {
    throw new Error('GeoJSON Geometry type 不受支持')
  }

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: value,
      properties: {},
    }],
  }
}

function normalizeFeature(value: unknown): AnyFeature {
  if (!isRecord(value) || value.type !== 'Feature') {
    throw new Error('FeatureCollection.features 只能包含 Feature')
  }
  const geometry = isGeometry(value.geometry) ? value.geometry : null
  if (!geometry) throw new Error('Feature 缺少 geometry')
  return {
    type: 'Feature',
    geometry,
    properties: isRecord(value.properties) ? value.properties : {},
  }
}

function pickDistanceFeatures(source: AnyFeatureCollection, targetGeojson: unknown): [AnyFeature, AnyFeature] {
  if (targetGeojson != null) {
    return [source.features[0], normalizeGeojson(targetGeojson).features[0]]
  }
  if (source.features.length < 2) {
    throw new Error('distance 需要 sourceGeojson 至少包含两个 feature，或额外提供 targetGeojson')
  }
  return [source.features[0], source.features[1]]
}

function pickIntersectionFeatures(source: AnyFeatureCollection, targetGeojson: unknown): [Feature<Polygon | MultiPolygon>, Feature<Polygon | MultiPolygon>] {
  const pair = targetGeojson != null
    ? [source.features[0], normalizeGeojson(targetGeojson).features[0]]
    : source.features.slice(0, 2)
  if (pair.length < 2) {
    throw new Error('intersect 需要两个 Polygon/MultiPolygon feature')
  }
  return [requirePolygonFeature(pair[0]), requirePolygonFeature(pair[1])]
}

function requirePolygonFeature(feature: AnyFeature): Feature<Polygon | MultiPolygon> {
  const type = feature.geometry.type
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    throw new Error('intersect 只支持 Polygon 或 MultiPolygon')
  }
  return feature as Feature<Polygon | MultiPolygon>
}

function pointForDistance(feature: AnyFeature): Feature<Point> {
  if (feature.geometry.type === 'Point') {
    return feature as Feature<Point>
  }
  return turf.centroid(feature)
}

function requireOperation(value: unknown): string {
  const operation = typeof value === 'string' ? value.trim() : ''
  if (['buffer', 'intersect', 'distance', 'area', 'centroid'].includes(operation)) {
    return operation
  }
  throw new Error('operation 必须是 buffer、intersect、distance、area 或 centroid')
}

function requireDistance(value: unknown): number {
  const distance = Number(value)
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error('distanceM 必须是大于 0 的数字')
  }
  return distance
}

function parseBbox(value: unknown): [number, number, number, number] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('bbox 必须是 [minLon, minLat, maxLon, maxLat]')
  }
  const parsed = value.map((entry) => Number(entry))
  if (!parsed.every(Number.isFinite)) throw new Error('bbox 只能包含数字')
  const [minLon, minLat, maxLon, maxLat] = parsed
  if (minLon >= maxLon || minLat >= maxLat) throw new Error('bbox 最小坐标必须小于最大坐标')
  return [minLon, minLat, maxLon, maxLat]
}

function parseLimit(value: unknown, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue)
  if (!Number.isFinite(parsed)) throw new Error('limit 必须是数字')
  return Math.max(1, Math.min(500, Math.floor(parsed)))
}

function formatMessage(operation: string, result: Record<string, unknown>): string {
  if (operation === 'area') return `面积计算完成：${Number(result.areaSqm ?? 0).toFixed(2)} 平方米`
  if (operation === 'distance') return `距离计算完成：${Number(result.distanceM ?? 0).toFixed(2)} 米`
  if (operation === 'intersect') return result.intersects ? '相交分析完成：存在相交区域' : '相交分析完成：未发现相交区域'
  if (operation === 'buffer') return '缓冲区分析完成'
  if (operation === 'centroid') return '质心计算完成'
  return '空间分析完成'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGeometry(value: unknown): value is Geometry {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(value.type)
}
