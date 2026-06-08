// +-------------------------------------------------------------------------
//
//   地理智能平台 - AppShell 类型
//
//   文件:       types.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ArtifactRef } from '@geo-agent-platform/shared-types'

export type PrimaryNav = 'analysis' | 'layers' | 'history' | 'compute'
export type PanelMode = 'summary' | 'layers' | 'history' | 'compute' | 'sources' | 'export' | 'config' | 'layerManager'
export type SidebarItemId = 'assistant' | 'query' | 'sources' | 'config' | 'export'
export type MapLayerPreference = { visible: boolean; opacity: number }
export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference'

export interface MapRenderLayer {
  kind: 'geojson' | 'raster'
  artifact: ArtifactRef
  data?: GeoJSON.FeatureCollection
  imageUrl?: string
  coordinates?: [[number, number], [number, number], [number, number], [number, number]]
  visible: boolean
  opacity: number
  featureCount: number
  geometrySummary: string
}

export interface UploadReference {
  id: string
  kind: 'layer' | 'weather'
  name: string
  relativePath?: string
  status: 'pending' | 'uploading' | 'queued' | 'running' | 'completed' | 'failed' | 'ready' | string
  detail?: string
}
