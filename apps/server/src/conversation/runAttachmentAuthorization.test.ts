// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行附件授权测试
//
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { ContextReference, RunAttachmentInput } from '../schemas/types.js'
import {
  authorizeRunAttachments,
  reauthorizeContinuationAttachments,
} from './runAttachmentAuthorization.js'

describe('run attachment authorization', () => {
  it('records the immutable file-ledger facts used by later continuations', async () => {
    const references = await authorizeRunAttachments(
      ledger([readyFile()]),
      'thread_1',
      [imageAttachment()],
    )

    expect(references).toEqual([expect.objectContaining({
      referenceId: 'attachment:file_1',
      kind: 'image_attachment',
      sourceRunId: null,
      metadata: expect.objectContaining({
        fileId: 'file_1',
        authorizedThreadId: 'thread_1',
        authorizedName: 'image.png',
        sizeBytes: 4,
        contentHash: 'a'.repeat(64),
        trust: 'untrusted_user_content',
      }),
    })])
  })

  it('reauthorizes a map screenshot and preserves its structured map context', async () => {
    const mapContext = validMapContext()
    const source = await authorizeRunAttachments(
      ledger([readyFile({ name: 'map.png' })]),
      'thread_1',
      [{
        fileId: 'file_1',
        name: 'map.png',
        mediaType: 'image/png',
        kind: 'map_screenshot',
        mapContext,
      }],
    )

    const continuation = await reauthorizeContinuationAttachments(
      ledger([readyFile({ name: 'map.png' })]),
      'thread_1',
      'run_source',
      source,
    )

    expect(continuation).toEqual([expect.objectContaining({
      kind: 'map_screenshot',
      sourceRunId: 'run_source',
      metadata: expect.objectContaining({
        mapContext,
        continuedFromRunId: 'run_source',
      }),
    })])
  })

  it('rejects deleted, cross-thread, and content-mutated attachments during continuation', async () => {
    const source = await authorizeRunAttachments(
      ledger([readyFile()]),
      'thread_1',
      [imageAttachment()],
    )

    await expect(reauthorizeContinuationAttachments(
      ledger([]),
      'thread_1',
      'run_source',
      source,
    )).rejects.toThrow('不属于当前线程或不是 ready 状态')

    await expect(reauthorizeContinuationAttachments(
      ledger([readyFile({ threadId: 'thread_2' })]),
      'thread_1',
      'run_source',
      source,
    )).rejects.toThrow('不属于当前线程或不是 ready 状态')

    await expect(reauthorizeContinuationAttachments(
      ledger([readyFile({ contentHash: 'b'.repeat(64) })]),
      'thread_1',
      'run_source',
      source,
    )).rejects.toThrow('内容哈希发生变化')
  })

  it('rejects a legacy attachment whose persisted authorization points at another thread', async () => {
    const source: ContextReference[] = [{
      referenceId: 'attachment:file_1',
      kind: 'image_attachment',
      label: 'image.png',
      description: '用户附加的图片',
      sourceRunId: null,
      artifactId: null,
      collectionRef: null,
      layerKey: null,
      confidence: 1,
      usableAs: ['authorized_attachment'],
      metadata: {
        fileId: 'file_1',
        mediaType: 'image/png',
        attachmentKind: 'image',
        mapContext: null,
        authorizedThreadId: 'thread_other',
        trust: 'untrusted_user_content',
      },
    }]

    await expect(reauthorizeContinuationAttachments(
      ledger([readyFile()]),
      'thread_1',
      'run_source',
      source,
    )).rejects.toThrow('绑定了不同线程')
  })
})

function imageAttachment(): RunAttachmentInput {
  return {
    fileId: 'file_1',
    name: 'image.png',
    mediaType: 'image/png',
    kind: 'image',
    mapContext: null,
  }
}

function readyFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file_1',
    name: 'image.png',
    sourceRelativePath: null,
    size: '4 B',
    sizeBytes: 4,
    uploadedAt: '2026-08-17T00:00:00.000Z',
    status: 'ready',
    threadId: 'thread_1',
    relativePath: 'files/thread_1/file_1/image.png',
    contentHash: 'a'.repeat(64),
    mediaType: 'image/png',
    ...overrides,
  }
}

function ledger(files: unknown[]) {
  return { list: async () => files } as never
}

function validMapContext() {
  return {
    capturedAt: '2026-08-17T00:00:00.000Z',
    viewport: {
      bounds: [119, 29, 121, 31] as [number, number, number, number],
      center: [120, 30] as [number, number],
      zoom: 8,
      bearing: 0,
      pitch: 20,
    },
    crs: 'OGC:CRS84' as const,
    renderProjection: 'EPSG:3857' as const,
    renderState: { status: 'idle' as const, tilesLoaded: true as const },
    renderedLayers: [],
    timeRange: null,
  }
}
