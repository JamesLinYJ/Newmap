// +-------------------------------------------------------------------------
//
//   地理智能平台 - 杭州短时临近预报（短临）工具契约测试
//
//   文件:       meteorologyTools.test.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../framework/types.js'
import { ToolRegistry } from '../../framework/registry.js'
import { validateToolProvider } from '../../framework/validation.js'
import provider from './index.js'
import { meteorologyTools } from './meteorologyTools.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Hangzhou nowcast tools', () => {
  it('keeps the meteorology manifest and runtime definitions identical', () => {
    expect(() => validateToolProvider(provider)).not.toThrow()
  })

  it('does not hide meteorology tools when the worker is temporarily unreachable during provider load', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('worker restarting'))
    vi.stubGlobal('fetch', fetch)
    await expect(provider.onInstall?.({
      config: { WORKER_URL: 'http://worker.test' },
      state: new Map(),
      log: () => undefined,
    }) ?? Promise.resolve()).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('creates a district boundary valueRef from an existing boundary reference', async () => {
    const state = new Map<string, unknown>([[
      'ref_boundary',
      valueRef('ref_boundary', 'feature_collection', {
        type: 'FeatureCollection',
        features: [
          feature('富阳区'),
          feature('淳安县'),
        ],
      }),
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_hangzhou_nowcast_scope')!
    const result = await tool.handler({ question: '接下来天气怎么样？', scope_ref: 'ref_boundary' }, context(state))

    expect(result.valueRefs?.[0].kind).toBe('nowcast_area')
    expect(result.valueRefs?.[1].kind).toBe('feature_collection')
    expect(result.payload.featureCount).toBe(2)
  })

  it('creates a coordinate valueRef from an existing place reference', async () => {
    const state = new Map<string, unknown>([[
      'ref_place',
      valueRef('ref_place', 'place_candidate', { lat: 30.2462469, lon: 120.2060110, label: '市民中心' }),
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_hangzhou_nowcast_scope')!
    const result = await tool.handler({ question: '市民中心天气怎么样？', scope_ref: 'ref_place' }, context(state))

    expect(result.valueRefs?.[0].kind).toBe('nowcast_coordinate')
    expect(result.valueRefs?.[0].value).toEqual({ lat: 30.2462469, lng: 120.206011, label: '市民中心' })
  })

  it('fails instead of fetching a Hangzhou boundary when no existing reference is provided', async () => {
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_hangzhou_nowcast_scope')!
    await expect(tool.handler({ question: '接下来天气怎么样？' }, context()))
      .rejects.toThrow('请先使用 list_layers 检索杭州行政区划图层')
  })

  it('delivers the standard answer together with a peak-time raster artifact', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(workerResponse({
        answer: '15分钟后将下小雨，30分钟后雨量变大。',
        basis: [],
      }))
      .mockResolvedValueOnce(workerResponse({
        coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
        bounds: [119, 29, 121, 31],
        variable: 'QPF',
        width: 640,
        height: 480,
      }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([[
      'ref_analysis',
      {
        refId: 'ref_analysis',
        kind: 'nowcast_analysis',
        label: '短时临近预报（短临）分析',
        value: {
          scope: { renderBbox: [119, 29, 121, 31] },
          mapCandidates: [
            {
              label: '180分钟 QPF',
              reason: '最新时次',
              leadMinutes: 180,
              variable: 'QPF',
              relativePath: 'uploads/latest.nc',
            },
            {
              label: '30分钟 QPF',
              reason: '降雨峰值时次',
              leadMinutes: 30,
              variable: 'QPF',
              relativePath: 'uploads/peak.nc',
            },
          ],
        },
      },
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'answer_nowcast_question')!
    const result = await tool.handler(
      { nowcast_analysis_ref: 'ref_analysis', question: '接下来天气怎么样？' },
      context(state),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      args: { file_relative_path: 'uploads/peak.nc', variable: 'QPF', bbox: [119, 29, 121, 31] },
    })
    expect(result.payload.answer).toBe('15分钟后将下小雨，30分钟后雨量变大。')
    expect(result.payload.map).toMatchObject({ reason: '降雨峰值时次', leadMinutes: 30 })
    expect(result.artifacts?.[0]).toMatchObject({
      artifactType: 'raster_png',
      metadata: {
        coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
        nowcastMapReason: '降雨峰值时次',
        nowcastLeadMinutes: 30,
      },
    })
  })

  it('passes the full radar mosaic contract to the worker and records provenance', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn(async () => workerResponse({
      targetTime: '202604091955',
      strategy: 'quality',
      product: 'echo_top',
      stationsUsed: ['Z9001'],
      valueRange: { min: 1, max: 9 },
      bounds: [119, 29, 121, 31],
      coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_radar_collection', valueRef('ref_radar_collection', 'radar_station_collection', {
        files: [{ name: 'sample.bz2', relativePath: 'uploads/sample.bz2' }],
      })],
      ['ref_time', valueRef('ref_time', 'radar_target_time', '202604091955')],
      ['ref_strategy', valueRef('ref_strategy', 'radar_mosaic_strategy', { strategy: 'quality' })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_radar_mosaic')!
    const result = await tool.handler({
      radar_collection_ref: 'ref_radar_collection',
      target_time_ref: 'ref_time',
      strategy_ref: 'ref_strategy',
      product: 'echo_top',
      level_index: 2,
      tolerance_sec: 600,
      grid_res_km: 0.5,
      min_dbz: 3,
    }, context(state))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.args).toMatchObject({
      product: 'echo_top',
      level_index: 2,
      tolerance_sec: 600,
      grid_res_km: 0.5,
      min_dbz: 3,
      output_png_relative_path: expect.stringMatching(/^artifacts\/run_1\/artifact_/u),
      output_map_png_relative_path: expect.stringMatching(/^artifacts\/run_1\/artifact_/u),
      output_npz_relative_path: expect.stringMatching(/^artifacts\/run_1\/artifact_/u),
    })
    expect(result.valueRefs?.[0]).toMatchObject({
      kind: 'radar_mosaic_result',
      value: { mapPngArtifactId: expect.stringMatching(/^artifact_/u) },
    })
    expect(result.artifacts).toHaveLength(3)
    expect(result.artifacts?.[1]).toMatchObject({
      artifactType: 'raster_png',
      metadata: {
        previewRole: 'radar_mosaic_overlay',
        coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
        displaySurfaces: ['map', 'download'],
      },
    })
    expect(result.artifacts?.[0]?.metadata).toMatchObject({
      previewRole: 'radar_mosaic',
      displaySurfaces: ['mini_app', 'download'],
    })
    expect(result.provenance).toMatchObject({
      thirdPartySource: 'radar_mosaic_agent',
      sourceSnapshot: 'packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/source/original',
      wrapperVersion: 'geoforge-wrapper-2026-06-23',
      inputRefs: {
        radarCollectionRef: 'ref_radar_collection',
        targetTimeRef: 'ref_time',
        strategyRef: 'ref_strategy',
      },
    })
    expect(result.provenance?.outputArtifacts).toHaveLength(3)
  })

  it('inspects radar station collections and emits target-time refs', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn(async () => workerResponse({
      stationCount: 1,
      fileCount: 1,
      products: ['reflectivity', 'echo_top'],
      candidateTimes: [{ timestamp: '202604091955', fileCount: 1 }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_radar_files', valueRef('ref_radar_files', 'radar_file_collection', {
        files: [{ name: 'RADA_CHN_Z9001_VOL_20260409195500_O_DOR_SAD_CAP_FMT.bin.bz2', relativePath: 'objects/sha256/aa/hash.bz2' }],
      })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'inspect_radar_station_collection')!
    const result = await tool.handler({ radar_collection_ref: 'ref_radar_files' }, context(state))

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      args: {
        files: [{ name: 'RADA_CHN_Z9001_VOL_20260409195500_O_DOR_SAD_CAP_FMT.bin.bz2', relativePath: 'objects/sha256/aa/hash.bz2' }],
      },
    })
    expect(result.valueRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'radar_station_collection' }),
      expect.objectContaining({ kind: 'radar_target_time', value: '202604091955' }),
    ]))
    expect(result.provenance).toMatchObject({
      thirdPartySource: 'radar_mosaic_agent',
      inputRefs: { radarCollectionRef: 'ref_radar_files' },
    })
  })

  it('compares radar mosaic output with a NetCDF reference and records slider artifacts', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn(async () => workerResponse({
      ncFile: 'reference.nc',
      stats: { rmse: 0.5, mae: 0.25 },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_mosaic', valueRef('ref_mosaic', 'radar_mosaic_result', {
        npzRelativePath: 'artifacts/run_1/mosaic.npz',
      })],
      ['ref_dataset', valueRef('ref_dataset', 'meteorological_dataset', {
        name: 'reference.nc',
        relativePath: 'objects/sha256/bb/reference.nc',
      })],
      ['ref_time', valueRef('ref_time', 'radar_target_time', '202604091955')],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'compare_radar_mosaic_reference')!
    const result = await tool.handler({
      radar_mosaic_result_ref: 'ref_mosaic',
      dataset_ref: 'ref_dataset',
      target_time_ref: 'ref_time',
      level_index: 1,
      product_label: '回波顶高',
      product_unit: 'km',
      min_display: 2,
    }, context(state))

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      args: {
        mosaic_npz_relative_path: 'artifacts/run_1/mosaic.npz',
        reference_files: [{ name: 'reference.nc', relativePath: 'objects/sha256/bb/reference.nc' }],
        target_time: '202604091955',
        level_index: 1,
        product_label: '回波顶高',
        product_unit: 'km',
        min_display: 2,
      },
    })
    expect(result.valueRefs?.[0]).toMatchObject({ kind: 'radar_mosaic_comparison' })
    expect(result.artifacts).toEqual([
      expect.objectContaining({ artifactType: 'raster_png' }),
      expect.objectContaining({ artifactType: 'raster_png' }),
    ])
    expect(result.artifacts?.[0].metadata).toMatchObject({
      previewRole: 'radar_reference_comparison',
      baseImageArtifactId: expect.stringMatching(/^artifact_/u),
      overlayImageArtifactId: expect.stringMatching(/^artifact_/u),
    })
  })

  it('hard-fails third-party tools when the valueRef kind is wrong', async () => {
    const state = new Map<string, unknown>([
      ['ref_file', valueRef('ref_file', 'meteorological_file', { name: 'rain.nc', relativePath: 'uploads/rain.nc' })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_rainfall_risk_map')!

    await expect(tool.handler({
      dataset_ref: 'ref_file',
      variable_ref: 'ref_missing',
      boundary_ref: 'ref_missing',
      thresholds_ref: 'ref_missing',
    }, context(state))).rejects.toThrow('dataset_ref 必须引用 meteorological_dataset')
  })

  it('sends the original filename with dataset object paths', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn(async () => workerResponse({
      variables: [{ name: 'QPF', analysisReady: true, mapReady: true }],
      times: [],
      levels: [],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_file', valueRef('ref_file', 'meteorological_file', {
        name: '202604091955_202604092000.nc',
        relativePath: 'objects/sha256/ab/abcdef',
      })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'meteorological_inspect')!
    await tool.handler({ dataset_ref: 'ref_file' }, context(state))

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      args: {
        file_relative_path: 'objects/sha256/ab/abcdef',
        file_name: '202604091955_202604092000.nc',
      },
    })
  })

  it('accepts rainfall threshold objects through the registry validator', async () => {
    const registry = new ToolRegistry()
    registry.register(provider)
    const result = await registry.execute('define_rainfall_risk_thresholds', {
      thresholds: [
        { label: '小雨', min: 0, max: 1, color: '#f0f0f0' },
        { label: '强降雨', min: 1, max: 999, color: '#d73027' },
      ],
    }, context())

    expect(result.valueRefs?.[0]).toMatchObject({ kind: 'rainfall_risk_thresholds' })
    expect(result.payload.thresholds).toHaveLength(2)
  })

  it('returns a map-native GeoJSON artifact for rainfall risk regions', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn(async () => workerResponse({
      variable: 'QPF',
      units: 'mm',
      mapMode: 'regional',
      aggregation: 'mean',
      thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      regionSummary: { counts: { 强降雨: 1 }, topRegions: [{ name: '测试区', value: 3 }] },
      outputs: { png: 'risk.png', geojson: 'risk.geojson' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_dataset', valueRef('ref_dataset', 'meteorological_dataset', {
        name: 'rain.nc',
        relativePath: 'objects/sha256/aa/rain.nc',
      })],
      ['ref_variable', valueRef('ref_variable', 'meteorological_variable', { name: 'QPF' })],
      ['ref_boundary', valueRef('ref_boundary', 'meteorological_file', {
        name: 'boundary.geojson',
        relativePath: 'objects/sha256/bb/boundary.geojson',
      })],
      ['ref_thresholds', valueRef('ref_thresholds', 'rainfall_risk_thresholds', {
        thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_rainfall_risk_map')!
    const result = await tool.handler({
      dataset_ref: 'ref_dataset',
      variable_ref: 'ref_variable',
      boundary_ref: 'ref_boundary',
      thresholds_ref: 'ref_thresholds',
    }, context(state))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.args).toMatchObject({
      output_relative_path: expect.stringMatching(/artifact_.*\.png$/u),
      output_geojson_relative_path: expect.stringMatching(/artifact_.*\.geojson$/u),
    })
    expect(result.valueRefs?.[0]).toMatchObject({
      kind: 'rainfall_risk_map_result',
      value: {
        artifactId: expect.stringMatching(/^artifact_/u),
        geojsonArtifactId: expect.stringMatching(/^artifact_/u),
      },
    })
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        artifactType: 'raster_png',
        metadata: expect.objectContaining({ displaySurfaces: ['mini_app', 'download'] }),
      }),
      expect.objectContaining({
        artifactType: 'geojson',
        metadata: expect.objectContaining({
          mapRole: 'rainfall_risk_regions',
          previewArtifactId: expect.stringMatching(/^artifact_/u),
          displaySurfaces: ['map', 'download'],
        }),
      }),
    ])
  })

  it('accepts a layer valueRef with embedded features as rainfall risk boundary input', async () => {
    stubRuntimeEnv()
    const fetchMock = vi.fn(async () => workerResponse({
      variable: 'QPF',
      units: 'mm',
      mapMode: 'regional',
      aggregation: 'mean',
      thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      regionSummary: { counts: { 强降雨: 1 }, topRegions: [{ name: '测试区', value: 3 }] },
      outputs: { png: 'risk.png', geojson: 'risk.geojson' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_dataset', valueRef('ref_dataset', 'meteorological_dataset', {
        name: 'rain.nc',
        relativePath: 'objects/sha256/aa/rain.nc',
      })],
      ['ref_variable', valueRef('ref_variable', 'meteorological_variable', { name: 'QPF' })],
      ['ref_layer', valueRef('ref_layer', 'layer', {
        layerKey: 'hangzhou_admin',
        featureCollection: { type: 'FeatureCollection', features: [feature('测试区')] },
      })],
      ['ref_thresholds', valueRef('ref_thresholds', 'rainfall_risk_thresholds', {
        thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_rainfall_risk_map')!
    await tool.handler({
      dataset_ref: 'ref_dataset',
      variable_ref: 'ref_variable',
      boundary_ref: 'ref_layer',
      thresholds_ref: 'ref_thresholds',
    }, context(state))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.args.boundary_relative_path).toMatch(/^artifacts\/run_1\/boundary_.*\.geojson$/u)
  })

  it('creates rainfall thresholds and area rainfall artifacts with third-party provenance', async () => {
    stubRuntimeEnv()
    const thresholdTool = meteorologyTools.find(candidate => candidate.name === 'define_rainfall_risk_thresholds')!
    const thresholds = await thresholdTool.handler({
      thresholds: [
        { label: '小雨', min: 0, max: 1, color: '#f0f0f0' },
        { label: '强降雨', min: 1, max: 999, color: '#d73027' },
      ],
    }, context())
    expect(thresholds.valueRefs?.[0]).toMatchObject({ kind: 'rainfall_risk_thresholds' })
    expect(thresholds.payload.thresholds).toHaveLength(2)
    expect(thresholds.provenance).toMatchObject({
      thirdPartySource: 'rainfall_risk_map',
      sourceSnapshot: 'packages/gis-meteorology/src/gis_meteorology/third_party/rainfall_risk_map/source/original',
    })

    const fetchMock = vi.fn(async () => workerResponse({
      regionCount: 1,
      topN: 1,
      topRows: [{ rank: 1, region: '测试区', areaRainfall: 3 }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const state = new Map<string, unknown>([
      ['ref_collection', valueRef('ref_collection', 'meteorological_file_collection', {
        files: [{ name: '202604091955_202604092000.nc', relativePath: 'uploads/a.nc' }],
      })],
      ['ref_boundary', valueRef('ref_boundary', 'meteorological_file', {
        name: 'boundary.geojson',
        relativePath: 'uploads/boundary.geojson',
      })],
    ])
    const tableTool = meteorologyTools.find(candidate => candidate.name === 'generate_area_rainfall_table')!
    const table = await tableTool.handler({
      file_collection_ref: 'ref_collection',
      boundary_ref: 'ref_boundary',
      top_n: 1,
      style: { titleText: '测试表格' },
    }, context(state))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.args).toMatchObject({
      files: [{ name: '202604091955_202604092000.nc', relativePath: 'uploads/a.nc' }],
      boundary_relative_path: 'uploads/boundary.geojson',
      top_n: 1,
      style: { titleText: '测试表格' },
    })
    expect(table.artifacts).toEqual([
      expect.objectContaining({
        artifactType: 'xlsx',
        metadata: expect.objectContaining({ displaySurfaces: ['download'] }),
      }),
      expect.objectContaining({
        artifactType: 'raster_png',
        metadata: expect.objectContaining({ displaySurfaces: ['mini_app', 'download'] }),
      }),
    ])
    expect(table.provenance).toMatchObject({
      thirdPartySource: 'short_term_forecast',
      sourceSnapshot: 'packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/source/original',
    })
  })
})

function feature(name: string) {
  return {
    type: 'Feature',
    properties: { name },
    geometry: {
      type: 'Polygon',
      coordinates: [[[119, 29], [120, 29], [120, 30], [119, 30], [119, 29]]],
    },
  }
}

function response(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response
}

function workerResponse(payload: Record<string, unknown>): Response {
  return response({ message: '执行完成', payload })
}

function stubRuntimeEnv() {
  vi.stubEnv('API_PORT', '8000')
  vi.stubEnv('API_HOST', '127.0.0.1')
  vi.stubEnv('DATABASE_URL', 'postgres://test:test@127.0.0.1/test')
  vi.stubEnv('RUNTIME_ROOT', 'runtime')
  vi.stubEnv('WORKER_URL', 'http://worker.test')
  vi.stubEnv('ENABLED_TOOL_PROVIDERS', 'geo-platform-meteorology')
}

function valueRef(refId: string, kind: string, value: unknown) {
  return { refId, kind, label: refId, value }
}

function context(state = new Map<string, unknown>()): ToolContext {
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    state,
    resolveValueRef: refId => {
      const value = state.get(refId)
      if (!value) throw new Error(`未知 valueRef：${refId}`)
      return value as ReturnType<ToolContext['resolveValueRef']>
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}
