// +-------------------------------------------------------------------------
//
//   地理智能平台 - 视觉系统架构守卫
//
//   文件:       visualSystem.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI ChatGPT:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
const repositoryRoot = path.resolve(process.cwd(), '..', '..')

async function readRendererFile(relativePath: string): Promise<string> {
  return readFile(path.join(rendererRoot, relativePath), 'utf8')
}

async function collectRendererTsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectRendererTsxFiles(absolutePath)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [absolutePath] : []
  }))
  return nested.flat()
}

describe('desktop visual system guards', () => {
  it('keeps exactly one liquid-glass displacement material', async () => {
    const [layerSource, generatorSource, assetEntries, rendererTsxFiles] = await Promise.all([
      readRendererFile('shared/components/LiquidGlassLayer.tsx'),
      readFile(path.join(repositoryRoot, 'scripts', 'generate-liquid-glass-maps.mjs'), 'utf8'),
      readdir(path.join(rendererRoot, 'assets', 'liquid-glass')),
      collectRendererTsxFiles(rendererRoot),
    ])

    expect(layerSource).toContain("import surfaceMap from '../../assets/liquid-glass/panel.png'")
    expect(layerSource).toContain("id: 'dc-liquid-glass-surface'")
    expect(layerSource.match(/<filter\b/gu)).toHaveLength(1)
    expect(layerSource).not.toContain('liquid-glass-surface--')
    for (const legacyAsset of ['bar.png', 'chip.png', 'strong.png']) {
      expect(layerSource, legacyAsset).not.toContain(legacyAsset)
    }

    expect(generatorSource).toContain("const OUTPUT_NAME = 'panel.png'")
    expect(generatorSource).toContain("const LEGACY_OUTPUTS = ['bar.png', 'chip.png', 'strong.png']")
    expect(generatorSource).not.toContain('const SPECS')
    expect(assetEntries.filter(name => name.endsWith('.png')).sort()).toEqual(['panel.png'])

    const rendererTsxSources = await Promise.all(
      rendererTsxFiles.map(file => readFile(file, 'utf8')),
    )
    const mountCount = rendererTsxSources.reduce(
      (count, source) => count + (source.match(/<LiquidGlassLayer(?:\s|\/|>)/gu)?.length ?? 0),
      0,
    )
    expect(mountCount).toBe(1)
  })

  it('maps every legacy glass token to the canonical material', async () => {
    const glassSource = await readRendererFile('app/styles/glass.css')

    for (const alias of [
      '--liquid-filter-panel: var(--ui-glass-filter);',
      '--liquid-filter-strong: var(--ui-glass-filter);',
      '--liquid-filter-chip: var(--ui-glass-filter);',
      '--glass-panel-bg: var(--ui-surface);',
      '--glass-strong-bg: var(--ui-surface);',
    ]) {
      expect(glassSource, alias).toContain(alias)
    }
    expect(glassSource).toContain('.liquid-glass-surface,')
    expect(glassSource).toContain('@media (prefers-contrast: more)')
    expect(glassSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(glassSource).toContain('@media (forced-colors: active)')
  })

  it('loads one final semantic theme across every desktop page family', async () => {
    const [
      runtimeSource,
      entrySource,
      foundationSource,
      pagesSource,
      contentSource,
      overlaysSource,
    ] = await Promise.all([
      readRendererFile('app/DesktopWorkspaceApplication.tsx'),
      readRendererFile('app/styles/ui-system.css'),
      readRendererFile('app/styles/ui-foundation.css'),
      readRendererFile('app/styles/ui-pages.css'),
      readRendererFile('app/styles/ui-content.css'),
      readRendererFile('app/styles/ui-overlays.css'),
    ])
    const uiSystemSource = [foundationSource, pagesSource, contentSource, overlaysSource].join('\n')

    expect(runtimeSource).toContain("import './styles/ui-system.css'")
    expect(runtimeSource).toContain('<LiquidGlassLayer />')
    for (const modulePath of [
      './ui-foundation.css',
      './ui-pages.css',
      './ui-content.css',
      './ui-overlays.css',
    ]) {
      expect(entrySource, modulePath).toContain(`@import '${modulePath}';`)
    }
    expect(runtimeSource.indexOf("import './styles/ui-system.css'"))
      .toBeGreaterThan(runtimeSource.indexOf("import AppShell from './AppShell'"))

    for (const pageRoot of [
      '.gf-desktop-shell',
      '.model-settings',
      '.account-page',
      '.dc-security-page',
      '.debug-shell',
      '.tool-management',
    ]) {
      expect(uiSystemSource, pageRoot).toContain(pageRoot)
    }
    expect(uiSystemSource).toContain('.ui-dialog-surface')
    expect(uiSystemSource).toContain('.ui-popover-surface')
    expect(uiSystemSource).toContain('@media (prefers-contrast: more)')
    expect(uiSystemSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(uiSystemSource).toContain('@media (forced-colors: active)')
  })

  it('keeps shared overlays on the same surface contract', async () => {
    const [dialogSource, popoverSource] = await Promise.all([
      readRendererFile('shared/components/GlassDialog.tsx'),
      readRendererFile('shared/components/GlassPopover.tsx'),
    ])

    expect(dialogSource).toContain('className="ui-dialog-surface alert"')
    expect(dialogSource).toContain('data-ui-surface="glass"')
    expect(popoverSource).toContain('className="ui-popover-surface popover-content"')
    expect(popoverSource).toContain('data-ui-surface="glass"')
    expect(popoverSource).not.toContain('className="glass-panel"')
  })
})
