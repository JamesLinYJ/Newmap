import { Hono } from 'hono'
import { RuntimeFileStore, type FileLike } from '../store/fileStore.js'

export function fileRoutes(runtimeRoot: string) {
  const files = new RuntimeFileStore(runtimeRoot)

  return new Hono()
    .get('/api/v1/files', async (c) => {
      const threadId = c.req.query('threadId') ?? null
      const entries = await files.list(threadId)
      return c.json({ files: entries, total: entries.length })
    })
    .post('/api/v1/files/upload', async (c) => {
      try {
        const form = await c.req.formData()
        const file = requireFile(form.get('file'))
        const threadId = formString(form, 'threadId')
        const entry = await files.save(file, threadId)
        return c.json(entry)
      } catch (error) {
        return c.json({ detail: formatError(error, '文件上传失败') }, 400)
      }
    })
    .delete('/api/v1/files/:fileId', async (c) => {
      const threadId = c.req.query('threadId') ?? null
      const deleted = await files.delete(c.req.param('fileId'), threadId)
      if (!deleted) return c.json({ detail: '文件不存在' }, 404)
      return c.json({ deleted: true, id: c.req.param('fileId') })
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
