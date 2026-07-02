// +-------------------------------------------------------------------------
//
//   地理智能平台 - 通用线程文件 HTTP 数据面
//
//   文件:       files.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { RuntimeFileStore, type FileLike } from '../store/fileStore.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { Env } from '../framework/env.js'

export function fileRoutes(runtimeRoot: string, store: PostgresPlatformStore, security: SecurityServices, env?: Env) {
  const files = new RuntimeFileStore(runtimeRoot)

  return new Hono()
    .post('/api/v1/files/upload', async (c) => {
      try {
        enforceContentLength(c.req.header('content-length'), env?.MAX_FILE_UPLOAD_BYTES)
        const auth = requireAuth(c)
        const form = await c.req.formData()
        const file = requireFile(form.get('file'))
        const threadId = formString(form, 'threadId')
        const requestId = formString(form, 'requestId')
        const sourceRelativePath = formString(form, 'sourceRelativePath') ?? formString(form, 'relativePath')
        if (threadId) {
          const thread = store.getThread(threadId)
          await security.authorization.assertResourceWorkspace(auth, 'thread', 'update', {
            workspaceId: thread.workspaceId,
            createdByUserId: thread.createdByUserId,
            visibility: thread.visibility,
            resourceId: thread.id,
          })
        }
        const entry = await files.save(file, threadId, requestId, sourceRelativePath)
        if (threadId) await store.recordAttachment(threadId, entry)
        return c.json(entry)
      } catch (error) {
        return c.json({ detail: formatError(error, '文件上传失败') }, 400)
      }
    })
}

function enforceContentLength(value: string | undefined, limit?: number): void {
  if (!limit || !value) return
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > limit) {
    throw new Error(`上传文件过大，限制为 ${Math.round(limit / 1024 / 1024)}MB。`)
  }
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}

function requireFile(value: unknown): FileLike {
  if (!isFileLike(value)) {
    throw new Error('缺少上传文件。')
  }
  return value
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isFileLike(value: unknown): value is FileLike {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'arrayBuffer' in value
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
}
