// +-------------------------------------------------------------------------
//
//   地理智能平台 - 视觉抛光架构守卫
//
//   文件:       visualRefinement.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI ChatGPT:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesRoot = path.resolve(process.cwd(), 'src', 'renderer', 'app', 'styles')

describe('desktop visual refinement guards', () => {
  it('loads the high-specificity refinement after every semantic UI module', async () => {
    const entry = await readFile(path.join(stylesRoot, 'ui-system.css'), 'utf8')
    const refinementImport = "@import './ui-refinement.css';"

    expect(entry).toContain(refinementImport)
    expect(entry.indexOf(refinementImport)).toBeGreaterThan(entry.indexOf("@import './ui-overlays.css';"))
  })

  it('keeps key page families on stable content surfaces', async () => {
    const source = await readFile(path.join(stylesRoot, 'ui-refinement.css'), 'utf8')

    for (const selector of [
      '.account-hero',
      '.model-settings__section',
      '.dc-security-header',
      '.tool-management__hero',
      '.tool-management__sidebar',
      '.tool-management__detail .panel',
      '.debug-shell__header',
      '.overview-card',
    ]) {
      expect(source, selector).toContain(selector)
    }

    expect(source).toContain('#root :is(')
    expect(source).toContain('backdrop-filter: none;')
    expect(source).toContain('-webkit-backdrop-filter: none;')
    expect(source).not.toContain('url("#dc-liquid-glass')
    expect(source).not.toContain('liquid-map-background')
  })
})
