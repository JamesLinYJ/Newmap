// +-------------------------------------------------------------------------
//
//   地理智能平台 - 共享常量与类型
//
//   文件:       constants.ts
//
//   统一存放多个组件间共享的常量定义和接口，消除跨文件重复。
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'

// ---------------------------------------------------------------------------
// DataReferenceSummary
// ---------------------------------------------------------------------------
// 在 App.tsx 与 ChatPanel.tsx 中各驻留一份完全一致的拷贝。保留此处供两处导入。

export interface DataReferenceSummary {
  id: string
  kind: 'layer' | 'weather' | 'artifact'
  name: string
  status: string
  detail: string
  relativePath?: string
}

// ---------------------------------------------------------------------------
// DEFAULT_BASEMAP
// ---------------------------------------------------------------------------
// 同时在 App.tsx 和 MapCanvas.tsx 中定义。归一到此处后两处均导入本文件。

export const DEFAULT_BASEMAP: BasemapDescriptor = {
  basemapKey: 'osm',
  name: 'OpenStreetMap',
  provider: 'osm',
  kind: 'vector',
  attribution: '&copy; OpenStreetMap Contributors',
  tileUrls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  labelTileUrls: [],
  available: true,
  isDefault: true,
}

// ---------------------------------------------------------------------------
// SAMPLES
// ---------------------------------------------------------------------------
// 统一 App.tsx（原 SAMPLE_QUERIES）与 ChatPanel.tsx（原 SAMPLES）两套示例查询。
// 保留 ChatPanel 中更完整的措辞作为唯一版本。

export const SAMPLES = [
  '查询巴黎地铁站 1 公里范围内的医院',
  '判断我上传的点是否落在柏林行政区内',
  '查询叫 Springfield 的区域',
] as const
