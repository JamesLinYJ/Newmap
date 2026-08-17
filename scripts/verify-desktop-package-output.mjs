#!/usr/bin/env node

import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_EXTENSIONS = Object.freeze({
  win32: ['.exe', '.nupkg', '.zip'],
  darwin: ['.dmg', '.zip'],
  linux: ['.appimage', '.deb', '.rpm', '.zip'],
})

export async function verifyDesktopPackageOutput(input) {
  const platform = requiredPlatform(input.platform)
  const root = path.resolve(requiredText(input.root, 'root'))
  const architecture = requiredArchitecture(platform, input.architecture)
  const production = input.production === true
  const files = await listRegularFiles(root)
  const artifacts = files.filter(file => isReleaseArtifact(file))
  if (artifacts.length === 0) throw new Error(`打包目录没有发布产物：${root}`)

  for (const extension of EXPECTED_EXTENSIONS[platform]) {
    const matching = artifacts.filter(file => file.toLowerCase().endsWith(extension))
    if (matching.length !== 1) {
      throw new Error(`${platform}/${architecture} 必须且只能包含一个 ${extension} 产物，实际为 ${matching.length} 个。`)
    }
  }
  const expectedCount = EXPECTED_EXTENSIONS[platform].length
  if (artifacts.length !== expectedCount) {
    throw new Error(
      `${platform}/${architecture} 发布产物数量必须为 ${expectedCount}，实际为 ${artifacts.length}。`,
    )
  }

  if (platform === 'linux') {
    const portable = artifacts.filter(file => /\.(?:appimage|zip)$/iu.test(file))
    if (portable.some(file => !path.basename(file).includes('remote-client'))) {
      throw new Error('Linux AppImage/ZIP 必须以 remote-client 明确标识其部署模式。')
    }
    const installed = artifacts.filter(file => /\.(?:deb|rpm)$/iu.test(file))
    if (installed.some(file => path.basename(file).includes('remote-client'))) {
      throw new Error('Linux DEB/RPM 是本机受管服务包，不能标记为 remote-client。')
    }
  }

  const unsigned = artifacts.filter(file => path.basename(file).includes('UNSIGNED-TEST'))
  const markerFiles = files.filter(file => path.basename(file) === 'UNSIGNED-TEST-BUILD.txt')
  if (production && (unsigned.length > 0 || markerFiles.length > 0)) {
    throw new Error('生产发布目录包含 UNSIGNED-TEST 标记，拒绝发布。')
  }
  if (!production && unsigned.length === 0) {
    throw new Error('验证构建必须至少有一个明确的 UNSIGNED-TEST 产物。')
  }

  return {
    platform,
    architecture,
    production,
    artifacts: artifacts.map(file => path.relative(root, file).replaceAll(path.sep, '/')).sort(),
  }
}

async function listRegularFiles(directory) {
  const metadata = await lstat(directory).catch(() => null)
  if (!metadata?.isDirectory()) throw new Error(`打包目录不存在：${directory}`)
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`打包目录包含符号链接：${fullPath}`)
    if (entry.isDirectory()) result.push(...await listRegularFiles(fullPath))
    else if (entry.isFile()) result.push(fullPath)
    else throw new Error(`打包目录包含不支持的文件类型：${fullPath}`)
  }
  return result
}

function isReleaseArtifact(file) {
  const normalized = file.toLowerCase()
  return Object.values(EXPECTED_EXTENSIONS).flat().some(extension => normalized.endsWith(extension))
}

function requiredPlatform(value) {
  const platform = requiredText(value, 'platform')
  if (!(platform in EXPECTED_EXTENSIONS)) throw new Error(`不支持的打包平台：${platform}`)
  return platform
}

function requiredArchitecture(platform, value) {
  const architecture = requiredText(value, 'architecture')
  const accepted = platform === 'darwin' ? ['x64', 'arm64'] : ['x64']
  if (!accepted.includes(architecture)) {
    throw new Error(`${platform} 不支持发布架构：${architecture}`)
  }
  return architecture
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`缺少 ${label}。`)
  return normalized
}

function parseArgs(argv) {
  const result = { root: null, platform: null, architecture: null, production: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--root') result.root = argv[++index]
    else if (argument === '--platform') result.platform = argv[++index]
    else if (argument === '--arch') result.architecture = argv[++index]
    else if (argument === '--production') result.production = true
    else throw new Error(`未知参数：${argument}`)
  }
  return result
}

async function main() {
  const result = await verifyDesktopPackageOutput(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
