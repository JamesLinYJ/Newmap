// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 默认选择策略
//
//   文件:       artifactSelection.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ArtifactRef } from '@geo-agent-platform/shared-types'
import { artifactHasDisplaySurface } from './artifactDisplay'

// 新 run 完成后需要一个可预览结果自动进入地图或详情面板。
//
// 选择顺序与展示契约一致：地图优先，其次 mini-app，最后下载类 artifact。
export function pickPreferredArtifactId(artifacts: ArtifactRef[] = []): string | undefined {
  const visibleArtifacts = artifacts.filter(artifact => !artifact.isIntermediate)
  const candidates = visibleArtifacts.length ? visibleArtifacts : artifacts
  const preferred =
    candidates.find(artifact => artifactHasDisplaySurface(artifact, 'map')) ??
    candidates.find(artifact => artifactHasDisplaySurface(artifact, 'mini_app')) ??
    candidates.find(artifact => artifactHasDisplaySurface(artifact, 'download')) ??
    candidates[0]
  return preferred?.artifactId
}
