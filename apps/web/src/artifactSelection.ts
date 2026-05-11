// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 选择派生逻辑
//
//   文件:       artifactSelection.ts
//
//   日期:       2026年04月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------
// 模块职责
//
// 集中处理当前 artifact 的默认选中、切换与派生规则，减少页面组件重复拼装选择逻辑。
import type { ArtifactRef } from '@geo-agent-platform/shared-types'

export function pickPreferredArtifactId(artifacts: ArtifactRef[]): string | undefined {
  return artifacts.at(-1)?.artifactId
}

export function pickArtifactPublishResult(
  selectedArtifactId: string | undefined,
  artifacts: ArtifactRef[],
  artifactMetadata: Record<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const artifactId = selectedArtifactId ?? pickPreferredArtifactId(artifacts)
  if (!artifactId) {
    return null
  }

  const metadataResult = artifactMetadata[artifactId]?.publishResult
  if (isRecord(metadataResult)) {
    return metadataResult
  }

  const artifactResult = artifacts.find((artifact) => artifact.artifactId === artifactId)?.metadata?.publishResult
  if (isRecord(artifactResult)) {
    return artifactResult
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
