// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图数据导出工具
//
//   文件:       mapExport.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 导出文件必须进入统一 artifact store；payload 和 valueRef 不暴露绝对路径。
// 文件名只用于展示，真实存储路径由 artifactId 决定。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDef } from '../../framework/types.js'
import { parseGeoJsonEntity } from '../../gis/geojson.js'
import { makeId } from '../../utils/ids.js'

export function createMapExportTool(runtimeRoot: string): ToolDef {
  return {
    name: 'map_export',
    label: '导出地图数据',
    description: '将 GeoJSON 分析结果保存为平台 artifact。',
    group: '空间分析',
    tags: ['export', 'file'],
    isReadOnly: false,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        geojson: { type: 'object', additionalProperties: true, description: '要导出的 GeoJSON 数据', 'x-source': 'json' },
        filename: { type: 'string', description: '导出文件名（不含路径）', default: 'export.geojson' },
      },
      required: ['geojson'],
    },
    async handler(args, ctx) {
      const geojson = parseGeoJsonEntity(args.geojson, 'geojson')
      const filename = safeFilename(args.filename)
      const artifactId = makeId('artifact')
      const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.geojson`)
      const target = resolveRuntimePath(runtimeRoot, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify(geojson, null, 2), 'utf8')

      return {
        message: `地图数据已导出为 ${filename}`,
        payload: {
          operation: 'map_export',
          filename,
          artifactId,
          downloadUrl: `/api/v1/artifacts/${artifactId}/download`,
          featureCount: geojson.type === 'FeatureCollection' ? geojson.features.length : 1,
        },
        warnings: [],
        resultId: makeId('result'),
        source: 'artifact-store',
        provenance: { backend: 'artifact-store', format: 'geojson' },
        artifacts: [{
          artifactId,
          artifactType: 'geojson',
          name: filename,
          uri: `/api/v1/results/${artifactId}/geojson`,
          relativePath,
          metadata: { relativePath, downloadUrl: `/api/v1/artifacts/${artifactId}/download` },
        }],
        valueRefs: [{
          refId: makeId('ref'),
          kind: 'artifact_ref',
          label: filename,
          value: { artifactId },
        }],
      }
    },
  }
}

function safeFilename(value: unknown): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : 'export.geojson'
  const base = path.basename(requested).replace(/\.geojson$/iu, '')
  const normalized = base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/u, '').slice(0, 100).trim()
  return `${normalized || 'export'}.geojson`
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  return target
}
