// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发文件读取快照
//
//   文件:       textFileState.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// edit_file 继承“必须先完整读取再编辑”的语义。读取快照按 thread/run
// 作用域隔离，避免模型在未看见文件内容时直接写入。

import { readFile, stat } from 'node:fs/promises'
import type { ToolContext } from '../../../framework/types.js'

interface FileReadSnapshot {
  absolutePath: string
  content: string
  mtimeMs: number
  size: number
  complete: boolean
}

const readSnapshots = new Map<string, FileReadSnapshot>()

export function recordFileRead(context: ToolContext, absolutePath: string, snapshot: FileReadSnapshot): void {
  readSnapshots.set(snapshotKey(context, absolutePath), snapshot)
}

export async function requireFreshCompleteRead(context: ToolContext, absolutePath: string): Promise<FileReadSnapshot> {
  const snapshot = readSnapshots.get(snapshotKey(context, absolutePath))
  if (!snapshot) throw new Error(`编辑前必须先完整读取文件：${absolutePath}`)
  if (!snapshot.complete) throw new Error(`最近一次读取是截断结果，编辑前请完整读取文件：${absolutePath}`)
  const stats = await stat(absolutePath)
  const current = await readUtf8TextFile(absolutePath)
  if (stats.size !== snapshot.size || current !== snapshot.content) {
    throw new Error(`文件在读取后发生变化，拒绝覆盖：${absolutePath}`)
  }
  return snapshot
}

export async function readUtf8TextFile(absolutePath: string): Promise<string> {
  const buffer = await readFile(absolutePath)
  if (looksBinary(buffer)) throw new Error(`只支持读取 UTF-8 文本文件：${absolutePath}`)
  return buffer.toString('utf8')
}

export function lineSlice(content: string, offset = 1, limit?: number): {
  content: string
  startLine: number
  lineCount: number
  totalLines: number
  truncated: boolean
} {
  const lines = content.split(/\r?\n/)
  const startLine = Math.max(1, offset)
  const startIndex = startLine - 1
  const selected = typeof limit === 'number' ? lines.slice(startIndex, startIndex + limit) : lines.slice(startIndex)
  const truncated = startIndex > 0 || selected.length < Math.max(0, lines.length - startIndex)
  return {
    content: selected.join('\n'),
    startLine,
    lineCount: selected.length,
    totalLines: lines.length,
    truncated,
  }
}

export async function textFileStats(absolutePath: string): Promise<{ mtimeMs: number; size: number }> {
  const stats = await stat(absolutePath)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

function snapshotKey(context: ToolContext, absolutePath: string): string {
  return `${context.threadId ?? context.sessionId}:${absolutePath.toLowerCase()}`
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) return true
  const replacement = sample.toString('utf8').match(/\uFFFD/g)?.length ?? 0
  return sample.length > 0 && replacement / sample.length > 0.02
}
