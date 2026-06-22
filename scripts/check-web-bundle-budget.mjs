// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 首屏体积预算
//
//   文件:       check-web-bundle-budget.mjs
//
//   日期:       2026年06月18日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'apps/web/dist')
const html = await readFile(path.join(dist, 'index.html'), 'utf8')
const initialJs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"?]+\.js)"/gu)].map(match => match[1])
const initialCss = [...html.matchAll(/rel="stylesheet"[^>]+href="\/(assets\/[^"?]+\.css)"/gu)].map(match => match[1])

const initialJsGzip = await totalGzip(initialJs)
const initialCssGzip = await totalGzip(initialCss)
assertBudget('首屏 JavaScript', initialJsGzip, 120 * 1024)
assertBudget('首屏 CSS', initialCssGzip, 22 * 1024)

for (const forbidden of ['maplibre', 'MapCanvas', 'DebugPage', 'ToolManagementPage', 'motion']) {
  if (html.includes(forbidden)) throw new Error(`首屏 HTML 不应预加载 ${forbidden}`)
}

const assets = await readdir(path.join(dist, 'assets'))
const appShell = assets.find(name => /^AppShell-.*\.js$/u.test(name))
const mapEngine = assets.find(name => /^maplibre-.*\.js$/u.test(name) && !name.includes('worker'))
if (!appShell || !mapEngine) throw new Error('没有找到 AppShell 或 MapLibre 构建产物')
assertBudget('AppShell 异步包', await gzipSize(`assets/${appShell}`), 105 * 1024)
assertBudget('MapLibre 异步包', await gzipSize(`assets/${mapEngine}`), 260 * 1024)

console.log(JSON.stringify({
  initialJsGzip,
  initialCssGzip,
  initialJs,
  initialCss,
  appShell,
  mapEngine,
}, null, 2))

async function totalGzip(files) {
  const sizes = await Promise.all([...new Set(files)].map(gzipSize))
  return sizes.reduce((sum, size) => sum + size, 0)
}

async function gzipSize(relativePath) {
  const content = await readFile(path.join(dist, relativePath))
  return gzipSync(content, { level: 9 }).length
}

function assertBudget(label, actual, limit) {
  if (actual > limit) throw new Error(`${label} 超出预算：${actual} > ${limit} bytes`)
}
