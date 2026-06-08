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
import type { Geometry } from 'geojson'

export interface FeatureRow {
  geometry: Geometry
  properties: Record<string, unknown>
}

export class PostGisRepository {
  constructor(private db: Database) {}

  // Layer catalog

  async listLayers(sessionId?: string | null): Promise<LayerDescriptor[]> {
    const result = await this.db.execute(sql`
      SELECT layer_key, name, source_type, geometry_type, srid, description,
             feature_count, bounds, property_schema, category, status, tags,
             analysis_capabilities, source_config_summary, session_id, thread_id,
             created_at, updated_at
      FROM layer_catalog
      WHERE status = 'active'
      ${sessionId ? sql`AND (session_id = ${sessionId} OR session_id IS NULL)` : sql``}
      ORDER BY updated_at DESC
    `)
    return result.rows.map(mapRowToLayer)
  }

  async getLayer(layerKey: string): Promise<LayerDescriptor | null> {
    const result = await this.db.execute(sql`
      SELECT * FROM layer_catalog WHERE layer_key = ${layerKey}
    `)
    if (result.rows.length === 0) return null
    return mapRowToLayer(result.rows[0] as Record<string, unknown>)
  }

  // Place search with PostGIS boundary matching

  async geocode(query: string): Promise<Array<{ label: string; latitude: number; longitude: number }>> {
    const result = await this.db.execute(sql`
      SELECT name, ST_X(ST_Centroid(geom)) as lon, ST_Y(ST_Centroid(geom)) as lat
      FROM layer_catalog
      WHERE name ILIKE ${'%' + query + '%'} AND status = 'active'
      LIMIT 10
    `)
    return result.rows.map((r: Record<string, unknown>) => ({
      label: String(r.name ?? query),
      longitude: Number(r.lon),
      latitude: Number(r.lat),
    }))
  }

  // Spatial query helpers

  async queryFeatures(layerKey: string, bbox?: [number, number, number, number], limit = 100): Promise<FeatureRow[]> {
    if (!bbox) {
      const result = await this.db.execute(sql`
        SELECT ST_AsGeoJSON(geom)::json as geometry, properties
        FROM layer_features WHERE layer_key = ${layerKey} LIMIT ${limit}
      `)
      return result.rows.map(mapRowToFeature)
    }
    const result = await this.db.execute(sql`
      SELECT ST_AsGeoJSON(geom)::json as geometry, properties
      FROM layer_features
      WHERE layer_key = ${layerKey}
        AND geom && ST_MakeEnvelope(${bbox[0]}::float, ${bbox[1]}::float, ${bbox[2]}::float, ${bbox[3]}::float, 4326)
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToFeature)
  }

  async featureCount(layerKey: string): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT COUNT(*) as cnt FROM layer_features WHERE layer_key = ${layerKey}
    `)
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0)
  }
}

function mapRowToFeature(row: Record<string, unknown>): FeatureRow {
  return {
    geometry: row.geometry as Geometry,
    properties: isRecord(row.properties) ? row.properties : {},
  }
}

function mapRowToLayer(row: Record<string, unknown>): LayerDescriptor {
  return {
    layerKey: String(row.layer_key ?? ''),
    name: String(row.name ?? ''),
    sourceType: String(row.source_type ?? ''),
    geometryType: String(row.geometry_type ?? ''),
    srid: Number(row.srid ?? 4326),
    description: String(row.description ?? ''),
    featureCount: row.feature_count != null ? Number(row.feature_count) : null,
    bounds: Array.isArray(row.bounds) ? row.bounds as [number, number, number, number] : null,
    propertySchema: Array.isArray(row.property_schema)
      ? (row.property_schema as LayerPropertyDescriptor[])
      : [],
    category: String(row.category ?? 'general'),
    status: String(row.status ?? 'active'),
    tags: Array.isArray(row.tags) ? row.tags as string[] : [],
    analysisCapabilities: Array.isArray(row.analysis_capabilities)
      ? row.analysis_capabilities as string[] : [],
    sourceConfigSummary: row.source_config_summary as string | null ?? null,
    sessionId: row.session_id as string | null ?? null,
    threadId: row.thread_id as string | null ?? null,
    createdAt: row.created_at as string | null ?? null,
    updatedAt: row.updated_at as string | null ?? null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
