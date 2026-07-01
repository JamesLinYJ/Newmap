// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆路径与边界判定
//
//   文件:       paths.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { homedir } from 'node:os'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { MemoryScope } from './schemas.js'

export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPathError'
  }
}

export interface MemoryPathConfig {
  projectRoot: string
  runtimeRoot: string
  privateDir: string
  teamDir: string
}

export function createMemoryPathConfig(
  runtimeRoot: string,
  config: AgentRuntimeConfig['context'],
  projectRoot = process.cwd(),
): MemoryPathConfig {
  const projectKey = stableProjectKey(projectRoot)
  const baseDir = config.memoryBaseDir.trim()
    ? resolveConfiguredBase(config.memoryBaseDir, runtimeRoot)
    : path.join(homedir(), '.geoforge', 'projects')
  const privateDir = config.privateMemoryDir?.trim()
    ? resolveConfiguredBase(config.privateMemoryDir, runtimeRoot)
    : path.join(baseDir, projectKey, 'memory', 'private')
  const teamDir = config.teamMemoryDir?.trim()
    ? resolveConfiguredBase(config.teamMemoryDir, runtimeRoot)
    : path.join(runtimeRoot, 'memory', 'projects', projectKey, 'team')
  return {
    projectRoot: path.resolve(projectRoot),
    runtimeRoot: path.resolve(runtimeRoot),
    privateDir: ensureTrailingSeparator(path.resolve(privateDir)),
    teamDir: ensureTrailingSeparator(path.resolve(teamDir)),
  }
}

export function memoryDirectoryForScope(paths: MemoryPathConfig, scope: MemoryScope): string {
  if (scope === 'private') return paths.privateDir
  if (scope === 'team') return paths.teamDir
  throw new MemoryPathError(`作用域 "${scope}" 不是文件记忆目录`)
}

export function validateRelativeMemoryPath(relativePath: string): string {
  if (!relativePath.trim()) throw new MemoryPathError('记忆文件路径不能为空')
  if (relativePath.includes('\0')) throw new MemoryPathError('记忆文件路径包含非法空字节')
  if (relativePath.includes('\\')) throw new MemoryPathError('记忆文件路径不能包含反斜杠')
  let decoded = relativePath
  try {
    decoded = decodeURIComponent(relativePath)
  } catch {
    decoded = relativePath
  }
  if (decoded !== relativePath && (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\'))) {
    throw new MemoryPathError('记忆文件路径包含 URL 编码的路径穿越片段')
  }
  const normalizedUnicode = relativePath.normalize('NFKC')
  if (normalizedUnicode !== relativePath
    && (normalizedUnicode.includes('..') || normalizedUnicode.includes('/') || normalizedUnicode.includes('\\') || normalizedUnicode.includes('\0'))) {
    throw new MemoryPathError('记忆文件路径包含 Unicode 归一化后的路径穿越片段')
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/u.test(relativePath)) {
    throw new MemoryPathError('记忆文件路径必须是相对路径')
  }
  const normalized = path.posix.normalize(relativePath)
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new MemoryPathError('记忆文件路径不能逃逸记忆目录')
  }
  if (!normalized.endsWith('.md')) throw new MemoryPathError('记忆正文文件必须是 Markdown')
  return normalized
}

export async function resolveMemoryFilePath(
  paths: MemoryPathConfig,
  scope: MemoryScope,
  relativePath: string,
): Promise<string> {
  const root = memoryDirectoryForScope(paths, scope)
  const safeRelative = validateRelativeMemoryPath(relativePath)
  const target = path.resolve(root, ...safeRelative.split('/'))
  if (!isInsideDirectory(root, target)) {
    throw new MemoryPathError('记忆文件路径逃逸记忆目录')
  }
  const realTarget = await realpathDeepestExisting(target)
  const realRoot = await realpathOrSelf(root)
  if (!isInsideDirectory(ensureTrailingSeparator(realRoot), realTarget) && realTarget !== realRoot) {
    throw new MemoryPathError('记忆文件路径通过符号链接逃逸记忆目录')
  }
  return target
}

export function relativeMemoryPath(root: string, fullPath: string): string {
  return path.relative(root, fullPath).split(path.sep).join('/')
}

function stableProjectKey(projectRoot: string): string {
  const normalized = path.resolve(projectRoot).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')
  return normalized.replace(/^-+|-+$/gu, '') || 'workspace'
}

function resolveConfiguredBase(value: string, runtimeRoot: string): string {
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2))
  }
  return path.isAbsolute(value) ? value : path.join(runtimeRoot, value)
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`
}

function isInsideDirectory(rootWithSep: string, candidate: string): boolean {
  const root = ensureTrailingSeparator(path.resolve(rootWithSep))
  const resolved = path.resolve(candidate)
  return resolved.startsWith(root)
}

async function realpathOrSelf(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    return path.resolve(value)
  }
}

async function realpathDeepestExisting(target: string): Promise<string> {
  const tail: string[] = []
  let current = target
  for (let parent = path.dirname(current); current !== parent; parent = path.dirname(current)) {
    try {
      const realCurrent = await realpath(current)
      return tail.length ? path.join(realCurrent, ...tail.reverse()) : realCurrent
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'ENOENT') {
        try {
          const stat = await lstat(current)
          if (stat.isSymbolicLink()) throw new MemoryPathError(`发现悬空符号链接：${current}`)
        } catch (statError) {
          if (statError instanceof MemoryPathError) throw statError
        }
      } else if (code === 'ELOOP') {
        throw new MemoryPathError(`记忆路径存在符号链接循环：${current}`)
      } else if (code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
        throw new MemoryPathError(`无法验证记忆路径边界：${current}`)
      }
      tail.push(path.basename(current))
      current = parent
    }
  }
  return target
}
