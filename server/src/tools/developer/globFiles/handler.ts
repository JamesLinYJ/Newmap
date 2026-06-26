// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件模式搜索实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolHandler } from '../../../framework/types.js'
import { globFiles } from '../shared/glob.js'
import { resolveDeveloperPath } from '../shared/pathPolicy.js'
import { developerResult } from '../shared/result.js'

export const globFilesHandler: ToolHandler = async (args) => {
  if (typeof args.pattern !== 'string' || !args.pattern.trim()) throw new Error('pattern 不能为空')
  const root = await resolveDeveloperPath(args.path ?? '.', { mustExist: true, expectDirectory: true })
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 1000)) : 100
  const { matches, truncated } = await globFiles(root.absolutePath, args.pattern, limit)
  return developerResult('glob_files', matches.length ? `找到 ${matches.length} 个文件` : '未找到匹配文件', {
    root: root.absolutePath,
    relativeRoot: root.relativePath,
    pattern: args.pattern,
    matches,
    count: matches.length,
    truncated,
  }, {
    provenance: {
      access: 'read_only',
      root: root.root,
    },
  })
}
