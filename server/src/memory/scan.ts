// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆文件扫描
//
//   文件:       scan.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { FRONTMATTER_MAX_LINES, MAX_MEMORY_FILES, MEMORY_ENTRYPOINT_NAME } from './constants.js'
import { parseMemoryMarkdown, formatMemoryManifest } from './markdown.js'
import { relativeMemoryPath } from './paths.js'
import { memoryFileRecordSchema, type MemoryFileRecord, type MemoryScope } from './schemas.js'

export async function scanMemoryFiles(root: string, scope: MemoryScope): Promise<MemoryFileRecord[]> {
  const files = await listMarkdownFiles(root).catch(() => [])
  const records = await Promise.allSettled(files
    .filter(file => path.basename(file) !== MEMORY_ENTRYPOINT_NAME)
    .map(file => readMemoryHeader(root, file, scope)))
  return records
    .filter((result): result is PromiseFulfilledResult<MemoryFileRecord> => result.status === 'fulfilled')
    .map(result => result.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

export async function readMemoryRecord(root: string, filePath: string, scope: MemoryScope): Promise<MemoryFileRecord> {
  const [raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
  const parsed = parseMemoryMarkdown(raw, filePath, filePath)
  if (!parsed.frontmatter) throw new Error(`记忆文件缺少 frontmatter：${filePath}`)
  return memoryFileRecordSchema.parse({
    path: filePath,
    relativePath: relativeMemoryPath(root, filePath),
    scope,
    type: parsed.frontmatter.type,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    mtimeMs: info.mtimeMs,
    content: parsed.content,
    globs: parsed.globs,
    contentDiffersFromDisk: parsed.contentDiffersFromDisk,
  })
}

export { formatMemoryManifest }

async function readMemoryHeader(root: string, filePath: string, scope: MemoryScope): Promise<MemoryFileRecord> {
  const [raw, info] = await Promise.all([readHeader(filePath), stat(filePath)])
  const parsed = parseMemoryMarkdown(raw, filePath)
  return memoryFileRecordSchema.parse({
    path: filePath,
    relativePath: relativeMemoryPath(root, filePath),
    scope,
    type: parsed.frontmatter?.type ?? null,
    name: parsed.frontmatter?.name ?? path.basename(filePath, '.md'),
    description: parsed.frontmatter?.description ?? '',
    mtimeMs: info.mtimeMs,
    globs: parsed.globs,
    contentDiffersFromDisk: parsed.contentDiffersFromDisk,
  })
}

async function readHeader(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf8')
  return raw.split(/\r?\n/u).slice(0, FRONTMATTER_MAX_LINES).join('\n')
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
  }
  await visit(root)
  return files
}
