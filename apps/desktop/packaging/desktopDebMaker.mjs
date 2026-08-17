// +-------------------------------------------------------------------------
//
//   地理智能平台 - Debian/Ubuntu DEB Maker
//
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export class DesktopDebMaker extends MakerBase {
  name = 'desktop-deb'
  defaultPlatforms = ['linux']
  requiredExternalBinaries = ['dpkg-deb']

  isSupportedOnCurrentPlatform() {
    return process.platform === 'linux'
  }

  async make({ dir, makeDir, packageJSON, targetArch }) {
    if (process.platform !== 'linux') {
      throw new Error('DesktopDebMaker 只能在 Linux 构建主机上运行。')
    }
    const options = normalizeOptions(this.config.options)
    const version = normalizeDebianVersion(packageJSON.version)
    const architecture = debianArchitecture(targetArch)
    const outputDirectory = path.join(makeDir, 'deb', 'linux', targetArch)
    const destinationPath = path.join(
      outputDirectory,
      `${options.name}_${version}_${architecture}.deb`,
    )
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-deb-'))
    const packageRoot = path.join(temporaryRoot, 'root')
    try {
      await mkdir(outputDirectory, { recursive: true })
      await rm(destinationPath, { force: true })
      await stagePackage(packageRoot, dir, options, version, architecture)
      runRequired('dpkg-deb', [
        '--root-owner-group',
        '--build',
        packageRoot,
        destinationPath,
      ])
      runRequired('dpkg-deb', ['--info', destinationPath])
      runRequired('dpkg-deb', ['--contents', destinationPath])
      const metadata = await lstat(destinationPath)
      if (!metadata.isFile() || metadata.size <= 0) {
        throw new Error('dpkg-deb 未生成有效 DEB 文件。')
      }
      return [destinationPath]
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }
}

async function stagePackage(root, sourceDirectory, options, version, architecture) {
  const applicationDirectory = path.join(root, 'usr', 'lib', options.name)
  await mkdir(applicationDirectory, { recursive: true })
  await cp(sourceDirectory, applicationDirectory, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })

  const desktopExecutable = path.join(applicationDirectory, options.bin)
  const runtimeCli = path.join(
    applicationDirectory,
    'resources',
    'runtime-service',
    'deploy',
    'bin',
    'geo-agent-platform',
  )
  const runtimeUnit = path.join(
    applicationDirectory,
    'resources',
    'runtime-service',
    'deploy',
    'systemd',
    'geo-agent-platform-supervisor.user.service',
  )
  for (const requiredPath of [desktopExecutable, runtimeCli, runtimeUnit]) {
    const metadata = await lstat(requiredPath).catch(() => null)
    if (!metadata?.isFile()) {
      throw new Error(`DEB 发布载荷缺少必需文件：${path.relative(applicationDirectory, requiredPath)}`)
    }
  }

  const binaryDirectory = path.join(root, 'usr', 'bin')
  await mkdir(binaryDirectory, { recursive: true })
  await symlink(`../lib/${options.name}/${options.bin}`, path.join(binaryDirectory, options.name))
  await symlink(
    `../lib/${options.name}/resources/runtime-service/deploy/bin/geo-agent-platform`,
    path.join(binaryDirectory, 'geo-agent-platform'),
  )
  await chmod(desktopExecutable, 0o755)
  await chmod(runtimeCli, 0o755)

  const systemdDirectory = path.join(root, 'usr', 'lib', 'systemd', 'user')
  await mkdir(systemdDirectory, { recursive: true })
  await copyFile(runtimeUnit, path.join(systemdDirectory, 'geo-agent-platform-supervisor.service'))
  await chmod(path.join(systemdDirectory, 'geo-agent-platform-supervisor.service'), 0o644)

  const applicationsDirectory = path.join(root, 'usr', 'share', 'applications')
  await mkdir(applicationsDirectory, { recursive: true })
  const desktopEntryPath = path.join(applicationsDirectory, `${options.name}.desktop`)
  await writeFile(desktopEntryPath, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${options.productName}`,
    `GenericName=${options.genericName}`,
    `Comment=${options.description}`,
    `Exec=/usr/bin/${options.name} %U`,
    `Icon=${options.name}`,
    'Terminal=false',
    `Categories=${options.categories.join(';')};`,
    `MimeType=x-scheme-handler/${options.protocolScheme};`,
    'StartupNotify=true',
    '',
  ].join('\n'), 'utf8')
  await chmod(desktopEntryPath, 0o644)

  const iconDirectory = path.join(root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps')
  await mkdir(iconDirectory, { recursive: true })
  const iconDestination = path.join(iconDirectory, `${options.name}.png`)
  await copyFile(options.icon, iconDestination)
  await chmod(iconDestination, 0o644)

  const controlDirectory = path.join(root, 'DEBIAN')
  await mkdir(controlDirectory, { recursive: true })
  const controlPath = path.join(controlDirectory, 'control')
  await writeFile(controlPath, [
    `Package: ${options.name}`,
    `Version: ${version}`,
    'Section: science',
    'Priority: optional',
    `Architecture: ${architecture}`,
    `Maintainer: ${options.maintainer}`,
    `Depends: ${options.depends.join(', ')}`,
    `Description: ${options.description}`,
    ` ${options.longDescription}`,
    '',
  ].join('\n'), 'utf8')
  await chmod(controlPath, 0o644)
}

function normalizeOptions(value) {
  const options = value && typeof value === 'object' ? value : {}
  const normalized = {
    name: packageName(options.name),
    bin: requiredText(options.bin, 'bin'),
    productName: singleLine(options.productName, 'productName'),
    genericName: singleLine(options.genericName, 'genericName'),
    description: singleLine(options.description, 'description'),
    longDescription: singleLine(options.longDescription, 'longDescription'),
    maintainer: singleLine(options.maintainer, 'maintainer'),
    protocolScheme: packageName(options.protocolScheme),
    categories: stringList(options.categories, 'categories'),
    depends: stringList(options.depends, 'depends'),
    icon: requiredText(options.icon, 'icon'),
  }
  if (!path.isAbsolute(normalized.icon)) throw new Error('DEB icon 必须使用绝对路径。')
  return normalized
}

function packageName(value) {
  const normalized = requiredText(value, 'package name').toLowerCase()
  if (!/^[a-z0-9][a-z0-9+.-]*$/u.test(normalized)) {
    throw new Error(`无效 Debian 包名：${normalized}`)
  }
  return normalized
}

function normalizeDebianVersion(value) {
  const normalized = requiredText(value, 'package version')
  if (!/^[0-9][0-9A-Za-z.+:~\-]*$/u.test(normalized)) {
    throw new Error(`无效 Debian 版本：${normalized}`)
  }
  return normalized
}

function debianArchitecture(value) {
  if (value === 'x64') return 'amd64'
  if (value === 'arm64') return 'arm64'
  throw new Error(`不支持的 Debian 架构：${String(value)}`)
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`DesktopDebMaker 缺少 ${label}。`)
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
  if (!normalized) throw new Error(`DesktopDebMaker 缺少 ${label}。`)
  return normalized
}

function runRequired(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`DEB 构建命令失败：${file} ${args.join(' ')}`)
  }
}
