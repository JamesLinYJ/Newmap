#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function readReleaseVersion(root = projectRoot) {
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const desktopPackage = JSON.parse(await readFile(
    path.join(root, 'apps', 'desktop', 'package.json'),
    'utf8',
  ))
  const rootVersion = normalizeVersion(rootPackage.version, 'root package')
  const desktopVersion = normalizeVersion(desktopPackage.version, 'desktop package')
  if (rootVersion !== desktopVersion) {
    throw new Error(`发布版本不一致：root=${rootVersion}, desktop=${desktopVersion}`)
  }
  return rootVersion
}

export function validateReleaseTag(tag, version) {
  const normalizedTag = typeof tag === 'string' ? tag.trim() : ''
  if (!normalizedTag) return
  const expectedTag = `v${version}`
  if (normalizedTag !== expectedTag) {
    throw new Error(`发布标签必须与 package version 完全一致：期望 ${expectedTag}，实际 ${normalizedTag}`)
  }
}

function normalizeVersion(value, label) {
  const version = typeof value === 'string' ? value.trim() : ''
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`${label} 缺少合法 SemVer 版本。`)
  }
  return version
}

async function main() {
  const version = await readReleaseVersion()
  const tag = process.env.GITHUB_REF_TYPE === 'tag'
    ? process.env.GITHUB_REF_NAME
    : process.argv[2]
  validateReleaseTag(tag, version)
  process.stdout.write(`${version}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
