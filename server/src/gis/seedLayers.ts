// +-------------------------------------------------------------------------
//
//   地理智能平台 - 系统图层 Seed 导入
//
//   文件:       seedLayers.ts
//
//   日期:       2026年06月24日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 系统图层 seed 是 PostGIS 图层事实源的初始化入口。这里按 catalog 显式导入
// 仓库内 GeoJSON，不在 Agent 工具运行时隐式补数据，也不访问外部边界服务。

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { PostGisRepository } from './postgis.js'
import type { GeoJsonFeatureCollection } from './geojson.js'
import { parseGeoJsonEntity, toFeatureCollection } from './geojson.js'
import type { LayerDescriptor } from '../schemas/types.js'

const layerKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'layer_key 必须是稳定 SQL 标识符')

const seedLayerEntrySchema = z.object({
  layer_key: layerKeySchema,
  name: z.string().min(1),
  filename: z.string().min(1).optional(),
  source_type: z.string().min(1).default('system'),
  geometry_type: z.string().min(1).optional(),
  srid: z.number().int().positive().default(4326),
  description: z.string().default(''),
  category: z.string().min(1).default('system'),
  status: z.string().min(1).default('active'),
  tags: z.array(z.string()).default([]),
})

const seedLayerCatalogSchema = z.object({
  layers: z.array(seedLayerEntrySchema),
})

export type SeedLayerEntry = z.infer<typeof seedLayerEntrySchema>

export interface SeedLayerImportSummary {
  layerKey: string
  name: string
  featureCount: number | null
  sourceType: string
}

export async function seedLayersFromDirectory(
  postgis: Pick<PostGisRepository, 'importGeoJsonLayer'>,
  seedDirectory: string,
): Promise<SeedLayerImportSummary[]> {
  const catalog = await loadSeedLayerCatalog(seedDirectory)
  const summaries: SeedLayerImportSummary[] = []
  for (const entry of catalog) {
    const filename = entry.filename ?? `${entry.layer_key}.geojson`
    const filePath = resolveSeedFile(seedDirectory, filename)
    const collection = await readSeedFeatureCollection(filePath)
    const layer = await postgis.importGeoJsonLayer({
      layerKey: entry.layer_key,
      name: entry.name,
      description: entry.description,
      sourceType: entry.source_type,
      category: entry.category,
      status: entry.status,
      tags: entry.tags,
      sessionId: null,
      threadId: null,
      sourceFilename: filename,
      collection,
    })
    summaries.push(publicSeedSummary(layer))
  }
  return summaries
}

export async function loadSeedLayerCatalog(seedDirectory: string): Promise<SeedLayerEntry[]> {
  const catalogPath = path.join(seedDirectory, 'catalog.json')
  const raw = await readFile(catalogPath, 'utf8')
  const parsed = seedLayerCatalogSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')
    throw new Error(`系统图层 catalog 无效：${details}`)
  }
  return parsed.data.layers
}

function resolveSeedFile(seedDirectory: string, filename: string): string {
  const root = path.resolve(seedDirectory)
  const resolved = path.resolve(root, filename)
  if (path.isAbsolute(filename) || !resolved.startsWith(root + path.sep)) {
    throw new Error(`系统图层 catalog 不允许引用目录外文件：${filename}`)
  }
  return resolved
}

async function readSeedFeatureCollection(filePath: string): Promise<GeoJsonFeatureCollection> {
  const raw = await readFile(filePath, 'utf8')
  return parseGeoJsonPayload(JSON.parse(raw), filePath)
}

function parseGeoJsonPayload(value: unknown, source: string): GeoJsonFeatureCollection {
  try {
    return toFeatureCollection(parseGeoJsonEntity(value, '系统图层 seed'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`系统图层 seed 不是有效 GeoJSON：${source}；${detail}`)
  }
}

function publicSeedSummary(layer: LayerDescriptor): SeedLayerImportSummary {
  return {
    layerKey: layer.layerKey,
    name: layer.name,
    featureCount: layer.featureCount,
    sourceType: layer.sourceType,
  }
}
