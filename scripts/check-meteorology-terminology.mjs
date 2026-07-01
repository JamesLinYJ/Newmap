// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象术语守卫
//
//   文件:       check-meteorology-terminology.mjs
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const legacyTerms = [
  ['wea', 'ther'].join(''),
  ['Wea', 'ther'].join(''),
  ['WEA', 'THER'].join(''),
  ['gis_', 'wea', 'ther'].join(''),
  ['gis-', 'wea', 'ther'].join(''),
  ['降雨', '风险'].join(''),
  ['面雨量', '表格'].join(''),
  ['雷达', '拼图'].join(''),
]
const ignoredPathParts = new Set([
  '.git',
  '.playwright-cli',
  '.pytest_cache',
  'node_modules',
  'dist',
  'runtime',
  'output',
  '__pycache__',
])
const ignoredExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pyc',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.zip',
  '.bz2',
  '.nc',
  '.nc4',
])
const allowedSnapshot = [
  'packages',
  'gis-meteorology',
  'src',
  'gis_meteorology',
  'third_party',
]

const violations = []
await walk(root)

if (violations.length) {
  console.error('气象术语检查失败：GeoForge 自有代码仍含旧命名。')
  for (const item of violations.slice(0, 100)) {
    console.error(`- ${item}`)
  }
  if (violations.length > 100) {
    console.error(`... 另有 ${violations.length - 100} 条`)
  }
  process.exit(1)
}

console.log('气象术语检查通过。')

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    const relativePath = path.relative(root, fullPath)
    if (shouldIgnore(relativePath, entry.name)) continue
    if (entry.isDirectory()) {
      await walk(fullPath)
      continue
    }
    if (!entry.isFile()) continue
    checkPath(relativePath)
    if (ignoredExtensions.has(path.extname(entry.name).toLowerCase())) continue
    const text = await readFile(fullPath, 'utf8').catch(() => null)
    if (text === null) continue
    for (const term of legacyTerms) {
      if (text.includes(term)) {
        violations.push(`${relativePath}: contains "${term}"`)
      }
    }
  }
}

function shouldIgnore(relativePath, name) {
  const parts = relativePath.split(path.sep)
  if (parts.some(part => ignoredPathParts.has(part))) return true
  if (parts.some(part => part.endsWith('.egg-info'))) return true
  if (isAllowedOriginalSnapshot(parts)) return true
  return name === ''
}

function isAllowedOriginalSnapshot(parts) {
  if (parts.length < allowedSnapshot.length + 3) return false
  for (let index = 0; index < allowedSnapshot.length; index += 1) {
    if (parts[index] !== allowedSnapshot[index]) return false
  }
  const sourceIndex = parts.indexOf('source')
  const originalIndex = parts.indexOf('original')
  return sourceIndex >= allowedSnapshot.length && originalIndex === sourceIndex + 1
}

function checkPath(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, '/')
  for (const term of legacyTerms) {
    if (normalized.includes(term)) {
      violations.push(`${relativePath}: path contains "${term}"`)
    }
  }
}
