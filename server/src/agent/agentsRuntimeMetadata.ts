// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行元数据
//
//   文件:       agentsRuntimeMetadata.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AgentRuntimeConfig } from '../schemas/types.js'

export const SDK_STATE_SCHEMA_VERSION = 1

let versionPromise: Promise<string> | null = null

export function agentsSdkVersion(): Promise<string> {
  versionPromise ??= readInstalledVersion()
  return versionPromise
}

export function runtimeConfigDigest(config: AgentRuntimeConfig): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex')
}

async function readInstalledVersion(): Promise<string> {
  const entryUrl = import.meta.resolve('@openai/agents')
  const packageUrl = new URL('../package.json', entryUrl)
  const parsed = JSON.parse(await readFile(fileURLToPath(packageUrl), 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || !parsed.version) throw new Error('无法读取 @openai/agents 安装版本')
  return parsed.version
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
