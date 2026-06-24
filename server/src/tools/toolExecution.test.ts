import { describe, expect, it } from 'vitest'
import type { Geometry } from 'geojson'
import type { PostGisRepository } from '../gis/postgis.js'
import type { LayerDescriptor } from '../schemas/types.js'
import { createLayerListTool } from './layerList/layerList.js'
import { createLayerQueryTool } from './layerQuery/layerQuery.js'
import { createLayerCreateTool } from './layerCreate/layerCreate.js'
import { createSpatialAnalysisTool } from './spatialAnalysis/spatialAnalysis.js'

describe('geo tools', () => {
  it('lists existing platform layers without external fetching', async () => {
    const postgis = {
      listLayers: async (sessionId: string | null, threadId: string | null) => {
        expect(sessionId).toBe('session_1')
        expect(threadId).toBe('thread_1')
        return [
          layer('hangzhou_admin', '杭州市区县边界', ['杭州', '行政区划']),
          layer('admin_boundaries', '行政区边界', []),
          layer('roads', '道路中心线', ['道路']),
        ]
      },
    } as unknown as PostGisRepository

    const result = await createLayerListTool(postgis).handler({ query: '杭州 行政区划' }, runtime())

    expect(result.source).toBe('postgis')
    expect(result.provenance).toMatchObject({ externalFetch: false })
    expect(result.payload.layers).toEqual([
      expect.objectContaining({ layerKey: 'hangzhou_admin', name: '杭州市区县边界' }),
    ])
  })

  it('does not treat auto-generated analysis rectangles as administrative boundaries', async () => {
    const postgis = {
      listLayers: async () => [
        layer('layer_bbox', '杭州市边界', ['auto-generated', 'analysis'], {
          sourceType: 'analysis',
          category: 'analysis',
          description: '杭州市行政边界矩形范围',
        }),
      ],
    } as unknown as PostGisRepository

    const result = await createLayerListTool(postgis).handler({ query: '杭州 行政区划' }, runtime())

    expect(result.payload.count).toBe(0)
    expect(result.payload.layers).toEqual([])
  })

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

  it('creates both layer and feature_collection refs for downstream tools', async () => {
    const postgis = {
      importGeoJsonLayer: async (input: Record<string, unknown>) => {
        expect(input.sessionId).toBe('session_1')
        expect(input.threadId).toBe('thread_1')
        expect(input.collection).toMatchObject({ type: 'FeatureCollection' })
        return layer('layer_1', String(input.name), ['analysis'])
      },
    } as unknown as PostGisRepository

    const result = await createLayerCreateTool(postgis).handler({
      name: '杭州中心点',
      geojson: {
        type: 'Feature',
        geometry: point(120.2, 30.25),
        properties: { name: '杭州中心点' },
      },
    }, runtime())

    expect(result.valueRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'layer', value: expect.objectContaining({ layerKey: 'layer_1', featureCollection: expect.any(Object) }) }),
      expect.objectContaining({ kind: 'feature_collection', metadata: { sourceLayerKey: 'layer_1' } }),
    ]))
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

    expect(result.source).toBe('turf')
    expect(result.payload.areaSqm).toBeGreaterThan(0)
  })
})

function point(lon: number, lat: number): Geometry {
  return { type: 'Point', coordinates: [lon, lat] }
}

function layer(
  layerKey: string,
  name: string,
  tags: string[],
  overrides: Partial<LayerDescriptor> = {},
): LayerDescriptor {
  return {
    layerKey,
    name,
    sourceType: 'system',
    geometryType: 'Polygon',
    srid: 4326,
    description: '',
    featureCount: 13,
    bounds: [118, 29, 121, 31] as [number, number, number, number],
    propertySchema: [{ name: 'name', dataType: 'string', populatedCount: 13, sampleValues: ['西湖区'] }],
    category: 'boundary',
    status: 'active',
    tags,
    analysisCapabilities: ['query', 'spatial_analysis'],
    sourceConfigSummary: null,
    sessionId: null,
    threadId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function runtime() {
  return {
    runId: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    state: new Map(),
    resolveValueRef: () => {
      throw new Error('未知 valueRef')
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}
