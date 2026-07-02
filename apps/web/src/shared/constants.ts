// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端默认常量
//
//   文件:       constants.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'

export interface DataReferenceSummary {
  id: string
  kind: 'layer' | 'file' | 'artifact' | 'meteorology'
  name: string
  status: string
  detail: string
  relativePath?: string
}

export const SAMPLES = [
  '帮我看看杭州今天短时强降水风险主要集中在哪些区',
  '把我上传的定量降水预报数据做成一张风险区划图',
  '基于现有雷达资料生成天气雷达组网拼图，并给我一个简短说明',
] as const

// 默认底图只在服务端底图列表尚未返回时兜底显示。
//
// 一旦 `/api/v1/map/basemaps` 返回可用项，资源控制器会切换到服务端事实源。
export const DEFAULT_BASEMAP: BasemapDescriptor = {
  basemapKey: 'osm',
  name: 'OpenStreetMap',
  provider: 'osm',
  kind: 'raster',
  attribution: '© OpenStreetMap contributors',
  tileUrls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  labelTileUrls: [],
  available: true,
  isDefault: true,
}
