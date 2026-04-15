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
