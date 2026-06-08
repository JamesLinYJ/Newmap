// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool Loader（发现 + 加载 TS/Python providers）
//
//   文件:       loader.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getEnv } from './env.js'
import { toolRegistry } from './registry.js'
import type { ToolProvider, ToolManifest, InstallContext, ToolResult } from './types.js'

// discoverAndLoad——主入口，发现并加载所有 ToolProvider
export async function discoverAndLoad(): Promise<void> {
  const env = getEnv()
  const envStr: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v == null ? undefined : String(v)])
  )

  // 1. TS 内置 tools：扫描 tools/ 目录
  const builtinDir = path.resolve(import.meta.dirname, '..', 'tools')
  await loadFromDir(builtinDir, envStr)

  // 2. 额外 TS tool 目录
  if (envStr.TOOL_DIRS) {
    for (const dir of envStr.TOOL_DIRS.split(',').map(d => d.trim()).filter(Boolean)) {
      await loadFromDir(path.resolve(dir), envStr)
    }
  }

  // 3. Python tools：HTTP 发现
  const pythonUrls = [envStr.WORKER_URL, ...(envStr.PYTHON_TOOLS?.split(',').map(s => s.trim()).filter(Boolean) ?? [])]
  for (const url of new Set(pythonUrls)) {
    if (!url) continue
    await loadPythonTools(url, envStr)
  }

  console.log(`[loader] 共加载 ${toolRegistry.listProviders().length} 个 provider, ${toolRegistry.list().length} 个 tool`)
}

// loadFromDir — 扫描目录，每个子目录作为一个 ToolProvider
async function loadFromDir(dir: string, env: Record<string, string | undefined>): Promise<void> {
  let entries: import('fs').Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) as import('fs').Dirent[] }
  catch { return }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue

    const providerDir = path.join(dir, entry.name)
    try {
      const manifestPath = path.join(providerDir, 'manifest.json')
      const manifestRaw = await readFile(manifestPath, 'utf8')
      const manifest = JSON.parse(manifestRaw) as ToolManifest

      // 检查依赖
      let skip = false
      if (manifest.requires) {
        for (const [key, level] of Object.entries(manifest.requires)) {
          if (level === 'required' && !env[key]) {
            console.warn(`[loader] 跳过 "${manifest.id}": 缺少 ${key}`)
            skip = true; break
          }
        }
      }
      if (skip) continue

      // TS 模块
      if (manifest.language === 'typescript') {
        const mod = await import(`file://${path.join(providerDir, 'index.ts')}`)
        const provider: ToolProvider = mod.default ?? mod
        const ctx: InstallContext = {
          config: { ...env },
          state: new Map(),
          log: (level, msg) => console.log(`[${manifest.id}] ${level}: ${msg}`),
        }
        await provider.onInstall?.(ctx)
        toolRegistry.register(provider)
      }
    } catch (err) {
      console.warn(`[loader] 加载 "${entry.name}" 失败:`, (err as Error).message)
    }
  }
}

// loadPythonTools — HTTP 发现 Python ToolProvider
async function loadPythonTools(baseUrl: string, env: Record<string, string | undefined>): Promise<void> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest`)
    if (!res.ok) return
    const manifest = await res.json() as ToolManifest
    manifest.language = 'python'
    manifest.endpoint = baseUrl

    const provider: ToolProvider = {
      manifest,
      tools: () => manifest.tools.map(t => ({
        ...t,
        jsonSchema: t.jsonSchema ?? {},
        handler: async (args, ctx): Promise<ToolResult> => {
          const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tools/${t.name}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ args, context: { runId: ctx.runId, sessionId: ctx.sessionId, threadId: ctx.threadId } }),
          })
          if (!res.ok) throw new Error(`Python tool "${t.name}" 返回 ${res.status}`)
          return res.json() as Promise<ToolResult>
        },
        providerId: manifest.id,
        language: 'python' as const,
      })),
    }

    toolRegistry.register(provider)
  } catch (err) {
    console.warn(`[loader] Python tools "${baseUrl}" 不可用:`, (err as Error).message)
  }
}
