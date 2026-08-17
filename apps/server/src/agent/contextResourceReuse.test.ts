// +-------------------------------------------------------------------------
//
//   地理智能平台 - 历史资源复用意图测试
//
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { assembleThreadContext } from './contextManager.js'

describe('thread resource reuse intent', () => {
  it('does not inject history for generic resource nouns or explicit negation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-reuse-negative-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '资源意图隔离')
      await store.fileLifecycle.upload({
        file: await stageFile(root, 'historical.nc', Buffer.from([1, 2, 3])),
        workspaceId: thread.workspaceId,
        sessionId: thread.sessionId,
        threadId: thread.id,
        createdByUserId: thread.createdByUserId,
      })

      for (const query of [
        '请解释 NetCDF 文件格式。',
        '生成一份新的风险报告。',
        '为什么结果会有误差？',
        '不要使用之前的结果，重新生成报告。',
        'Start over without using the previous file.',
      ]) {
        await store.appendTranscript({
          threadId: thread.id,
          kind: 'message',
          payload: { role: 'user', content: query },
        })
        const assembled = await assembleThreadContext(
          store,
          thread.id,
          defaultRuntimeConfig().context,
          '系统提示',
        )
        expect(assembled.messages.some(message => message.content?.includes('<thread-resources>')))
          .toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('injects resources when continuation and resource identity are both explicit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-reuse-positive-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '显式资源复用')
      await store.fileLifecycle.upload({
        file: await stageFile(root, 'selected.nc', Buffer.from([1, 2, 3])),
        workspaceId: thread.workspaceId,
        sessionId: thread.sessionId,
        threadId: thread.id,
        createdByUserId: thread.createdByUserId,
      })
      await store.appendTranscript({
        threadId: thread.id,
        kind: 'message',
        payload: { role: 'user', content: '沿用已上传文件继续分析。' },
      })

      const assembled = await assembleThreadContext(
        store,
        thread.id,
        defaultRuntimeConfig().context,
        '系统提示',
      )
      const resourceMessage = assembled.messages.find(message => (
        message.content?.includes('<thread-resources>')
      ))?.content

      expect(resourceMessage).toContain('name=selected.nc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('limits explicit ID reuse to the resource that the user named', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-context-reuse-id-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '指定产物复用')
      const previous = await store.createRun(session.id, '生成两份地图', { threadId: thread.id })
      await persistArtifact(store, root, previous.id, 'artifact_selected_map', '选中地图.png')
      await persistArtifact(store, root, previous.id, 'artifact_unrelated_map', '无关地图.png')
      const current = await store.createRun(
        session.id,
        '继续使用 artifact_selected_map 完成报告。',
        { threadId: thread.id },
      )
      await store.appendTranscript({
        threadId: thread.id,
        runId: current.id,
        kind: 'message',
        payload: { role: 'user', content: current.userQuery },
      })
      const resources = await store.listArtifactsVisibleToRun(current.id, { limit: 24 })

      const assembled = await assembleThreadContext(
        store,
        thread.id,
        defaultRuntimeConfig().context,
        '系统提示',
        { excludeRunId: current.id, artifactResources: resources },
      )
      const resourceMessage = assembled.messages.find(message => (
        message.content?.includes('<thread-resources>')
      ))?.content

      expect(resourceMessage).toContain('artifactId=artifact_selected_map')
      expect(resourceMessage).not.toContain('artifactId=artifact_unrelated_map')
      expect(resourceMessage).not.toContain('无关地图.png')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function stageFile(root: string, name: string, content: Buffer) {
  const tempPath = path.join(root, 'test-staging', name)
  await mkdir(path.dirname(tempPath), { recursive: true })
  await writeFile(tempPath, content)
  return {
    name,
    tempPath,
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mediaType: 'application/octet-stream',
  }
}

async function persistArtifact(
  store: ReturnType<typeof createTestPersistenceFacade>,
  root: string,
  runId: string,
  artifactId: string,
  name: string,
): Promise<void> {
  const relativePath = `artifacts/${runId}/${artifactId}.png`
  const absolutePath = path.resolve(root, relativePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, Uint8Array.from([137, 80, 78, 71]))
  await store.persistArtifact({
    artifactId,
    runId,
    artifactType: 'raster_png',
    name,
    uri: `/api/v1/results/${artifactId}/file`,
    display: {
      surfaces: ['download'],
      primarySurface: 'download',
      map: null,
    },
    metadata: { relativePath },
    isIntermediate: false,
  })
}
