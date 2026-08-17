// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Forge 跨平台 ZIP 打包器
//
//   文件:       desktopZipMaker.mjs
//
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import { ZipArchive } from 'archiver'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertPortableClientPayload,
  stagePortableClientDirectory,
} from './desktopPortablePayload.mjs'

export class DesktopZipMaker extends MakerBase {
  name = 'desktop-zip'
  defaultPlatforms = ['win32', 'darwin', 'linux']

  isSupportedOnCurrentPlatform() {
    return true
  }

  async make({ dir, makeDir, packageJSON, targetArch, targetPlatform }) {
    const portableSuffix = targetPlatform === 'linux' ? '-remote-client' : ''
    const baseName = path.basename(dir).replace(/\.app$/iu, '')
    const zipName = `${baseName}-${packageJSON.version}-${targetPlatform}-${targetArch}${portableSuffix}.zip`
    const zipPath = path.resolve(makeDir, 'zip', targetPlatform, targetArch, zipName)
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-zip-'))
    try {
      if (targetPlatform === 'darwin') {
        const sourceApp = await resolveMacApplication(dir)
        const stagedApp = path.join(temporaryRoot, path.basename(sourceApp))
        runRequired('ditto', [sourceApp, stagedApp], 'macOS 应用暂存')
        await assertPortableClientPayload(stagedApp, 'darwin')
        await createMacZipArchive(stagedApp, zipPath)
      } else {
        const archiveRoot = path.join(temporaryRoot, 'payload')
        await stagePortableClientDirectory(dir, archiveRoot, targetPlatform)
        await createZipArchive(archiveRoot, zipPath)
      }
      return [zipPath]
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }
}

/**
 * Windows/Linux ZIP 生成边界归项目所有，避免 Forge maker-zip 间接依赖
 * cross-zip 的 Node 25 不兼容文件系统调用。归档失败时删除半成品。
 */
export async function createZipArchive(sourceDirectory, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true })
  await rm(destinationPath, { force: true })

  const output = createWriteStream(destinationPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const succeed = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const fail = error => {
        if (settled) return
        settled = true
        output.destroy()
        archive.abort()
        reject(error)
      }
      output.once('close', succeed)
      output.once('error', fail)
      archive.once('error', fail)
      archive.once('warning', fail)
      archive.pipe(output)
      archive.directory(sourceDirectory, false)
      archive.finalize().catch(fail)
    })
  } catch (error) {
    await rm(destinationPath, { force: true })
    throw error
  }
  await assertNonemptyZip(destinationPath)
}

/**
 * macOS ZIP 必须使用 ditto 保存 bundle 符号链接、资源分支与 notarization
 * staple 元数据；用通用 ZIP 库复制已签名 .app 会破坏离线 Gatekeeper 语义。
 */
export async function createMacZipArchive(applicationPath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true })
  await rm(destinationPath, { force: true })
  runRequired('ditto', [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    applicationPath,
    destinationPath,
  ], 'macOS ZIP 构建')
  await assertNonemptyZip(destinationPath)
}

async function assertNonemptyZip(file) {
  const metadata = await lstat(file).catch(() => null)
  if (!metadata?.isFile() || metadata.size <= 0) throw new Error('ZIP 构建未生成有效文件。')
}

async function resolveMacApplication(directory) {
  const metadata = await lstat(directory)
  if (metadata.isDirectory() && directory.toLowerCase().endsWith('.app')) return directory
  if (!metadata.isDirectory()) throw new Error('macOS ZIP 源不是目录。')
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
    .map(entry => path.join(directory, entry.name))
  if (candidates.length !== 1) {
    throw new Error(`macOS ZIP 源必须且只能包含一个 .app，实际为 ${candidates.length} 个。`)
  }
  return candidates[0]
}

function runRequired(file, args, label) {
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`${label}失败：${file} ${args.join(' ')}`)
  }
}
