// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台浏览器主流程测试
//
//   文件:       workspace.spec.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test.describe('workspace browser acceptance', () => {
  test('uses one bootstrap request and shows recent threads without request fan-out', async ({ page, context }) => {
    const session = await context.newCDPSession(page)
    await session.send('Network.enable')
    const commands: string[] = []
    session.on('Network.webSocketFrameSent', event => {
      try {
        const message = JSON.parse(event.response.payloadData) as { type?: unknown }
        if (typeof message.type === 'string') commands.push(message.type)
      } catch {
        // 非 JSON 帧由协议客户端自行处理，不计入命令断言。
      }
    })

    await page.goto('/')
    await expect(page.getByRole('textbox', { name: '输入空间分析需求' })).toBeVisible()
    await page.waitForTimeout(1800)
    expect(commands.filter(type => type === 'workspace:bootstrap')).toHaveLength(1)
    expect(commands.filter(type => type === 'thread:get')).toHaveLength(0)
    expect(commands.filter(type => type === 'tool:list')).toHaveLength(0)
    expect(commands.filter(type => type === 'runtime-config:get')).toHaveLength(0)

    await page.getByRole('button', { name: '历史对话' }).first().click()
    await expect(page.getByRole('region', { name: '最近对话' })).toBeVisible()
    expect(commands.filter(type => type === 'run:list')).toHaveLength(0)
    expect(commands.filter(type => type === 'thread:get')).toHaveLength(0)
  })

  test('opens the workspace and clears the composer after submission', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/')
    await expect(page.getByRole('textbox', { name: '输入空间分析需求' })).toBeVisible()
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    await expect(page.locator('.workbench-footer-row').filter({ hasText: '模型' })).toContainText('待命')

    const composer = page.getByRole('textbox', { name: '输入空间分析需求' })
    const query = `浏览器验收：查询杭州中心点 ${Date.now()}`
    await composer.fill(query)
    await composer.press('Enter')
    await expect(composer).toHaveValue('')
    await expect(page.getByRole('article', { name: '用户消息' }).filter({ hasText: query })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('opens debug page and keeps invalid JSON inside the tool form', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/debug')
    await expect(page.locator('.panel__eyebrow').filter({ hasText: '工具工作台' })).toBeVisible()
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    await expect(page.getByText('与 manifest 不一致', { exact: false })).toHaveCount(0)

    const select = page.locator('#debug-tool-select')
    await select.selectOption('spatial_analysis')
    const jsonFields = page.locator('.tool-field__textarea')
    await expect(jsonFields.first()).toBeVisible()
    await jsonFields.first().fill('{')
    await expect(page.locator('.clarification-box--error')).toContainText('JSON 参数格式不正确')
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('shows scoped GIS and meteorology developer tools without shell or background task tools', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/debug')
    await expect(page.locator('.panel__eyebrow').filter({ hasText: '工具工作台' })).toBeVisible()

    await expect.poll(async () => (
      page.locator('#debug-tool-select option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))
    )).toContainEqual('read_file')
    const optionValues = await page.locator('#debug-tool-select option')
      .evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))

    expect(optionValues).toEqual(expect.arrayContaining([
      'read_file',
      'write_file',
      'edit_file',
      'glob_files',
      'grep_files',
      'todo_write',
    ]))
    expect(optionValues).not.toEqual(expect.arrayContaining([
      'run_powershell',
      'run_bash',
      'task_create',
      'task_list',
    ]))

    await page.locator('#debug-tool-select').selectOption('read_file')
    await expect(page.locator('.tool-lab__meta')).toContainText('读取允许根目录')
    await expect(page.getByText('文件路径', { exact: true })).toBeVisible()
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('supports mobile panel tabs and multiline composer without horizontal overflow', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/')

    const composer = page.getByRole('textbox', { name: '输入空间分析需求' })
    await expect(composer).toBeVisible()
    await composer.fill('帮我看看杭州今天的短时强降水风险')
    await composer.press('Shift+Enter')
    await composer.pressSequentially('重点看主城区和西湖周边。')
    await expect(composer).toHaveValue(/短时强降水风险\n重点看/)

    const mobileTabs = page.getByRole('navigation', { name: '移动端工作台面板' })
    await expect(mobileTabs).toBeVisible()
    await mobileTabs.getByRole('button', { name: '地图' }).click()
    await expect(page.locator('.workbench-pane--map-primary')).toBeVisible()
    await mobileTabs.getByRole('button', { name: '结果' }).click()
    await expect(page.locator('.workbench-pane--inspector')).toBeVisible()
    await mobileTabs.getByRole('button', { name: '工具' }).click()
    await expect(page.locator('.workbench-pane--tools')).toBeVisible()
    await mobileTabs.getByRole('button', { name: '对话' }).click()
    await expect(page.locator('.workbench-pane--chat')).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('swaps conversation and map panes between meteorology and map browsing modes', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/')

    const content = page.locator('.workbench-content')
    await expect(content).toHaveAttribute('data-map-mode', 'false')
    await expect(page.locator('.workbench-pane--chat').getByRole('textbox', { name: '输入空间分析需求' })).toBeVisible()
    await expect(page.locator('.workbench-side-swap--map').getByRole('region', { name: '空间地图' })).toBeVisible()

    await page.getByLabel('工作台模式').getByRole('button', { name: '地图浏览' }).click()
    await expect(content).toHaveAttribute('data-map-mode', 'true')
    await expect(page.locator('.workbench-pane--map-primary').getByRole('region', { name: '空间地图' })).toBeVisible()
    const sideChat = page.locator('.workbench-side-swap--chat')
    await expect(sideChat.getByRole('textbox', { name: '输入空间分析需求' })).toBeVisible()
    const sideChatPanelAlpha = await sideChat.locator('.cc-panel').evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(cssAlpha(sideChatPanelAlpha)).toBeGreaterThan(0.85)

    await sideChat.getByRole('button', { name: '放大对话框' }).click()
    const expandedDialog = page.getByRole('dialog', { name: '对话框全屏视图' })
    await expect(expandedDialog).toBeVisible()
    await expect.poll(async () => (await expandedDialog.boundingBox())?.width ?? 0).toBeGreaterThan(900)
    await expect.poll(async () => (await expandedDialog.boundingBox())?.height ?? 0).toBeGreaterThan(650)
    await expandedDialog.getByRole('button', { name: '收起对话框' }).click()
    await expect(expandedDialog).toHaveCount(0)
    await sideChat.getByRole('button', { name: '放大对话框' }).click()
    await expect(expandedDialog).toBeVisible()
    await expect.poll(async () => (await expandedDialog.boundingBox())?.width ?? 0).toBeGreaterThan(900)
    await expandedDialog.getByRole('button', { name: '收起对话框' }).click()
    await expect(expandedDialog).toHaveCount(0)

    await page.getByLabel('工作台模式').getByRole('button', { name: '气象分析' }).click()
    await expect(content).toHaveAttribute('data-map-mode', 'false')
    await expect(page.locator('.workbench-pane--chat').getByRole('textbox', { name: '输入空间分析需求' })).toBeVisible()
    await expect(page.locator('.workbench-side-swap--map').getByRole('region', { name: '空间地图' })).toBeVisible()
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('opens ArcGIS-style layer manager from the inspector layer action', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/')
    await page.getByRole('region', { name: '空间地图' }).getByRole('button', { name: '图层', exact: true }).click()

    const panel = page.getByRole('region', { name: '图层管理' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: '内容' })).toBeVisible()
    await expect(panel.getByPlaceholder('搜索')).toBeVisible()
    await expect(panel.getByText('绘制顺序', { exact: true })).toBeVisible()
    await expect(panel.getByRole('tree', { name: '地图图层树' })).toBeVisible()
    await expect(panel.getByText('世界地形图')).toBeVisible()
    await expect(panel.getByText('全球山影')).toBeVisible()
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('shows third-party meteorology mini-app consoles in the debug workbench', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/debug')
    await expect(page.locator('.panel__eyebrow').filter({ hasText: '工具工作台' })).toBeVisible()

    const select = page.locator('#debug-tool-select')
    await select.selectOption('render_radar_mosaic')
    await expect(page.getByRole('heading', { name: '天气雷达组网拼图控制台' })).toBeVisible()
    const radarWorkflow = page.getByLabel('天气雷达组网拼图控制台 流程台')
    await expect(radarWorkflow).toContainText('站点与时次')
    await expect(radarWorkflow).toContainText('radar_station_collection')

    await select.selectOption('render_rainfall_risk_map')
    await expect(page.getByRole('heading', { name: '短时强降水风险区划图' })).toBeVisible()
    await expect(page.getByLabel('短时强降水风险区划图 流程台')).toContainText('阈值调色板')

    await select.selectOption('generate_area_rainfall_table')
    await expect(page.getByRole('heading', { name: '区域累计面雨量排行表' })).toBeVisible()
    await expect(page.getByLabel('区域累计面雨量排行表 流程台')).toContainText('Excel 下载件')
    expect(errors).toEqual([])
  })
})

function collectUnexpectedErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

function cssAlpha(color: string): number {
  if (color === 'transparent') return 0
  const parts = color.match(/rgba?\(([^)]+)\)/)?.[1]?.split(',').map(part => part.trim())
  if (!parts) return 0
  return parts.length >= 4 ? Number.parseFloat(parts[3]) : 1
}
