// +-------------------------------------------------------------------------
//
//   地理智能平台 - 通用线程文件存储
//
//   文件:       fileStore.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
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
  contentHash: string
  mediaType: string
}

interface StoredFileMetadata {
  id: string
  name: string
  sizeBytes: number
  uploadedAt: string
  status: string
  threadId: string | null
  relativePath: string
  contentHash: string
  mediaType: string
}

export class RuntimeFileStore {
  private readonly root: string
  private readonly objectRoot: string

  constructor(runtimeRoot: string) {
    this.root = path.resolve(runtimeRoot, 'uploads', 'files')
    this.objectRoot = path.resolve(runtimeRoot, 'objects', 'sha256')
  }

  async list(threadId?: string | null): Promise<StoredFileEntry[]> {
    await mkdir(this.root, { recursive: true })
    const scopes = threadId ? [scopeName(threadId)] : await listDirectories(this.root)
    const entries: StoredFileEntry[] = []
    for (const scope of scopes) {
      const scopeDir = path.join(this.root, scope)
      for (const metaName of await listMetadataFiles(scopeDir)) {
        const metadata = await readMetadata(metaName)
        if (!metadata) continue
        if (threadId && metadata.threadId !== threadId) continue
        entries.push(toEntry(metadata))
      }
    }
    const sorted = entries.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
    const seen = new Set<string>()
    return sorted.filter(entry => {
      const key = `${entry.threadId ?? '__global__'}:${entry.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async save(file: FileLike, threadId?: string | null, requestId?: string | null): Promise<StoredFileEntry> {
    const uploadedAt = nowUtc()
    const cleanName = sanitizeFilename(file.name || 'upload.bin')
    const scope = scopeName(threadId)
    // 线程文件按名称覆盖；requestId 同时保证连接中断后的重试落到同一条目。
    const existing = await findMetadataByName(path.join(this.root, scope), cleanName)
    const id = existing?.id ?? (requestId?.trim() ? safePathSegment(requestId, 'requestId') : makeId('file'))
    const dir = path.join(this.root, scope, id)
    await mkdir(dir, { recursive: true })
    const bytes = Buffer.from(await file.arrayBuffer())
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    // 内容哈希仍是对象身份；原始安全扩展名进入对象路径，避免气象、
    // GeoJSON、雷达等后缀敏感 reader 在 runtime hash 文件上误判格式。
    const objectName = `${contentHash}${safeObjectExtension(cleanName)}`
    const relativePath = path.posix.join('objects', 'sha256', contentHash.slice(0, 2), objectName)
    const objectPath = path.join(this.objectRoot, contentHash.slice(0, 2), objectName)
    await mkdir(path.dirname(objectPath), { recursive: true })
    try {
      await writeFile(objectPath, bytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const metadata: StoredFileMetadata = {
      id,
      name: cleanName,
      sizeBytes: bytes.byteLength,
      uploadedAt,
      status: 'ready',
      threadId: threadId ?? null,
      relativePath,
      contentHash,
      mediaType: inferMediaType(cleanName),
    }
    await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8')
    return toEntry(metadata)
  }

  async delete(fileId: string, threadId?: string | null): Promise<boolean> {
    await mkdir(this.root, { recursive: true })
    const safeFileId = safePathSegment(fileId, 'fileId')
    const scopes = threadId ? [scopeName(threadId)] : await listDirectories(this.root)
    for (const scope of scopes) {
      const dir = path.join(this.root, scope, safeFileId)
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

  // 分支复用同一内容寻址对象，只复制线程级 metadata，不复制大文件。
  async cloneThreadFiles(sourceThreadId: string, targetThreadId: string): Promise<StoredFileEntry[]> {
    const sourceEntries = await this.list(sourceThreadId)
    const copied: StoredFileEntry[] = []
    for (const entry of sourceEntries) {
      const metadata: StoredFileMetadata = {
        id: entry.id,
        name: entry.name,
        sizeBytes: entry.sizeBytes,
        uploadedAt: entry.uploadedAt,
        status: entry.status,
        threadId: targetThreadId,
        relativePath: entry.relativePath,
        contentHash: entry.contentHash,
        mediaType: entry.mediaType,
      }
      const directory = path.join(this.root, scopeName(targetThreadId), entry.id)
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8')
      copied.push(toEntry(metadata))
    }
    return copied
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
    contentHash: metadata.contentHash,
    mediaType: metadata.mediaType,
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
  return dirs.map(dir => path.join(scopeDir, dir, 'metadata.json'))
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
      contentHash: String(parsed.contentHash ?? ''),
      mediaType: String(parsed.mediaType ?? 'application/octet-stream'),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function scopeName(threadId?: string | null): string {
  return threadId?.trim() ? safePathSegment(threadId, 'threadId') : '__global__'
}

async function findMetadataByName(scopeDir: string, name: string): Promise<StoredFileMetadata | null> {
  for (const metadataPath of await listMetadataFiles(scopeDir)) {
    const metadata = await readMetadata(metadataPath)
    if (metadata?.name === name) return metadata
  }
  return null
}

function safePathSegment(value: string, field: string): string {
  const segment = value.trim()
  if (!segment || !/^[A-Za-z0-9_-]+$/u.test(segment)) throw new Error(`${field} 不是合法标识符`)
  return segment
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_')
  return base || 'upload.bin'
}

function safeObjectExtension(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return /^[.][a-z0-9]{1,12}$/u.test(ext) ? ext : ''
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function inferMediaType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json') || lower.endsWith('.geojson')) return 'application/json'
  if (lower.endsWith('.nc') || lower.endsWith('.nc4')) return 'application/x-netcdf'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff'
  if (lower.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
