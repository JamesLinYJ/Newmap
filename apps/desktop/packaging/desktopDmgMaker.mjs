// +-------------------------------------------------------------------------
//
//   地理智能平台 - macOS DMG Maker
//
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertPortableClientPayload } from './desktopPortablePayload.mjs'

export class DesktopDmgMaker extends MakerBase {
  name = 'desktop-dmg'
  defaultPlatforms = ['darwin']
  requiredExternalBinaries = ['hdiutil']

  isSupportedOnCurrentPlatform() {
    return process.platform === 'darwin'
  }

  async make({ dir, makeDir, packageJSON, targetArch }) {
    if (process.platform !== 'darwin') {
      throw new Error('DesktopDmgMaker 只能在 macOS 构建主机上运行。')
    }
    const version = requiredText(packageJSON.version, 'package version')
    const arch = requiredText(targetArch, 'target architecture')
    const options = this.config.options ?? {}
    const artifactBaseName = requiredText(options.artifactBaseName, 'artifactBaseName')
    const volumeName = requiredText(options.volumeName, 'volumeName')
    const appPath = await resolveMacApplication(dir)
    const outputDirectory = path.join(makeDir, 'dmg', 'darwin', arch)
    const destinationPath = path.join(
      outputDirectory,
      `${artifactBaseName}-${version}-darwin-${arch}.dmg`,
    )
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-dmg-'))
    try {
      await mkdir(outputDirectory, { recursive: true })
      await rm(destinationPath, { force: true })
      const stagedApp = path.join(stagingRoot, path.basename(appPath))
      runRequired('ditto', [appPath, stagedApp])
      await assertPortableClientPayload(stagedApp, 'darwin')
      await symlink('/Applications', path.join(stagingRoot, 'Applications'))
      runRequired('hdiutil', [
        'create',
        '-ov',
        '-format',
        'UDZO',
        '-volname',
        volumeName,
        '-srcfolder',
        stagingRoot,
        destinationPath,
      ])
      runRequired('hdiutil', ['verify', destinationPath])
      const metadata = await lstat(destinationPath)
      if (!metadata.isFile() || metadata.size <= 0) {
        throw new Error('hdiutil 未生成有效 DMG 文件。')
      }
      return [destinationPath]
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}

async function resolveMacApplication(directory) {
  const metadata = await lstat(directory)
  if (metadata.isDirectory() && directory.toLowerCase().endsWith('.app')) return directory
  if (!metadata.isDirectory()) throw new Error('macOS 包目录不是目录。')
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
    .map(entry => path.join(directory, entry.name))
  if (candidates.length !== 1) {
    throw new Error(`macOS 包目录必须且只能包含一个 .app，实际为 ${candidates.length} 个。`)
  }
  return candidates[0]
}

function runRequired(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`DMG 构建命令失败：${file} ${args.join(' ')}`)
  }
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`DesktopDmgMaker 缺少 ${label}。`)
  return normalized
}
