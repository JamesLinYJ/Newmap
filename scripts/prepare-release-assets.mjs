#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReleaseVersion } from './validate-release-version.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_GROUPS = Object.freeze({
  'desktop-windows-x64': ['.exe', '.nupkg', '.zip'],
  'desktop-macos-x64': ['.dmg', '.zip'],
  'desktop-macos-arm64': ['.dmg', '.zip'],
  'desktop-linux-x64': ['.appimage', '.deb', '.rpm', '.zip'],
})
const RELEASE_EXTENSIONS = [...new Set(Object.values(RELEASE_GROUPS).flat())]

export async function prepareReleaseAssets(input) {
  const sourceRoot = path.resolve(requiredText(input.sourceRoot, 'sourceRoot'))
  const outputRoot = path.resolve(requiredText(input.outputRoot, 'outputRoot'))
  const projectDirectory = path.resolve(input.projectRoot ?? projectRoot)
  const version = input.version ?? await readReleaseVersion(projectDirectory)
  const sourceRevision = normalizeOptionalText(input.sourceRevision)
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })

  const staged = []
  const basenames = new Set()
  for (const [groupName, expectedExtensions] of Object.entries(RELEASE_GROUPS)) {
    const groupRoot = path.join(sourceRoot, groupName)
    const files = (await listRegularFiles(groupRoot)).filter(isReleaseArtifact)
    for (const extension of expectedExtensions) {
      if (!files.some(file => file.toLowerCase().endsWith(extension))) {
        throw new Error(`${groupName} 缺少 ${extension} 发布产物。`)
      }
    }
    for (const sourcePath of files.sort()) {
      const fileName = safeAssetName(path.basename(sourcePath))
      if (fileName.includes('UNSIGNED-TEST')) {
        throw new Error(`生产发布包含未签名测试产物：${groupName}/${fileName}`)
      }
      if (basenames.has(fileName)) throw new Error(`发布资产文件名冲突：${fileName}`)
      basenames.add(fileName)
      const destinationPath = path.join(outputRoot, fileName)
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL)
      const metadata = await stat(destinationPath)
      if (!metadata.isFile() || metadata.size <= 0) {
        throw new Error(`发布资产为空或不是文件：${fileName}`)
      }
      staged.push({
        fileName,
        sourceArtifact: groupName,
        sizeBytes: metadata.size,
        sha256: await sha256(destinationPath),
      })
    }
  }

  staged.sort((left, right) => left.fileName.localeCompare(right.fileName, 'en'))
  const manifest = {
    schemaVersion: 1,
    releaseVersion: version,
    sourceRevision,
    generatedAt: resolveGeneratedAt(process.env),
    assets: staged,
  }
  const manifestPath = path.join(outputRoot, 'release-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const manifestMetadata = await stat(manifestPath)
  const checksumEntries = [
    ...staged.map(asset => ({ fileName: asset.fileName, sha256: asset.sha256 })),
    {
      fileName: 'release-manifest.json',
      sha256: await sha256(manifestPath),
      sizeBytes: manifestMetadata.size,
    },
  ].sort((left, right) => left.fileName.localeCompare(right.fileName, 'en'))
  const checksumsPath = path.join(outputRoot, 'SHA256SUMS')
  await writeFile(
    checksumsPath,
    `${checksumEntries.map(asset => `${asset.sha256} *${asset.fileName}`).join('\n')}\n`,
    'utf8',
  )
  return { version, manifestPath, checksumsPath, assets: staged }
}

async function listRegularFiles(directory) {
  const metadata = await lstat(directory).catch(() => null)
  if (!metadata?.isDirectory()) throw new Error(`缺少构建资产组：${directory}`)
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`构建资产组包含符号链接：${fullPath}`)
    if (entry.isDirectory()) result.push(...await listRegularFiles(fullPath))
    else if (entry.isFile()) result.push(fullPath)
    else throw new Error(`构建资产组包含不支持的文件类型：${fullPath}`)
  }
  return result
}

function isReleaseArtifact(file) {
  const normalized = file.toLowerCase()
  return RELEASE_EXTENSIONS.some(extension => normalized.endsWith(extension))
}

function safeAssetName(value) {
  const name = requiredText(value, 'asset name')
  if (
    name === '.'
    || name === '..'
    || name.startsWith('.')
    || name.includes('/')
    || name.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error(`不安全的发布资产文件名：${JSON.stringify(name)}`)
  }
  return name
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function resolveGeneratedAt(environment) {
  const sourceDateEpoch = environment.SOURCE_DATE_EPOCH?.trim()
  if (!sourceDateEpoch) return new Date().toISOString()
  if (!/^\d+$/u.test(sourceDateEpoch)) throw new Error('SOURCE_DATE_EPOCH 必须是非负整数秒。')
  const timestamp = Number(sourceDateEpoch) * 1_000
  const date = new Date(timestamp)
  if (!Number.isFinite(timestamp) || Number.isNaN(date.valueOf())) {
    throw new Error('SOURCE_DATE_EPOCH 超出支持范围。')
  }
  return date.toISOString()
}

function normalizeOptionalText(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`缺少 ${label}。`)
  return normalized
}

function parseArgs(argv) {
  const result = { sourceRoot: null, outputRoot: null, version: null, sourceRevision: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') result.sourceRoot = argv[++index]
    else if (argument === '--output') result.outputRoot = argv[++index]
    else if (argument === '--version') result.version = argv[++index]
    else if (argument === '--source-revision') result.sourceRevision = argv[++index]
    else throw new Error(`未知参数：${argument}`)
  }
  return result
}

async function main() {
  const input = parseArgs(process.argv.slice(2))
  const result = await prepareReleaseAssets({
    ...input,
    sourceRevision: input.sourceRevision ?? process.env.GITHUB_SHA,
  })
  process.stdout.write(`${JSON.stringify({
    version: result.version,
    assets: result.assets.map(asset => asset.fileName),
    manifestPath: result.manifestPath,
    checksumsPath: result.checksumsPath,
  }, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
