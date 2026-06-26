// +-------------------------------------------------------------------------
//
//   地理智能平台 - 读取文件工具实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolHandler } from '../../../framework/types.js'
import { resolveDeveloperPath } from '../shared/pathPolicy.js'
import { developerResult } from '../shared/result.js'
import { lineSlice, readUtf8TextFile, recordFileRead, textFileStats } from '../shared/textFileState.js'

export const readFileHandler: ToolHandler = async (args, context) => {
  const target = await resolveDeveloperPath(args.file_path, { mustExist: true, expectDirectory: false })
  const content = await readUtf8TextFile(target.absolutePath)
  const offset = typeof args.offset === 'number' ? Math.floor(args.offset) : 1
  const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : undefined
  const sliced = lineSlice(content, offset, limit)
  const stats = await textFileStats(target.absolutePath)
  recordFileRead(context, target.absolutePath, {
    absolutePath: target.absolutePath,
    content,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    complete: !sliced.truncated,
  })
  return developerResult('read_file', `已读取 ${target.relativePath}`, {
    filePath: target.absolutePath,
    relativePath: target.relativePath,
    content: sliced.content,
    startLine: sliced.startLine,
    lineCount: sliced.lineCount,
    totalLines: sliced.totalLines,
    truncated: sliced.truncated,
  }, {
    provenance: {
      access: 'read_only',
      root: target.root,
      snapshotComplete: !sliced.truncated,
    },
  })
}
