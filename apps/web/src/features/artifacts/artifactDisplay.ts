// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 展示面契约
//
//   文件:       artifactDisplay.ts
//
//   日期:       2026年06月24日
//   作者:       Codex
// --------------------------------------------------------------------------

export const ARTIFACT_DISPLAY_SURFACES = ['map', 'mini_app', 'download'] as const

export type ArtifactDisplaySurface = typeof ARTIFACT_DISPLAY_SURFACES[number]

interface DisplayArtifact {
  artifactType?: string | null
  metadata?: Record<string, unknown> | null
}

const DISPLAY_SURFACE_SET = new Set<string>(ARTIFACT_DISPLAY_SURFACES)

// 工具 provider 的 metadata.displaySurfaces 是一等契约：它决定 artifact
// 应该进入地图、mini app 还是下载区。类型默认只服务通用旧结果和非工具产物。
export function artifactDisplaySurfaces(artifact: DisplayArtifact): ArtifactDisplaySurface[] {
  const explicit = explicitDisplaySurfaces(artifact.metadata ?? {})
  if (explicit.length) return explicit
  return defaultDisplaySurfaces(artifact.artifactType ?? '')
}

export function artifactHasDisplaySurface(
  artifact: DisplayArtifact,
  surface: ArtifactDisplaySurface,
): boolean {
  return artifactDisplaySurfaces(artifact).includes(surface)
}

function explicitDisplaySurfaces(metadata: Record<string, unknown>): ArtifactDisplaySurface[] {
  const raw = Array.isArray(metadata.displaySurfaces)
    ? metadata.displaySurfaces
    : typeof metadata.displaySurface === 'string'
      ? [metadata.displaySurface]
      : []
  return [...new Set(raw)]
    .filter((surface): surface is ArtifactDisplaySurface => (
      typeof surface === 'string' && DISPLAY_SURFACE_SET.has(surface)
    ))
}

function defaultDisplaySurfaces(artifactType: string): ArtifactDisplaySurface[] {
  if (artifactType === 'geojson') return ['map', 'download']
  if (artifactType === 'raster_png') return ['mini_app', 'download']
  if (artifactType === 'docx' || artifactType === 'xlsx' || artifactType === 'npz') return ['download']
  return ['download']
}
