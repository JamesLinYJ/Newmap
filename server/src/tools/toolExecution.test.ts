import { describe, expect, it } from 'vitest'
import type { Geometry } from 'geojson'
import type { PostGisRepository } from '../gis/postgis.js'
import { createLayerQueryTool } from './layerQuery/layerQuery.js'
import { createSpatialAnalysisTool } from './spatialAnalysis/spatialAnalysis.js'

describe('geo tools', () => {
  it('queries real PostGIS rows through query_layer', async () => {
    const postgis = {
      getLayer: async () => ({
        layerKey: 'roads',
        name: '道路',
        sourceType: 'postgis',
        geometryType: 'Point',
        srid: 4326,
        description: '',
        featureCount: 2,
        bounds: null,
        propertySchema: [],
        category: 'general',
        status: 'active',
        tags: [],
        analysisCapabilities: [],
        sourceConfigSummary: null,
        sessionId: null,
        threadId: null,
        createdAt: null,
        updatedAt: null,
      }),
      featureCount: async () => 2,
      queryFeatures: async () => [
        { geometry: point(120, 30), properties: { name: 'A', hidden: true } },
        { geometry: point(121, 31), properties: { name: 'B', hidden: false } },
      ],
    } as unknown as PostGisRepository

    const result = await createLayerQueryTool(postgis).handler({ layerKey: 'roads', properties: ['name'] }, runtime())
    const collection = result.payload.featureCollection as { features: Array<{ properties: Record<string, unknown> }> }

    expect(result.source).toBe('postgis')
    expect(result.payload.totalCount).toBe(2)
    expect(collection.features[0].properties).toEqual({ name: 'A' })
  })

  it('runs deterministic Turf operations through spatial_analysis', async () => {
    const postgis = {} as PostGisRepository
    const result = await createSpatialAnalysisTool(postgis).handler({
      operation: 'area',
      sourceGeojson: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
        properties: {},
      },
    }, runtime())

    expect(result.source).toBe('turf-postgis')
    expect(Number(result.payload.result && (result.payload.result as Record<string, unknown>).areaSqm)).toBeGreaterThan(0)
  })
})

function point(lon: number, lat: number): Geometry {
  return { type: 'Point', coordinates: [lon, lat] }
}

function runtime() {
  return {
    runId: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
  }
}
