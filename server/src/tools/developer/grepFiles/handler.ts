// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文本搜索工具实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import type { ToolHandler } from '../../../framework/types.js'
import { resolveDeveloperPath } from '../shared/pathPolicy.js'
import { developerResult } from '../shared/result.js'

export const grepFilesHandler: ToolHandler = async (args) => {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern 不能为空')
  const root = await resolveDeveloperPath(args.path ?? '.', { mustExist: true, expectDirectory: true })
  const headLimit = typeof args.head_limit === 'number' ? Math.max(1, Math.min(Math.floor(args.head_limit), 1000)) : 100
  const rgArgs = [
    '--line-number',
    '--column',
    '--hidden',
    '--max-columns', '500',
    '--glob', '!**/.git/**',
    '--glob', '!**/node_modules/**',
    '--glob', '!**/dist/**',
    '--glob', '!**/build/**',
    '--glob', '!**/.next/**',
  ]
  if (args.case_insensitive === true) rgArgs.push('--ignore-case')
  if (typeof args.context === 'number' && args.context > 0) rgArgs.push('--context', String(Math.min(Math.floor(args.context), 5)))
  if (typeof args.glob === 'string' && args.glob.trim()) rgArgs.push('--glob', args.glob.trim())
  rgArgs.push(args.pattern, root.absolutePath)
  const output = await runRipgrep(rgArgs)
  const lines = output.split(/\r?\n/).filter(Boolean)
  const matches = lines.slice(0, headLimit)
  return developerResult('grep_files', matches.length ? `找到 ${matches.length} 条匹配` : '未找到匹配文本', {
    root: root.absolutePath,
    relativeRoot: root.relativePath,
    pattern: args.pattern,
    glob: typeof args.glob === 'string' ? args.glob : null,
    matches,
    count: matches.length,
    truncated: lines.length > matches.length,
  }, {
    provenance: {
      access: 'read_only',
      root: root.root,
      engine: 'ripgrep',
    },
  })
}

async function runRipgrep(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('rg', args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('ripgrep 搜索超时'))
    }, 20_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(new Error(`无法启动 ripgrep：${error.message}`))
    })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code === 0 || code === 1) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() || `ripgrep 退出码 ${code}`))
    })
  })
}
