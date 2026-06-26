// +-------------------------------------------------------------------------
//
//   地理智能平台 - 写入文件工具实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolHandler } from '../../../framework/types.js'
import { resolveDeveloperPath } from '../shared/pathPolicy.js'
import { developerResult } from '../shared/result.js'

export const writeFileHandler: ToolHandler = async (args) => {
  if (typeof args.content !== 'string') throw new Error('content 必须是字符串')
  const target = await resolveDeveloperPath(args.file_path, { forWrite: true, createParentDirs: args.create_parent_dirs === true })
  let existed = false
  try {
    const stats = await stat(target.absolutePath)
    existed = stats.isFile()
  } catch {
    existed = false
  }
  if (existed && args.overwrite !== true) {
    throw new Error(`文件已存在，写入前必须显式设置 overwrite=true：${target.absolutePath}`)
  }
  if (args.create_parent_dirs === true) await mkdir(path.dirname(target.absolutePath), { recursive: true })
  await writeFile(target.absolutePath, args.content, 'utf8')
  return developerResult('write_file', existed ? `已覆盖 ${target.relativePath}` : `已创建 ${target.relativePath}`, {
    filePath: target.absolutePath,
    relativePath: target.relativePath,
    bytesWritten: Buffer.byteLength(args.content, 'utf8'),
    created: !existed,
    overwritten: existed,
  }, {
    provenance: {
      access: 'write',
      root: target.root,
      diffSummary: existed ? 'whole-file overwrite' : 'new file',
    },
  })
}
