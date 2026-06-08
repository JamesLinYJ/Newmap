import type { PostGisRepository } from '../../gis/postgis.js'
import type { ToolDef } from '../../tools.js'
import { makeId } from '../../utils/ids.js'

export function createLayerQueryTool(postgis: PostGisRepository): ToolDef {
  return {
    name: 'query_layer',
    label: '图层查询',
    description: '根据图层标识、空间范围和返回上限查询空间要素，并返回 GeoJSON FeatureCollection。',
    group: '地理',
    toolKind: 'registry',
    tags: ['geo', 'query', 'read'],
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,

    jsonSchema: {
      type: 'object',
      properties: {
        layerKey: { type: 'string', description: '要查询的图层标识' },
        bbox: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: '空间范围 [minLon, minLat, maxLon, maxLat]',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '返回数量上限', default: 100 },
        properties: { type: 'array', items: { type: 'string' }, description: '要返回的属性字段' },
      },
      required: ['layerKey'],
    },

    async handler(args) {
      const layerKey = requireString(args.layerKey, 'layerKey')
      const bbox = parseBbox(args.bbox)
      const limit = parseLimit(args.limit)
      const propertyNames = parsePropertyNames(args.properties)

      const [layer, totalCount, rows] = await Promise.all([
        postgis.getLayer(layerKey),
        postgis.featureCount(layerKey),
        postgis.queryFeatures(layerKey, bbox, limit),
      ])

      if (!layer) {
        throw new Error(`图层 '${layerKey}' 不存在或不可用`)
      }

      const features = rows.map((row) => {
        const sourceProperties = isRecord(row.properties) ? row.properties : {}
        return {
          type: 'Feature' as const,
          geometry: row.geometry,
          properties: propertyNames.length
            ? pickProperties(sourceProperties, propertyNames)
            : sourceProperties,
        }
      })

      const collection = {
        type: 'FeatureCollection' as const,
        features,
      }

      return {
        message: `图层 '${layer.name || layerKey}' 返回 ${features.length} 个要素，总数 ${totalCount}`,
        payload: {
          layerKey,
          layerName: layer.name,
          totalCount,
          returnedCount: features.length,
          bbox: bbox ?? null,
          featureCollection: collection,
        },
        warnings: features.length >= limit ? [`已达到 limit=${limit}，结果可能被截断。`] : [],
        valueRefs: [{
          refId: makeId('ref'),
          kind: 'feature_collection',
          label: `${layer.name || layerKey} 查询结果`,
          value: collection,
          metadata: { layerKey, totalCount, returnedCount: features.length },
        }],
        resultId: makeId('result'),
        source: 'postgis',
      }
    },
  }
}

function requireString(value: unknown, key: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`${key} 必须是非空字符串`)
}

function parseBbox(value: unknown): [number, number, number, number] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('bbox 必须是 [minLon, minLat, maxLon, maxLat]')
  }
  const parsed = value.map((entry) => Number(entry))
  if (!parsed.every(Number.isFinite)) {
    throw new Error('bbox 只能包含数字')
  }
  const [minLon, minLat, maxLon, maxLat] = parsed
  if (minLon >= maxLon || minLat >= maxLat) {
    throw new Error('bbox 最小坐标必须小于最大坐标')
  }
  return [minLon, minLat, maxLon, maxLat]
}

function parseLimit(value: unknown): number {
  const parsed = Number(value ?? 100)
  if (!Number.isFinite(parsed)) throw new Error('limit 必须是数字')
  return Math.max(1, Math.min(500, Math.floor(parsed)))
}

function parsePropertyNames(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('properties 必须是字符串数组')
  return value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean)
}

function pickProperties(source: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) {
      picked[name] = source[name]
    }
  }
  return picked
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
