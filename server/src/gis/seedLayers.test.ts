// +-------------------------------------------------------------------------
//
//   地理智能平台 - 系统图层 Seed 导入测试
//
//   文件:       seedLayers.test.ts
//
//   日期:       2026年06月24日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { LayerDescriptor } from '../schemas/types.js'
import { loadSeedLayerCatalog, seedLayersFromDirectory } from './seedLayers.js'

describe('seed layer catalog', () => {
  it('registers Hangzhou districts as a first-class system layer seed', async () => {
    // 杭州行政区划必须进入平台图层事实源；否则 Agent 的 list_layers
    // 再严格也只能看到临时分析矩形，无法使用真实区县边界。
    const seedDirectory = fileURLToPath(new URL('../../../infra/seeds/layers', import.meta.url))
    const catalog = await loadSeedLayerCatalog(seedDirectory)

    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        layer_key: 'hangzhou_districts',
        name: '杭州市行政区划',
        source_type: 'system',
        category: 'boundary',
        tags: expect.arrayContaining(['杭州', '行政区划', '区县', '边界']),
      }),
    ]))
  })

  it('keeps the repository seed catalog aligned with files on disk', async () => {
    // catalog 是启动时导入系统图层的唯一清单；每一项都必须能解析到真实文件，
    // 防止 API 因虚引用在监听 /ws 前失败。
    const seedDirectory = fileURLToPath(new URL('../../../infra/seeds/layers', import.meta.url))
    const catalog = await loadSeedLayerCatalog(seedDirectory)

    for (const entry of catalog) {
      const filename = entry.filename ?? `${entry.layer_key}.geojson`
      await expect(access(path.join(seedDirectory, filename))).resolves.toBeUndefined()
    }
  })

  it('imports every catalog entry through the PostGIS repository with stable metadata', async () => {
    // 导入器只信任 catalog 中的相对文件引用，并把 seed 写成确定性 layerKey；
    // 重启重复执行时会覆盖同名系统图层，不产生新的会话临时图层。
    const seedDirectory = await mkdtemp(path.join(tmpdir(), 'geoforge-seed-layers-'))
    await writeFile(path.join(seedDirectory, 'catalog.json'), JSON.stringify({
      layers: [{
        layer_key: 'test_boundary',
        name: '测试边界',
        filename: 'boundary.geojson',
        source_type: 'system',
        category: 'boundary',
        tags: ['测试', '边界'],
        description: '测试用系统边界',
      }],
    }), 'utf8')
    await writeFile(path.join(seedDirectory, 'boundary.geojson'), JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'A' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }],
    }), 'utf8')

    const importGeoJsonLayer = vi.fn(async (input: Record<string, unknown>) => layer(String(input.layerKey), String(input.name), {
      sourceType: String(input.sourceType),
      category: String(input.category),
      tags: input.tags as string[],
      description: String(input.description),
      featureCount: 1,
    }))

    const summaries = await seedLayersFromDirectory({ importGeoJsonLayer }, seedDirectory)

    expect(importGeoJsonLayer).toHaveBeenCalledWith(expect.objectContaining({
      layerKey: 'test_boundary',
      name: '测试边界',
      sourceType: 'system',
      category: 'boundary',
      tags: ['测试', '边界'],
      sessionId: null,
      threadId: null,
      sourceFilename: 'boundary.geojson',
      collection: expect.objectContaining({ type: 'FeatureCollection' }),
    }))
    expect(summaries).toEqual([{ layerKey: 'test_boundary', name: '测试边界', featureCount: 1, sourceType: 'system' }])
  })

  it('rejects catalog entries that escape the seed directory', async () => {
    const seedDirectory = await mkdtemp(path.join(tmpdir(), 'geoforge-seed-layers-'))
    await writeFile(path.join(seedDirectory, 'catalog.json'), JSON.stringify({
      layers: [{ layer_key: 'bad_layer', name: 'Bad', filename: '../bad.geojson' }],
    }), 'utf8')

    await expect(seedLayersFromDirectory({ importGeoJsonLayer: vi.fn() }, seedDirectory))
      .rejects.toThrow('不允许引用目录外文件')
  })
})

function layer(layerKey: string, name: string, overrides: Partial<LayerDescriptor> = {}): LayerDescriptor {
  return {
    layerKey,
    name,
    sourceType: 'system',
    geometryType: 'Polygon',
    srid: 4326,
    description: '',
    featureCount: 0,
    bounds: null,
    propertySchema: [],
    category: 'system',
    status: 'active',
    tags: [],
    analysisCapabilities: [],
    sourceConfigSummary: null,
    sessionId: null,
    threadId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}
