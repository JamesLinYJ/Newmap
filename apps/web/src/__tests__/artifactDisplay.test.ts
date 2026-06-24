// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 展示面契约测试
//
//   文件:       artifactDisplay.test.ts
//
//   日期:       2026年06月24日
//   作者:       Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { artifactDisplaySurfaces, artifactHasDisplaySurface } from '../features/artifacts/artifactDisplay'

describe('artifact display surfaces', () => {
  it('honors explicit mini-app surfaces for third-party preview PNGs', () => {
    const artifact = {
      artifactType: 'raster_png',
      metadata: { displaySurfaces: ['mini_app', 'download'] },
    }

    expect(artifactDisplaySurfaces(artifact)).toEqual(['mini_app', 'download'])
    expect(artifactHasDisplaySurface(artifact, 'mini_app')).toBe(true)
    expect(artifactHasDisplaySurface(artifact, 'map')).toBe(false)
  })

  it('keeps GeoJSON map-visible by default', () => {
    expect(artifactDisplaySurfaces({ artifactType: 'geojson', metadata: {} })).toEqual(['map', 'download'])
  })
})
