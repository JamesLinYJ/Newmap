// +-------------------------------------------------------------------------
//
//   地理智能平台 - 空间分析 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { getEnv } from '../../framework/env.js'
import manifest from './manifest.json' with { type: 'json' }
import type { ToolProvider } from '../../framework/types.js'
import type { PostGisRepository } from '../../gis/postgis.js'
import { createLayerListTool } from '../layerList/layerList.js'
import { createLayerQueryTool } from '../layerQuery/layerQuery.js'
import { createSpatialAnalysisTool } from '../spatialAnalysis/spatialAnalysis.js'
import { createMapExportTool } from '../mapExport/mapExport.js'
import { createLayerCreateTool } from '../layerCreate/layerCreate.js'

export function createSpatialProvider(postgis: PostGisRepository): ToolProvider {
  const runtimeRoot = getEnv().RUNTIME_ROOT
  return {
    manifest,
    tools: () => [
      createLayerListTool(postgis),
      createLayerQueryTool(postgis),
      createSpatialAnalysisTool(),
      createMapExportTool(runtimeRoot),
      createLayerCreateTool(postgis),
    ],
  }
}
