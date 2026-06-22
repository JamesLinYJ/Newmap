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

export function fileRoutes(runtimeRoot: string, store: PostgresPlatformStore) {
  const files = new RuntimeFileStore(runtimeRoot)

  return new Hono()
    .post('/api/v1/files/upload', async (c) => {
      try {
        const form = await c.req.formData()
        const file = requireFile(form.get('file'))
        const threadId = formString(form, 'threadId')
        const requestId = formString(form, 'requestId')
        const entry = await files.save(file, threadId, requestId)
        if (threadId) await store.recordAttachment(threadId, entry)
        return c.json(entry)
      } catch (error) {
        return c.json({ detail: formatError(error, '文件上传失败') }, 400)
      }
    })
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
