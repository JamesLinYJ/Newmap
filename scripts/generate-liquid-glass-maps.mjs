// +-------------------------------------------------------------------------
//
//   地理智能平台 - 液体玻璃位移图生成器
//
//   文件:       generate-liquid-glass-maps.mjs
//
//   日期:       2026年06月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-08-18):
//     作者: JamesLinYJ
//     协助: OpenAI ChatGPT:GPT-5.6 Pro
//     说明: 删除按控件类型分裂的位移图，只生成一个权威表面材质。
// --------------------------------------------------------------------------

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.join(ROOT, 'apps/desktop/src/renderer/assets/liquid-glass')
const OUTPUT_NAME = 'panel.png'
const LEGACY_OUTPUTS = ['bar.png', 'chip.png', 'strong.png']
const SPEC = {
  width: 180,
  height: 120,
  radius: 13,
  edge: 19,
  depth: 0.072,
  ripple: 0.0018,
}

await mkdir(OUTPUT, { recursive: true })
await Promise.all(
  LEGACY_OUTPUTS.map(name => rm(path.join(OUTPUT, name), { force: true })),
)
const pixels = buildMap(SPEC)
await writeFile(path.join(OUTPUT, OUTPUT_NAME), encodePng(SPEC.width, SPEC.height, pixels))

function buildMap(spec) {
  const pixelCount = spec.width * spec.height
  const raw = new Float32Array(pixelCount * 2)
  const pixels = new Uint8Array(pixelCount * 4)
  let maxDelta = 0

  for (let index = 0; index < pixelCount; index += 1) {
    const x = index % spec.width
    const y = Math.floor(index / spec.width)
    const uv = {
      x: x / Math.max(1, spec.width - 1),
      y: y / Math.max(1, spec.height - 1),
    }
    const mapped = mapPixel(uv, spec)
    const dx = mapped.x - uv.x
    const dy = mapped.y - uv.y
    raw[index * 2] = dx
    raw[index * 2 + 1] = dy
    maxDelta = Math.max(maxDelta, Math.abs(dx), Math.abs(dy))
  }

  const normalizer = Math.max(maxDelta, 0.00001)
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    pixels[offset] = byte(127.5 + (raw[index * 2] / normalizer) * 127.5)
    pixels[offset + 1] = byte(127.5 + (raw[index * 2 + 1] / normalizer) * 127.5)
    pixels[offset + 2] = 128
    pixels[offset + 3] = 255
  }
  return pixels
}

function mapPixel(uv, spec) {
  const minSide = Math.min(spec.width, spec.height)
  const x = (uv.x - 0.5) * (spec.width / minSide)
  const y = (uv.y - 0.5) * (spec.height / minSide)
  const halfWidth = spec.width / minSide / 2
  const halfHeight = spec.height / minSide / 2
  const radius = Math.min(spec.radius / minSide, halfWidth, halfHeight)
  const distance = roundedRectSdf(x, y, halfWidth, halfHeight, radius)
  const edgePull = 1 - smoothStep(0, Math.max(0.02, spec.edge / minSide), Math.max(0, -distance))
  const meniscus = Math.pow(edgePull, 1.72)
  const wave = Math.sin((uv.x * 1.4 + uv.y) * Math.PI * 2.1) * spec.ripple * meniscus
  const scale = 1 - meniscus * spec.depth
  return {
    x: clamp(0.5 + (uv.x - 0.5) * scale + wave),
    y: clamp(0.5 + (uv.y - 0.5) * scale - wave * 0.72),
  }
}

function roundedRectSdf(x, y, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x) - halfWidth + radius
  const qy = Math.abs(y) - halfHeight + radius
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

function smoothStep(start, end, value) {
  const t = clamp((value - start) / Math.max(0.00001, end - start))
  return t * t * (3 - 2 * t)
}

function clamp(value) {
  return Math.max(0, Math.min(1, value))
}

function byte(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function encodePng(width, height, pixels) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 4 + 1)
    scanlines[target] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + row * width * 4, width * 4).copy(scanlines, target + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const output = Buffer.alloc(data.length + 12)
  output.writeUInt32BE(data.length, 0)
  typeBuffer.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8)
  return output
}

function crc32(data) {
  let crc = 0xffffffff
  for (const value of data) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
