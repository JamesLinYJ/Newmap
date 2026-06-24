// +-------------------------------------------------------------------------
//
//   地理智能平台 - Demo Provider 契约测试
//
//   文件:       provider.test.ts
//
//   日期:       2026年06月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Demo 测试覆盖工具开发最低边界：Provider 校验、valueRef 输出、未知引用失败
// 和 artifact 文件真实写入。

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext, ValueRef } from '../../../server/src/framework/types.js'
import { validateToolProvider } from '../../../server/src/framework/validation.js'
import demoProvider from '../src/index.js'

describe('demo ToolProvider', () => {
  let runtimeRoot = ''
  const refs = new Map<string, ValueRef>()

  beforeEach(() => {
    runtimeRoot = mkdtempSync(path.join(tmpdir(), 'tool-provider-demo-'))
    process.env.RUNTIME_ROOT = runtimeRoot
    refs.clear()
  })

  afterEach(() => {
    delete process.env.RUNTIME_ROOT
    delete process.env.WORKER_URL
    vi.unstubAllGlobals()
    rmSync(runtimeRoot, { recursive: true, force: true })
  })

  it('passes provider contract validation', () => {
    expect(() => validateToolProvider(demoProvider)).not.toThrow()
  })

  it('creates a valueRef and consumes it to write an artifact', async () => {
    const [collectTool, reportTool] = demoProvider.tools()
    const collectResult = await collectTool.handler({
      station_name: 'City Center',
      observed_value: 12.5,
      unit: 'mm',
    }, context(refs))
    for (const ref of collectResult.valueRefs ?? []) refs.set(ref.refId, ref)

    expect(collectResult.valueRefs?.[0]).toMatchObject({
      kind: 'demo_observation',
      label: 'City Center 观测值',
      unit: 'mm',
    })

    const reportResult = await reportTool.handler({
      observation_ref: collectResult.valueRefs?.[0]?.refId,
      detail_level: 'brief',
    }, context(refs))
    const artifact = reportResult.artifacts?.[0]

    expect(artifact).toMatchObject({
      artifactType: 'json',
      name: 'Demo 观测报告',
    })
    expect(existsSync(path.join(runtimeRoot, ...(artifact?.relativePath ?? '').split('/')))).toBe(true)
    expect(reportResult.valueRefs?.[0]).toMatchObject({ kind: 'demo_report' })
  })

  it('hard-fails unknown value references', async () => {
    const reportTool = demoProvider.tools()[1]

    await expect(reportTool.handler({
      observation_ref: 'missing_ref',
    }, context(refs))).rejects.toThrow('未知 valueRef')
  })

  it('shows a worker-backed mini-app tool and passes only runtime-relative artifact paths', async () => {
    process.env.WORKER_URL = 'http://worker.test'
    const [collectTool, , badgeTool] = demoProvider.tools()
    const collectResult = await collectTool.handler({
      station_name: 'City Center',
      observed_value: 12.5,
      unit: 'mm',
    }, context(refs))
    for (const ref of collectResult.valueRefs ?? []) refs.set(ref.refId, ref)
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({ payload: { width: 480, height: 160 } }),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    const result = await badgeTool.handler({
      observation_ref: collectResult.valueRefs?.[0]?.refId,
      badge_style: 'presentation',
    }, context(refs))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))

    expect(badgeTool.jsonSchema).toMatchObject({
      'x-mini-app': { type: 'demo_observation_badge_console' },
    })
    expect(body.args).toMatchObject({
      badge_style: 'presentation',
      output_relative_path: expect.stringMatching(/^artifacts\/run_demo\/demo_observation_badge_/u),
    })
    expect(path.isAbsolute(body.args.output_relative_path)).toBe(false)
    expect(result.artifacts?.[0]).toMatchObject({
      artifactType: 'raster_png',
      metadata: {
        previewRole: 'demo_observation_badge',
        badgeStyle: 'presentation',
      },
    })
    expect(result.provenance).toMatchObject({
      providerId: 'demo-observation',
      toolName: 'demo_render_observation_badge',
      algorithm: 'demo-worker-backed-v1',
    })
  })

  it('hard-fails worker-backed tools when WORKER_URL is missing', async () => {
    const installContext = {
      config: {},
      state: new Map<string, unknown>(),
      log: () => undefined,
    }

    await expect(demoProvider.onInstall?.(installContext)).rejects.toThrow('WORKER_URL 未配置')
  })
})

function context(refs: Map<string, ValueRef>): ToolContext {
  return {
    runId: 'run_demo',
    sessionId: 'session_demo',
    threadId: 'thread_demo',
    state: new Map(),
    resolveValueRef: (refId) => {
      const ref = refs.get(refId)
      if (!ref) throw new Error(`未知 valueRef：${refId}`)
      return ref
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}
