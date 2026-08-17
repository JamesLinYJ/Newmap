// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行附件授权事实源
//
// --------------------------------------------------------------------------

import {
  runAttachmentsSchema,
  type ContextReference,
  type RunAttachmentInput,
} from '../schemas/types.js'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
const ATTACHMENT_KINDS = new Set(['image_attachment', 'map_screenshot'])

type AttachmentLedger = Pick<FileLifecyclePort, 'list'>

export async function authorizeRunAttachments(
  fileLifecycle: AttachmentLedger,
  threadId: string,
  attachments: readonly RunAttachmentInput[],
  expectedReferences: ReadonlyMap<string, ContextReference> = new Map(),
): Promise<ContextReference[]> {
  if (!attachments.length) return []
  const files = await fileLifecycle.list(threadId)
  const byId = new Map(files.map(file => [file.id, file]))
  let totalBytes = 0
  return attachments.map(attachment => {
    const file = byId.get(attachment.fileId)
    if (!file || file.threadId !== threadId || file.status !== 'ready') {
      throw new Error(`附件 '${attachment.fileId}' 不属于当前线程或不是 ready 状态。`)
    }
    if (file.name.normalize('NFC') !== attachment.name.normalize('NFC')) {
      throw new Error(`附件 '${attachment.fileId}' 的文件名与上传账本不一致。`)
    }
    if (file.mediaType !== attachment.mediaType) {
      throw new Error(`附件 '${attachment.fileId}' 的媒体类型与上传账本不一致。`)
    }
    if (file.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件 '${attachment.fileId}' 超过 20 MiB 上限。`)
    }
    totalBytes += file.sizeBytes
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error('单次运行的图片附件总量不得超过 40 MiB。')
    }

    const expected = expectedReferences.get(attachment.fileId)
    if (expected) assertLedgerStillMatchesReference(expected, file, threadId)
    return {
      referenceId: `attachment:${attachment.fileId}`,
      kind: attachment.kind === 'map_screenshot' ? 'map_screenshot' : 'image_attachment',
      label: attachment.name,
      description: attachment.kind === 'map_screenshot'
        ? '当前地图渲染截图及其结构化空间上下文'
        : '用户附加的图片',
      sourceRunId: null,
      artifactId: null,
      collectionRef: null,
      layerKey: null,
      confidence: 1,
      usableAs: ['authorized_attachment'],
      metadata: {
        fileId: attachment.fileId,
        mediaType: attachment.mediaType,
        attachmentKind: attachment.kind,
        mapContext: attachment.mapContext,
        authorizedThreadId: threadId,
        authorizedName: file.name,
        sizeBytes: file.sizeBytes,
        contentHash: file.contentHash,
        trust: 'untrusted_user_content',
      },
    }
  })
}

export async function reauthorizeContinuationAttachments(
  fileLifecycle: AttachmentLedger,
  threadId: string,
  sourceRunId: string,
  source: readonly ContextReference[],
): Promise<ContextReference[]> {
  const attachmentReferences = source.filter(reference => ATTACHMENT_KINDS.has(reference.kind))
  if (!attachmentReferences.length) return []
  const expected = new Map<string, ContextReference>()
  const rawAttachments = attachmentReferences.map(reference => {
    const fileId = stringMetadata(reference, 'fileId')
    const mediaType = stringMetadata(reference, 'mediaType')
    const authorizedThreadId = stringMetadata(reference, 'authorizedThreadId')
    if (!fileId || !mediaType) {
      throw new Error(`运行 '${sourceRunId}' 的附件引用 '${reference.referenceId}' 缺少文件身份元数据。`)
    }
    if (authorizedThreadId && authorizedThreadId !== threadId) {
      throw new Error(`运行 '${sourceRunId}' 的附件 '${fileId}' 绑定了不同线程。`)
    }
    expected.set(fileId, reference)
    return reference.kind === 'map_screenshot'
      ? {
          fileId,
          name: reference.label,
          mediaType,
          kind: 'map_screenshot',
          mapContext: reference.metadata.mapContext,
        }
      : {
          fileId,
          name: reference.label,
          mediaType,
          kind: 'image',
          mapContext: null,
        }
  })
  const attachments = runAttachmentsSchema.parse(rawAttachments)
  const authorized = await authorizeRunAttachments(
    fileLifecycle,
    threadId,
    attachments,
    expected,
  )
  return authorized.map(reference => ({
    ...reference,
    sourceRunId,
    metadata: {
      ...reference.metadata,
      continuedFromRunId: sourceRunId,
    },
  }))
}

function assertLedgerStillMatchesReference(
  reference: ContextReference,
  file: Awaited<ReturnType<AttachmentLedger['list']>>[number],
  threadId: string,
): void {
  const expectedName = stringMetadata(reference, 'authorizedName') ?? reference.label
  if (file.name.normalize('NFC') !== expectedName.normalize('NFC')) {
    throw new Error(`附件 '${file.id}' 在澄清续跑前文件名发生变化。`)
  }
  const expectedHash = stringMetadata(reference, 'contentHash')
  if (expectedHash && file.contentHash !== expectedHash) {
    throw new Error(`附件 '${file.id}' 在澄清续跑前内容哈希发生变化。`)
  }
  const expectedSize = numberMetadata(reference, 'sizeBytes')
  if (expectedSize !== null && file.sizeBytes !== expectedSize) {
    throw new Error(`附件 '${file.id}' 在澄清续跑前文件大小发生变化。`)
  }
  const authorizedThreadId = stringMetadata(reference, 'authorizedThreadId')
  if (authorizedThreadId && authorizedThreadId !== threadId) {
    throw new Error(`附件 '${file.id}' 的授权线程与澄清续跑线程不一致。`)
  }
}

function stringMetadata(reference: ContextReference, key: string): string | null {
  const value = reference.metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberMetadata(reference: ContextReference, key: string): number | null {
  const value = reference.metadata[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
