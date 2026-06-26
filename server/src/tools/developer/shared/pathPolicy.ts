// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发工具路径安全边界
//
//   文件:       pathPolicy.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 文件工具的事实边界是 DEVELOPER_TOOL_ALLOWED_ROOTS 与 RUNTIME_ROOT。
// 所有路径先规范化，再用 realpath 校验符号链接，禁止 UNC、设备路径和越界父目录。

import { access, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface DeveloperPath {
  requestedPath: string
  absolutePath: string
  root: string
  relativePath: string
}

export interface PathPolicyConfig {
  DEVELOPER_TOOL_ALLOWED_ROOTS?: string
  RUNTIME_ROOT?: string
}

const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

export function parseAllowedRoots(config: PathPolicyConfig = process.env): string[] {
  const rawRoots = [
    ...(config.DEVELOPER_TOOL_ALLOWED_ROOTS ?? '').split(';'),
    config.RUNTIME_ROOT ?? '',
  ]
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value))

  return [...new Map(rawRoots.map(root => [caseKey(root), root])).values()]
}

export function assertDeveloperRootsConfigured(config: PathPolicyConfig): string[] {
  if (!config.DEVELOPER_TOOL_ALLOWED_ROOTS?.trim()) {
    throw new Error('缺少 DEVELOPER_TOOL_ALLOWED_ROOTS，开发工具 Provider 不可用')
  }
  const roots = parseAllowedRoots(config)
  if (!roots.length) throw new Error('DEVELOPER_TOOL_ALLOWED_ROOTS 没有可用根目录')
  return roots
}

export async function ensureConfiguredRootsExist(config: PathPolicyConfig): Promise<void> {
  for (const root of assertDeveloperRootsConfigured(config)) {
    await access(root)
  }
}

export async function resolveDeveloperPath(
  requestedPath: unknown,
  options: {
    mustExist?: boolean
    expectDirectory?: boolean
    forWrite?: boolean
    createParentDirs?: boolean
    roots?: string[]
  } = {},
): Promise<DeveloperPath> {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new Error('路径不能为空')
  rejectUnsafeWindowsPath(requestedPath)
  const roots = options.roots?.length ? options.roots.map(root => path.resolve(root)) : parseAllowedRoots()
  if (!roots.length) throw new Error('开发工具没有配置允许访问的根目录')

  const defaultRoot = roots[0]
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(defaultRoot, requestedPath)
  rejectUnsafeWindowsPath(absolutePath)
  const root = roots.find(candidate => isInsidePath(absolutePath, candidate))
  if (!root) throw new Error(`路径不在允许根目录内：${absolutePath}`)

  if (options.mustExist) {
    const realTarget = await realpath(absolutePath)
    const realRoot = await realpath(root)
    if (!isInsidePath(realTarget, realRoot)) throw new Error(`路径符号链接越出允许根目录：${absolutePath}`)
    const stats = await stat(realTarget)
    if (options.expectDirectory === true && !stats.isDirectory()) throw new Error(`路径不是目录：${absolutePath}`)
    if (options.expectDirectory === false && !stats.isFile()) throw new Error(`路径不是文件：${absolutePath}`)
  } else if (options.forWrite) {
    const parent = await closestExistingParent(path.dirname(absolutePath), root)
    const realParent = await realpath(parent)
    const realRoot = await realpath(root)
    if (!isInsidePath(realParent, realRoot)) throw new Error(`写入父目录符号链接越出允许根目录：${absolutePath}`)
    await assertExistingWriteTargetInsideRoot(absolutePath, realRoot)
    if (path.dirname(absolutePath) !== parent) {
      if (!options.createParentDirs) throw new Error(`写入父目录不存在：${path.dirname(absolutePath)}`)
      await mkdir(path.dirname(absolutePath), { recursive: true })
    }
  }

  return {
    requestedPath,
    absolutePath,
    root,
    relativePath: path.relative(root, absolutePath) || '.',
  }
}

export function isInsidePath(candidate: string, root: string): boolean {
  const normalizedCandidate = trimTrailingSeparator(path.resolve(candidate))
  const normalizedRoot = trimTrailingSeparator(path.resolve(root))
  const candidateKey = caseKey(normalizedCandidate)
  const rootKey = caseKey(normalizedRoot)
  return candidateKey === rootKey || candidateKey.startsWith(rootKey + path.sep)
}

export function toPortablePath(value: string): string {
  return value.split(path.sep).join('/')
}

async function closestExistingParent(parentPath: string, root: string): Promise<string> {
  let current = path.resolve(parentPath)
  const resolvedRoot = path.resolve(root)
  while (isInsidePath(current, resolvedRoot)) {
    try {
      const stats = await stat(current)
      if (stats.isDirectory()) return current
    } catch {
      current = path.dirname(current)
      continue
    }
    throw new Error(`写入父路径不是目录：${current}`)
  }
  throw new Error(`写入父目录不在允许根目录内：${parentPath}`)
}

async function assertExistingWriteTargetInsideRoot(absolutePath: string, realRoot: string): Promise<void> {
  try {
    const realTarget = await realpath(absolutePath)
    if (!isInsidePath(realTarget, realRoot)) throw new Error(`写入目标符号链接越出允许根目录：${absolutePath}`)
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function rejectUnsafeWindowsPath(value: string): void {
  if (/^\\\\/.test(value)) throw new Error(`不允许访问 UNC 路径：${value}`)
  if (/^\\\\[.?]\\/.test(value)) throw new Error(`不允许访问 Windows 设备路径：${value}`)
  for (const segment of value.split(/[\\/]+/)) {
    const name = segment.split('.')[0]?.toUpperCase()
    if (name && RESERVED_WINDOWS_NAMES.has(name)) throw new Error(`不允许访问 Windows 保留设备名：${segment}`)
  }
}

function trimTrailingSeparator(value: string): string {
  const parsed = path.parse(value)
  if (value === parsed.root) return value
  return value.replace(/[\\/]+$/, '')
}

function caseKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
