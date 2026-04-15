import { describe, expect, it } from 'vitest'

import type { ArtifactRef } from '@geo-agent-platform/shared-types'

import { pickArtifactPublishResult, pickPreferredArtifactId } from './artifactSelection'

describe('pickPreferredArtifactId', () => {
  it('prefers the latest artifact so the map highlights the final result', () => {
    const artifacts: ArtifactRef[] = [
      { artifactId: 'artifact_boundary', runId: 'run_1', artifactType: 'geojson', name: '边界', uri: '/a', metadata: {} },
      { artifactId: 'artifact_result', runId: 'run_1', artifactType: 'geojson', name: '结果', uri: '/b', metadata: {} },
    ]

    expect(pickPreferredArtifactId(artifacts)).toBe('artifact_result')
  })

  it('returns undefined when there is no artifact yet', () => {
    expect(pickPreferredArtifactId([])).toBeUndefined()
  })

  it('restores publish links from fetched artifact metadata for the selected result', () => {
    const artifacts: ArtifactRef[] = [
      { artifactId: 'artifact_boundary', runId: 'run_1', artifactType: 'geojson', name: '边界', uri: '/a', metadata: {} },
      { artifactId: 'artifact_result', runId: 'run_1', artifactType: 'geojson', name: '结果', uri: '/b', metadata: {} },
    ]

    expect(
      pickArtifactPublishResult('artifact_result', artifacts, {
        artifact_result: {
          publishResult: {
            artifactId: 'artifact_result',
            geojsonUrl: 'http://example.test/geojson',
          },
        },
      }),
    ).toEqual({
      artifactId: 'artifact_result',
      geojsonUrl: 'http://example.test/geojson',
    })
  })

  it('returns null when the selected artifact has no publish metadata', () => {
    const artifacts: ArtifactRef[] = [
      { artifactId: 'artifact_result', runId: 'run_1', artifactType: 'geojson', name: '结果', uri: '/b', metadata: {} },
    ]

    expect(pickArtifactPublishResult('artifact_result', artifacts, {})).toBeNull()
  })
})
