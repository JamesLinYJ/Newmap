import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makeId, nowUtc } from '../utils/ids.js'

export interface StoredFileEntry {
  id: string
  name: string
  size: string
  sizeBytes: number
  uploadedAt: string
  status: string
  threadId: string | null
  relativePath: string
}

interface StoredFileMetadata {
  id: string
  name: string
  sizeBytes: number
  uploadedAt: string
  status: string
  threadId: string | null
  relativePath: string
}

export class RuntimeFileStore {
  private readonly root: string

  constructor(runtimeRoot: string) {
    this.root = path.resolve(runtimeRoot, 'uploads', 'files')
  }

  async list(threadId?: string | null): Promise<StoredFileEntry[]> {
    await mkdir(this.root, { recursive: true })
    const scopes = threadId ? [scopeName(threadId)] : await listDirectories(this.root)
    const entries: StoredFileEntry[] = []
    for (const scope of scopes) {
      const scopeDir = path.join(this.root, scope)
      for (const metaName of await listMetadataFiles(scopeDir)) {
        const metadata = await readMetadata(path.join(scopeDir, metaName))
        if (!metadata) continue
        if (threadId && metadata.threadId !== threadId) continue
        entries.push(toEntry(metadata))
      }
    }
    return entries.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
  }

  async save(file: FileLike, threadId?: string | null): Promise<StoredFileEntry> {
    const id = makeId('file')
    const uploadedAt = nowUtc()
    const cleanName = sanitizeFilename(file.name || id)
    const scope = scopeName(threadId)
    const dir = path.join(this.root, scope, id)
    await mkdir(dir, { recursive: true })
    const bytes = Buffer.from(await file.arrayBuffer())
    const relativePath = path.posix.join('uploads', 'files', scope, id, cleanName)
    await writeFile(path.join(dir, cleanName), bytes)
    const metadata: StoredFileMetadata = {
      id,
      name: cleanName,
      sizeBytes: bytes.byteLength,
      uploadedAt,
      status: 'ready',
      threadId: threadId ?? null,
      relativePath,
    }
    await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8')
    return toEntry(metadata)
  }

  async delete(fileId: string, threadId?: string | null): Promise<boolean> {
    await mkdir(this.root, { recursive: true })
    const scopes = threadId ? [scopeName(threadId)] : await listDirectories(this.root)
    for (const scope of scopes) {
      const dir = path.join(this.root, scope, fileId)
      try {
        await stat(dir)
        await rm(dir, { recursive: true, force: true })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return false
  }
}

export interface FileLike {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
}

function toEntry(metadata: StoredFileMetadata): StoredFileEntry {
  return {
    id: metadata.id,
    name: metadata.name,
    size: formatBytes(metadata.sizeBytes),
    sizeBytes: metadata.sizeBytes,
    uploadedAt: metadata.uploadedAt,
    status: metadata.status,
    threadId: metadata.threadId,
    relativePath: metadata.relativePath,
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function listMetadataFiles(scopeDir: string): Promise<string[]> {
  const dirs = await listDirectories(scopeDir)
  return dirs.map(dir => path.join(dir, 'metadata.json'))
}

async function readMetadata(filePath: string): Promise<StoredFileMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    if (!isRecord(parsed)) return null
    return {
      id: String(parsed.id ?? ''),
      name: String(parsed.name ?? ''),
      sizeBytes: Number(parsed.sizeBytes ?? 0),
      uploadedAt: String(parsed.uploadedAt ?? ''),
      status: String(parsed.status ?? 'ready'),
      threadId: typeof parsed.threadId === 'string' ? parsed.threadId : null,
      relativePath: String(parsed.relativePath ?? ''),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function scopeName(threadId?: string | null): string {
  return threadId?.trim() || '__global__'
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_')
  return base || 'upload.bin'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
