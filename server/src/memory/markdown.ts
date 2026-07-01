// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆 Markdown 解析
//
//   文件:       markdown.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import path from 'node:path'
import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from './constants.js'
import { memoryFrontmatterSchema, type MemoryFrontmatter } from './schemas.js'

const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.sql', '.sh', '.ps1', '.bat', '.cmd', '.log', '.diff', '.patch',
])

export interface ParsedMemoryMarkdown {
  frontmatter: MemoryFrontmatter | null
  content: string
  globs: string[]
  includePaths: string[]
  contentDiffersFromDisk: boolean
}

export interface EntrypointTruncation {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

export function parseMemoryMarkdown(raw: string, filePath: string, includeBasePath?: string): ParsedMemoryMarkdown {
  const ext = path.extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    return { frontmatter: null, content: '', globs: [], includePaths: [], contentDiffersFromDisk: true }
  }
  const { frontmatter, content } = parseFrontmatter(raw)
  const stripped = stripBlockHtmlComments(content)
  const includePaths = includeBasePath ? extractIncludePaths(stripped.content, includeBasePath) : []
  return {
    frontmatter,
    content: stripped.content,
    globs: normalizePathGlobs(frontmatter?.paths),
    includePaths,
    contentDiffersFromDisk: stripped.content !== raw,
  }
}

export function truncateEntrypointContent(
  raw: string,
  maxLines = MAX_ENTRYPOINT_LINES,
  maxBytes = MAX_ENTRYPOINT_BYTES,
): EntrypointTruncation {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const lineCount = lines.length
  const byteCount = Buffer.byteLength(trimmed, 'utf8')
  const wasLineTruncated = lineCount > maxLines
  const wasByteTruncated = byteCount > maxBytes
  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated ? lines.slice(0, maxLines).join('\n') : trimmed
  while (Buffer.byteLength(truncated, 'utf8') > maxBytes) {
    const cutAt = truncated.lastIndexOf('\n')
    if (cutAt <= 0) {
      truncated = truncated.slice(0, Math.max(0, maxBytes - 200))
      break
    }
    truncated = truncated.slice(0, cutAt)
  }
  const reason = wasByteTruncated && !wasLineTruncated
    ? `${byteCount} bytes，限制 ${maxBytes} bytes`
    : wasLineTruncated && !wasByteTruncated
      ? `${lineCount} 行，限制 ${maxLines} 行`
      : `${lineCount} 行且 ${byteCount} bytes`
  return {
    content: `${truncated}\n\n> 警告：MEMORY.md 已超过 ${reason}。只加载前半部分；请把索引条目保持为短句，把正文放入独立记忆文件。`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

export function formatMemoryManifest(records: Array<{ relativePath: string; type: string | null; description: string; mtimeMs: number }>): string {
  return records.map(record => {
    const tag = record.type ? `[${record.type}] ` : ''
    const ts = new Date(record.mtimeMs).toISOString()
    return record.description
      ? `- ${tag}${record.relativePath} (${ts}): ${record.description}`
      : `- ${tag}${record.relativePath} (${ts})`
  }).join('\n')
}

function parseFrontmatter(raw: string): { frontmatter: MemoryFrontmatter | null; content: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { frontmatter: null, content: raw }
  const normalized = raw.replace(/\r\n/gu, '\n')
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { frontmatter: null, content: raw }
  const block = normalized.slice(4, end)
  const content = normalized.slice(end + '\n---\n'.length)
  const parsed: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === 'paths') parsed[key] = value.includes(',') ? value.split(',').map(item => item.trim()).filter(Boolean) : value
    else parsed[key] = value.replace(/^['"]|['"]$/gu, '')
  }
  return { frontmatter: memoryFrontmatterSchema.parse(parsed), content }
}

function stripBlockHtmlComments(content: string): { content: string; stripped: boolean } {
  if (!content.includes('<!--')) return { content, stripped: false }
  const lines = content.split('\n')
  const output: string[] = []
  let inFence = false
  let inComment = false
  let stripped = false
  for (const line of lines) {
    if (/^\s*```/u.test(line) || /^\s*~~~/u.test(line)) {
      inFence = !inFence
      output.push(line)
      continue
    }
    if (inFence) {
      output.push(line)
      continue
    }
    let next = line
    while (next.includes('<!--') || inComment) {
      const start = inComment ? 0 : next.indexOf('<!--')
      const end = next.indexOf('-->', start)
      if (start < 0) break
      stripped = true
      if (end < 0) {
        next = next.slice(0, start)
        inComment = true
        break
      }
      next = `${next.slice(0, start)}${next.slice(end + 3)}`
      inComment = false
    }
    if (!inComment && next.trim()) output.push(next)
    else if (!inComment && line.trim() === next.trim()) output.push(next)
  }
  return { content: output.join('\n'), stripped }
}

function extractIncludePaths(content: string, basePath: string): string[] {
  const includes = new Set<string>()
  let inFence = false
  for (const line of content.split('\n')) {
    if (/^\s*```/u.test(line) || /^\s*~~~/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const withoutInlineCode = line.replace(/`[^`]*`/gu, '')
    const pattern = /(?:^|\s)@((?:[^\s\\]|\\ )+)/gu
    let match: RegExpExecArray | null
    while ((match = pattern.exec(withoutInlineCode)) !== null) {
      let value = match[1]?.replace(/\\ /gu, ' ') ?? ''
      const hash = value.indexOf('#')
      if (hash >= 0) value = value.slice(0, hash)
      if (!value || value.startsWith('@')) continue
      if (value.startsWith('~/')) {
        includes.add(path.join(process.env.USERPROFILE || process.env.HOME || '', value.slice(2)))
      } else if (path.isAbsolute(value) || /^[A-Za-z]:\//u.test(value)) {
        includes.add(path.resolve(value))
      } else if (value.startsWith('/')) {
        includes.add(path.resolve(process.cwd(), value.slice(1)))
      } else {
        includes.add(path.resolve(path.dirname(basePath), value.replace(/^\.\//u, '')))
      }
    }
  }
  return [...includes]
}

function normalizePathGlobs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return raw.flatMap(item => String(item).split(','))
    .map(item => item.trim().replace(/\/\*\*$/u, ''))
    .filter(item => item && item !== '**')
}
