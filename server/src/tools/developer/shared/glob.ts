// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发文件匹配
//
//   文件:       glob.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 这里实现受控 glob，不走 shell 展开。目录遍历跳过常见依赖和 VCS 目录，
// 输出稳定排序并由调用方截断。

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { toPortablePath } from './pathPolicy.js'

const SKIPPED_DIRS = new Set(['.git', '.hg', '.svn', '.jj', 'node_modules', 'dist', 'build', '.next', '.vite'])

export async function globFiles(root: string, pattern: string, limit: number): Promise<{ matches: string[]; truncated: boolean }> {
  if (path.isAbsolute(pattern)) throw new Error('glob pattern 必须是相对路径；请用 path 指定搜索根目录')
  const regex = globToRegex(toPortablePath(pattern))
  const matches: string[] = []
  await walk(root, root, regex, matches, Math.max(1, limit) + 1)
  matches.sort((a, b) => a.localeCompare(b))
  const truncated = matches.length > limit
  return { matches: truncated ? matches.slice(0, limit) : matches, truncated }
}

async function walk(root: string, current: string, regex: RegExp, matches: string[], hardLimit: number): Promise<void> {
  if (matches.length >= hardLimit) return
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (matches.length >= hardLimit) return
    if (entry.isSymbolicLink()) continue
    const absolutePath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      await walk(root, absolutePath, regex, matches, hardLimit)
      continue
    }
    if (!entry.isFile()) continue
    const relative = toPortablePath(path.relative(root, absolutePath))
    if (regex.test(relative)) matches.push(relative)
  }
}

function globToRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    if (char === '*' && next === '*') {
      const after = pattern[index + 2]
      if (after === '/') {
        source += '(?:.*\\/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end > index) {
        const alternatives = pattern.slice(index + 1, end).split(',').map(escapeRegex).join('|')
        source += `(?:${alternatives})`
        index = end
        continue
      }
    }
    source += escapeRegex(char)
  }
  source += '$'
  return new RegExp(source)
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}
