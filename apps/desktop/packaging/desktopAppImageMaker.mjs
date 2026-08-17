// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux AppImage Maker
//
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import { statSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stagePortableClientDirectory } from './desktopPortablePayload.mjs'

export class DesktopAppImageMaker extends MakerBase {
  name = 'desktop-appimage'
  defaultPlatforms = ['linux']

  isSupportedOnCurrentPlatform() {
    return process.platform === 'linux'
  }

  async make({ dir, makeDir, packageJSON, targetArch }) {
    if (process.platform !== 'linux') {
      throw new Error('DesktopAppImageMaker 只能在 Linux 构建主机上运行。')
    }
    if (targetArch !== 'x64') {
      throw new Error(`DesktopAppImageMaker 当前只支持 Linux x64，实际为 ${String(targetArch)}。`)
    }
    const options = normalizeOptions(this.config.options)
    const version = requiredText(packageJSON.version, 'package version')
    const appImageTool = requireExecutable(
      process.env.APPIMAGETOOL_PATH,
      'APPIMAGETOOL_PATH',
    )
    const runtimeFile = requireRegularFile(
      process.env.APPIMAGE_RUNTIME_PATH,
      'APPIMAGE_RUNTIME_PATH',
    )
    const outputDirectory = path.join(makeDir, 'appimage', 'linux', targetArch)
    const destinationPath = path.join(
      outputDirectory,
      `${options.artifactBaseName}-${version}-linux-${targetArch}-remote-client.AppImage`,
    )
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-appimage-'))
    const appDir = path.join(temporaryRoot, `${options.artifactBaseName}.AppDir`)
    try {
      await mkdir(outputDirectory, { recursive: true })
      await rm(destinationPath, { force: true })
      await stageAppDir(appDir, dir, options, version)
      runRequired(appImageTool, [
        '--runtime-file',
        runtimeFile,
        appDir,
        destinationPath,
      ], {
        APPIMAGE_EXTRACT_AND_RUN: '1',
        APPIMAGETOOL_APP_NAME: options.productName,
        ARCH: 'x86_64',
        VERSION: version,
      })
      const metadata = await lstat(destinationPath)
      if (!metadata.isFile() || metadata.size <= 0) {
        throw new Error('appimagetool 未生成有效 AppImage 文件。')
      }
      const header = await readFile(destinationPath)
      if (header.length < 4 || header.subarray(0, 4).toString('hex') !== '7f454c46') {
        throw new Error('AppImage 不是有效的 ELF 文件。')
      }
      await chmod(destinationPath, 0o755)
      return [destinationPath]
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }
}

async function stageAppDir(appDir, sourceDirectory, options, version) {
  const applicationDirectory = path.join(appDir, 'usr', 'lib', options.packageName)
  await mkdir(path.dirname(applicationDirectory), { recursive: true })
  await stagePortableClientDirectory(sourceDirectory, applicationDirectory, 'linux')
  const executablePath = path.join(applicationDirectory, options.bin)
  const executableMetadata = await lstat(executablePath).catch(() => null)
  if (!executableMetadata?.isFile()) {
    throw new Error(`AppImage 发布载荷缺少桌面可执行文件：${options.bin}`)
  }
  await chmod(executablePath, 0o755)

  const appRunPath = path.join(appDir, 'AppRun')
  await writeFile(appRunPath, [
    '#!/bin/sh',
    'set -eu',
    'APPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    `exec "$APPDIR/usr/lib/${options.packageName}/${options.bin}" "$@"`,
    '',
  ].join('\n'), 'utf8')
  await chmod(appRunPath, 0o755)

  const desktopFileName = `${options.packageName}.desktop`
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${options.productName}`,
    `GenericName=${options.genericName}`,
    `Comment=${options.description}`,
    'Exec=AppRun %U',
    `Icon=${options.packageName}`,
    'Terminal=false',
    `Categories=${options.categories.join(';')};`,
    `MimeType=x-scheme-handler/${options.protocolScheme};`,
    `X-AppImage-Version=${version}`,
    'StartupNotify=true',
    '',
  ].join('\n')
  await writeFile(path.join(appDir, desktopFileName), desktopEntry, 'utf8')
  await mkdir(path.join(appDir, 'usr', 'share', 'applications'), { recursive: true })
  await writeFile(
    path.join(appDir, 'usr', 'share', 'applications', desktopFileName),
    desktopEntry,
    'utf8',
  )

  const rootIcon = path.join(appDir, `${options.packageName}.png`)
  await copyFile(options.icon, rootIcon)
  await symlink(`${options.packageName}.png`, path.join(appDir, '.DirIcon'))
  const iconDirectory = path.join(appDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps')
  await mkdir(iconDirectory, { recursive: true })
  await copyFile(options.icon, path.join(iconDirectory, `${options.packageName}.png`))
}

function normalizeOptions(value) {
  const options = value && typeof value === 'object' ? value : {}
  const normalized = {
    artifactBaseName: fileName(options.artifactBaseName, 'artifactBaseName'),
    packageName: packageName(options.packageName),
    bin: fileName(options.bin, 'bin'),
    productName: singleLine(options.productName, 'productName'),
    genericName: singleLine(options.genericName, 'genericName'),
    description: singleLine(options.description, 'description'),
    protocolScheme: packageName(options.protocolScheme),
    categories: stringList(options.categories, 'categories'),
    icon: requiredText(options.icon, 'icon'),
  }
  if (!path.isAbsolute(normalized.icon)) throw new Error('AppImage icon 必须使用绝对路径。')
  return normalized
}

function requireExecutable(value, label) {
  const file = requireRegularFile(value, label)
  if ((statSync(file).mode & 0o111) === 0) {
    throw new Error(`${label} 必须具有可执行权限。`)
  }
  return file
}

function requireRegularFile(value, label) {
  const file = requiredText(value, label)
  if (!path.isAbsolute(file)) throw new Error(`${label} 必须是绝对路径。`)
  let metadata
  try {
    metadata = statSync(file)
  } catch {
    throw new Error(`${label} 必须指向存在的普通文件。`)
  }
  if (!metadata.isFile()) throw new Error(`${label} 必须指向存在的普通文件。`)
  return file
}

function packageName(value) {
  const normalized = requiredText(value, 'package name').toLowerCase()
  if (!/^[a-z0-9][a-z0-9+.-]*$/u.test(normalized)) {
    throw new Error(`无效 Linux 包名：${normalized}`)
  }
  return normalized
}

function fileName(value, label) {
  const normalized = requiredText(value, label)
  if (normalized === '.' || normalized === '..' || /[/\\\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} 不是安全文件名。`)
  }
  return normalized
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`DesktopAppImageMaker 缺少 ${label}。`)
  }
  return value.map(item => singleLine(item, label))
}

function singleLine(value, label) {
  const normalized = requiredText(value, label)
  if (/\r|\n/u.test(normalized)) throw new Error(`${label} 不能包含换行。`)
  return normalized
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`DesktopAppImageMaker 缺少 ${label}。`)
  return normalized
}

function runRequired(file, args, environment) {
  const result = spawnSync(file, args, {
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`AppImage 构建命令失败：${file} ${args.join(' ')}`)
  }
}
