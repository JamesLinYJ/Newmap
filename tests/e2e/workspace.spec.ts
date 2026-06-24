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
  test('uses one bootstrap request and loads run history without thread fan-out', async ({ page, context }) => {
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

    await page.getByRole('button', { name: '历史', exact: true }).first().click()
    await expect.poll(() => commands.filter(type => type === 'run:list').length).toBe(1)
    expect(commands.filter(type => type === 'thread:get')).toHaveLength(0)
  })

  test('opens the workspace and clears the composer after submission', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/')
    await expect(page.getByRole('textbox', { name: '输入空间分析需求' })).toBeVisible()
    await expect(page.getByText('页面遇到问题')).toHaveCount(0)
    await expect(page.locator('.workspace-overview article').filter({ hasText: '模型' })).toContainText('待命')

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

  test('shows third-party weather mini-app consoles in the debug workbench', async ({ page }) => {
    const errors = collectUnexpectedErrors(page)
    await page.goto('/debug')
    await expect(page.locator('.panel__eyebrow').filter({ hasText: '工具工作台' })).toBeVisible()

    const select = page.locator('#debug-tool-select')
    await select.selectOption('render_radar_mosaic')
    await expect(page.getByRole('heading', { name: '雷达拼图控制台' })).toBeVisible()
    const radarWorkflow = page.getByLabel('雷达拼图控制台 流程台')
    await expect(radarWorkflow).toContainText('站点与时次')
    await expect(radarWorkflow).toContainText('radar_station_collection')

    await select.selectOption('render_rainfall_risk_map')
    await expect(page.getByRole('heading', { name: '降雨风险区划图' })).toBeVisible()
    await expect(page.getByLabel('降雨风险区划图 流程台')).toContainText('阈值调色板')

    await select.selectOption('generate_area_rainfall_table')
    await expect(page.getByRole('heading', { name: '面雨量表格' })).toBeVisible()
    await expect(page.getByLabel('面雨量表格 流程台')).toContainText('Excel 下载件')
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
