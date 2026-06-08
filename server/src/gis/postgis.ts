// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 空间查询
//
//   文件:       postgis.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Database } from '../db/connection.js'
import { sql } from 'drizzle-orm'
import type { LayerDescriptor, LayerPropertyDescriptor } from '../schemas/types.js'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import { makeId } from '../utils/ids.js'

export interface FeatureRow {
  geometry: Geometry
  properties: Record<string, unknown>
}

interface LayerRecord {
  descriptor: LayerDescriptor
  tableName: string
  storageKind: string | null
}

export interface GeoJsonLayerInput {
  layerKey?: string | null
  name: string
  description?: string | null
  sourceType: string
  category?: string | null
  status?: string | null
  tags?: string[]
  sessionId?: string | null
  threadId?: string | null
  sourceFilename?: string | null
  collection: FeatureCollection<Geometry, GeoJsonProperties>
}

export class PostGisRepository {
  constructor(private db: Database) {}

  async listLayers(sessionId?: string | null): Promise<LayerDescriptor[]> {
    const result = await this.db.execute(sql`
      SELECT layer_key, name, source_type, geometry_type, srid, table_name,
             description, feature_count, tags, metadata_json, created_at, updated_at
      FROM layers_metadata
      WHERE 1 = 1
      ${sessionId ? sql`
        AND (
          metadata_json->>'sessionId' = ${sessionId}
          OR metadata_json->>'session_id' = ${sessionId}
          OR metadata_json->>'sessionId' IS NULL
          OR metadata_json->>'session_id' IS NULL
        )
      ` : sql``}
      ORDER BY updated_at DESC
    `)
    return result.rows.map(row => mapRowToLayerRecord(row as Record<string, unknown>).descriptor)
  }

  async getLayer(layerKey: string): Promise<LayerDescriptor | null> {
    const record = await this.getLayerRecord(layerKey)
    return record?.descriptor ?? null
  }

  async geocode(query: string): Promise<Array<{ label: string; latitude: number; longitude: number }>> {
    const result = await this.db.execute(sql`
      SELECT name, metadata_json
      FROM layers_metadata
      WHERE name ILIKE ${'%' + query + '%'}
      LIMIT 10
    `)
    return result.rows
      .map((row: Record<string, unknown>) => {
        const metadata = isRecord(row.metadata_json) ? row.metadata_json : {}
        const center = Array.isArray(metadata.center) ? metadata.center : []
        return {
          label: String(row.name ?? query),
          longitude: Number(center[0]),
          latitude: Number(center[1]),
        }
      })
      .filter(candidate => Number.isFinite(candidate.longitude) && Number.isFinite(candidate.latitude))
  }

  async queryFeatures(layerKey: string, bbox?: [number, number, number, number], limit = 100): Promise<FeatureRow[]> {
    const layer = await this.getLayerRecord(layerKey)
    if (!layer) throw new Error(`图层 '${layerKey}' 不存在`)

    const table = sql.raw(quoteQualifiedIdentifier(layer.tableName))
    const srid = layer.descriptor.srid || 4326
    if (layer.storageKind === 'feature_jsonb') {
      if (!bbox) {
        const result = await this.db.execute(sql`
          SELECT ST_AsGeoJSON(t.geom)::json as geometry, t.properties as properties
          FROM ${table} AS t
          LIMIT ${limit}
        `)
        return result.rows.map(mapRowToFeature)
      }

      const result = await this.db.execute(sql`
        SELECT ST_AsGeoJSON(t.geom)::json as geometry, t.properties as properties
        FROM ${table} AS t
        WHERE t.geom && ST_MakeEnvelope(${bbox[0]}::float, ${bbox[1]}::float, ${bbox[2]}::float, ${bbox[3]}::float, ${srid})
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToFeature)
    }

    if (!bbox) {
      const result = await this.db.execute(sql`
        SELECT ST_AsGeoJSON(t.geom)::json as geometry, to_jsonb(t) - 'geom' as properties
        FROM ${table} AS t
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToFeature)
    }

    const result = await this.db.execute(sql`
      SELECT ST_AsGeoJSON(t.geom)::json as geometry, to_jsonb(t) - 'geom' as properties
      FROM ${table} AS t
      WHERE t.geom && ST_MakeEnvelope(${bbox[0]}::float, ${bbox[1]}::float, ${bbox[2]}::float, ${bbox[3]}::float, ${srid})
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToFeature)
  }

  async featureCount(layerKey: string): Promise<number> {
    const layer = await this.getLayerRecord(layerKey)
    if (!layer) throw new Error(`图层 '${layerKey}' 不存在`)
    const table = sql.raw(quoteQualifiedIdentifier(layer.tableName))
    const result = await this.db.execute(sql`SELECT COUNT(*) as cnt FROM ${table}`)
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0)
  }

  async importGeoJsonLayer(input: GeoJsonLayerInput): Promise<LayerDescriptor> {
    const features = normalizeFeatures(input.collection)
    if (!features.length) throw new Error('GeoJSON 至少需要一个带 geometry 的 feature')

    const layerKey = sanitizeIdentifier(input.layerKey ?? makeId('layer'))
    const tableName = `uploaded_layers.${layerKey}`
    const table = sql.raw(quoteQualifiedIdentifier(tableName))
    const metadata = buildLayerMetadata(input, features)
    const now = new Date()

    await this.db.execute(sql`CREATE SCHEMA IF NOT EXISTS uploaded_layers`)
    await this.db.execute(sql`DROP TABLE IF EXISTS ${table}`)
    await this.db.execute(sql`
      CREATE TABLE ${table} (
        feature_id TEXT PRIMARY KEY,
        properties JSONB NOT NULL DEFAULT '{}'::jsonb,
        geom geometry(Geometry, 4326) NOT NULL
      )
    `)

    for (const [index, feature] of features.entries()) {
      await this.db.execute(sql`
        INSERT INTO ${table} (feature_id, properties, geom)
        VALUES (
          ${`feature_${index + 1}`},
          ${JSON.stringify(feature.properties ?? {})}::jsonb,
          ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(feature.geometry)}), 4326)
        )
      `)
    }

    await this.db.execute(sql`
      CREATE INDEX ${sql.raw(quoteIdentifier(`${layerKey}_geom_idx`))} ON ${table} USING GIST (geom)
    `)

    await this.db.execute(sql`
      INSERT INTO layers_metadata (
        layer_key, name, source_type, geometry_type, srid, table_name,
        description, feature_count, tags, metadata_json, created_at, updated_at
      )
      VALUES (
        ${layerKey}, ${input.name}, ${input.sourceType}, ${metadata.geometryType}, 4326,
        ${tableName}, ${input.description ?? ''}, ${features.length},
        ${JSON.stringify(input.tags ?? [])}::jsonb, ${JSON.stringify(metadata)}::jsonb, ${now}, ${now}
      )
      ON CONFLICT (layer_key)
      DO UPDATE SET
        name = EXCLUDED.name,
        source_type = EXCLUDED.source_type,
        geometry_type = EXCLUDED.geometry_type,
        srid = EXCLUDED.srid,
        table_name = EXCLUDED.table_name,
        description = EXCLUDED.description,
        feature_count = EXCLUDED.feature_count,
        tags = EXCLUDED.tags,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at
    `)

    const layer = await this.getLayer(layerKey)
    if (!layer) throw new Error(`图层 '${layerKey}' 导入后无法读取`)
    return layer
  }

  async updateLayerMetadata(layerKey: string, patch: {
    name?: string
    description?: string
    category?: string
    status?: string
    tags?: string[]
    analysisCapabilities?: string[]
    sourceConfigSummary?: string | null
  }): Promise<LayerDescriptor> {
    const layer = await this.getLayer(layerKey)
    if (!layer) throw new Error(`图层 '${layerKey}' 不存在`)
    const metadataPatch = {
      category: patch.category ?? layer.category,
      status: patch.status ?? layer.status,
      analysisCapabilities: patch.analysisCapabilities ?? layer.analysisCapabilities,
      sourceConfigSummary: patch.sourceConfigSummary ?? layer.sourceConfigSummary,
    }
    await this.db.execute(sql`
      UPDATE layers_metadata
      SET
        name = ${patch.name ?? layer.name},
        description = ${patch.description ?? layer.description},
        tags = ${JSON.stringify(patch.tags ?? layer.tags)}::jsonb,
        metadata_json = metadata_json || ${JSON.stringify(metadataPatch)}::jsonb,
        updated_at = ${new Date()}
      WHERE layer_key = ${layerKey}
    `)
    const updated = await this.getLayer(layerKey)
    if (!updated) throw new Error(`图层 '${layerKey}' 更新后无法读取`)
    return updated
  }

  async deleteLayer(layerKey: string): Promise<boolean> {
    const record = await this.getLayerRecord(layerKey)
    if (!record) return false
    await this.db.execute(sql`DELETE FROM layers_metadata WHERE layer_key = ${layerKey}`)
    if (record.storageKind === 'feature_jsonb') {
      const table = sql.raw(quoteQualifiedIdentifier(record.tableName))
      await this.db.execute(sql`DROP TABLE IF EXISTS ${table}`)
    }
    return true
  }

  private async getLayerRecord(layerKey: string): Promise<LayerRecord | null> {
    const result = await this.db.execute(sql`
      SELECT layer_key, name, source_type, geometry_type, srid, table_name,
             description, feature_count, tags, metadata_json, created_at, updated_at
      FROM layers_metadata
      WHERE layer_key = ${layerKey}
    `)
    if (result.rows.length === 0) return null
    return mapRowToLayerRecord(result.rows[0] as Record<string, unknown>)
  }
}

function mapRowToFeature(row: Record<string, unknown>): FeatureRow {
  return {
    geometry: row.geometry as Geometry,
    properties: isRecord(row.properties) ? row.properties : {},
  }
}

function mapRowToLayerRecord(row: Record<string, unknown>): LayerRecord {
  const metadata = isRecord(row.metadata_json) ? row.metadata_json : {}
  const descriptor: LayerDescriptor = {
    layerKey: String(row.layer_key ?? ''),
    name: String(row.name ?? ''),
    sourceType: String(row.source_type ?? ''),
    geometryType: String(row.geometry_type ?? ''),
    srid: Number(row.srid ?? 4326),
    description: String(row.description ?? ''),
    featureCount: row.feature_count != null ? Number(row.feature_count) : null,
    bounds: Array.isArray(metadata.bounds) ? metadata.bounds as [number, number, number, number] : null,
    propertySchema: Array.isArray(metadata.propertySchema)
      ? (metadata.propertySchema as LayerPropertyDescriptor[])
      : [],
    category: String(metadata.category ?? 'general'),
    status: String(metadata.status ?? 'active'),
    tags: Array.isArray(row.tags) ? row.tags as string[] : [],
    analysisCapabilities: Array.isArray(metadata.analysisCapabilities)
      ? metadata.analysisCapabilities as string[]
      : [],
    sourceConfigSummary: typeof metadata.sourceConfigSummary === 'string' ? metadata.sourceConfigSummary : null,
    sessionId: typeof metadata.sessionId === 'string' ? metadata.sessionId : typeof metadata.session_id === 'string' ? metadata.session_id : null,
    threadId: typeof metadata.threadId === 'string' ? metadata.threadId : typeof metadata.thread_id === 'string' ? metadata.thread_id : null,
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
  }
  return {
    descriptor,
    tableName: String(row.table_name ?? ''),
    storageKind: typeof metadata.storageKind === 'string' ? metadata.storageKind : null,
  }
}

function quoteQualifiedIdentifier(value: string): string {
  const parts = value.split('.')
  if (!parts.length || parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(part))) {
    throw new Error(`非法表名: ${value}`)
  }
  return parts.map(part => `"${part.replaceAll('"', '""')}"`).join('.')
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`非法标识符: ${value}`)
  }
  return `"${value.replaceAll('"', '""')}"`
}

function sanitizeIdentifier(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]+/gu, '_')
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) return normalized
  return `layer_${normalized || makeId('layer').replace(/^layer_/, '')}`
}

function normalizeFeatures(collection: FeatureCollection<Geometry, GeoJsonProperties>): Array<Feature<Geometry, GeoJsonProperties>> {
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('GeoJSON 必须是 FeatureCollection')
  }
  return collection.features.filter((feature): feature is Feature<Geometry, GeoJsonProperties> =>
    feature?.type === 'Feature' && isGeometry(feature.geometry),
  )
}

function isGeometry(value: unknown): value is Geometry {
  return isRecord(value) && typeof value.type === 'string' && 'coordinates' in value
}

function buildLayerMetadata(
  input: GeoJsonLayerInput,
  features: Array<Feature<Geometry, GeoJsonProperties>>,
): Record<string, unknown> & { geometryType: string } {
  const geometryTypes = [...new Set(features.map(feature => feature.geometry.type))]
  const bounds = computeBounds(features)
  return {
    storageKind: 'feature_jsonb',
    geometryType: geometryTypes.length === 1 ? geometryTypes[0] : 'Mixed',
    bounds,
    propertySchema: buildPropertySchema(features),
    category: input.category ?? 'upload',
    status: input.status ?? 'active',
    analysisCapabilities: ['query', 'spatial_analysis'],
    sourceConfigSummary: input.sourceFilename ?? null,
    sessionId: input.sessionId ?? null,
    threadId: input.threadId ?? null,
    sourceFilename: input.sourceFilename ?? null,
  }
}

function buildPropertySchema(features: Array<Feature<Geometry, GeoJsonProperties>>): LayerPropertyDescriptor[] {
  const stats = new Map<string, { dataType: string; populatedCount: number; sampleValues: Set<string> }>()
  for (const feature of features) {
    const properties = isRecord(feature.properties) ? feature.properties : {}
    for (const [name, value] of Object.entries(properties)) {
      const current = stats.get(name) ?? { dataType: inferDataType(value), populatedCount: 0, sampleValues: new Set<string>() }
      if (value !== null && value !== undefined && value !== '') {
        current.populatedCount += 1
        if (current.sampleValues.size < 5) current.sampleValues.add(String(value))
      }
      if (current.dataType === 'null') current.dataType = inferDataType(value)
      stats.set(name, current)
    }
  }
  return [...stats.entries()].map(([name, entry]) => ({
    name,
    dataType: entry.dataType === 'null' ? 'string' : entry.dataType,
    populatedCount: entry.populatedCount,
    sampleValues: [...entry.sampleValues],
  }))
}

function inferDataType(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function computeBounds(features: Array<Feature<Geometry, GeoJsonProperties>>): [number, number, number, number] | null {
  const coords: Array<[number, number]> = []
  for (const feature of features) collectCoordinates(feature.geometry, coords)
  if (!coords.length) return null
  const xs = coords.map(coord => coord[0])
  const ys = coords.map(coord => coord[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function collectCoordinates(geometry: Geometry, out: Array<[number, number]>): void {
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) collectCoordinates(child, out)
    return
  }
  collectPositionArray(geometry.coordinates, out)
}

function collectPositionArray(value: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(value)) return
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    out.push([value[0], value[1]])
    return
  }
  for (const child of value) collectPositionArray(child, out)
}

function formatTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
