// +-------------------------------------------------------------------------
//
//   地理智能平台 - 编辑文件工具实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises'
import type { ToolHandler } from '../../../framework/types.js'
import { resolveDeveloperPath } from '../shared/pathPolicy.js'
import { developerResult } from '../shared/result.js'
import { recordFileRead, requireFreshCompleteRead, textFileStats } from '../shared/textFileState.js'

export const editFileHandler: ToolHandler = async (args, context) => {
  if (typeof args.old_string !== 'string' || !args.old_string) throw new Error('old_string 不能为空')
  if (typeof args.new_string !== 'string') throw new Error('new_string 必须是字符串')
  if (args.old_string === args.new_string) throw new Error('old_string 与 new_string 不能相同')
  const target = await resolveDeveloperPath(args.file_path, { mustExist: true, expectDirectory: false })
  const snapshot = await requireFreshCompleteRead(context, target.absolutePath)
  const matches = countOccurrences(snapshot.content, args.old_string)
  if (matches === 0) throw new Error(`未找到 old_string，文件未修改：${target.absolutePath}`)
  if (matches > 1 && args.replace_all !== true) {
    throw new Error(`old_string 匹配 ${matches} 处；请提供更精确文本或显式设置 replace_all=true`)
  }
  const updated = args.replace_all === true
    ? snapshot.content.split(args.old_string).join(args.new_string)
    : snapshot.content.replace(args.old_string, args.new_string)
  await writeFile(target.absolutePath, updated, 'utf8')
  const stats = await textFileStats(target.absolutePath)
  recordFileRead(context, target.absolutePath, {
    absolutePath: target.absolutePath,
    content: updated,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    complete: true,
  })
  const diffSummary = `${matches} replacement${matches === 1 ? '' : 's'} in ${target.relativePath}`
  return developerResult('edit_file', `已编辑 ${target.relativePath}（${matches} 处）`, {
    filePath: target.absolutePath,
    relativePath: target.relativePath,
    replacements: matches,
    diffSummary,
  }, {
    provenance: {
      access: 'write',
      root: target.root,
      diffSummary,
    },
  })
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let position = 0
  while (true) {
    const next = content.indexOf(needle, position)
    if (next === -1) return count
    count += 1
    position = next + needle.length
  }
}
