// +-------------------------------------------------------------------------
//
//   地理智能平台 - StartRun 应用服务测试
//
//   文件:       startRunService.test.ts
//
//   日期:       2026年08月04日
// --------------------------------------------------------------------------

import type { AnalysisRun } from '@geo-agent-platform/shared-types/platform'
import { describe, expect, it, vi } from 'vitest'

import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { scopeMemoryContextConfig } from '../memory/paths.js'
import type { AuthContext } from '../security/types.js'
import { StartRunService } from './startRunService.js'

const RUNTIME_ROOT = '/runtime'

describe('StartRunService', () => {
  it('resolves a thread session, snapshots principal-scoped runtime config, and starts one detached task', async () => {
    const runtimeConfig = defaultRuntimeConfig()
    const auth = testAuth()
    const expectedRuntimeConfig = {
      ...runtimeConfig,
      developer: { ...runtimeConfig.developer, enabled: false },
      context: scopeMemoryContextConfig(RUNTIME_ROOT, runtimeConfig.context, {
        workspaceId: auth.defaultWorkspaceId,
        userId: auth.userId,
      }),
    }
    const run = fakeRun({ threadId: 'thread_existing', modelProvider: 'deepseek' })
    const order: string[] = []
    const startDetached = vi.fn(() => order.push('startDetached'))
    const createRun = vi.fn(async () => {
      order.push('createRun')
      return run
    })
    const beforeLaunch = vi.fn(() => order.push('beforeLaunch'))
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig) },
        getThread: vi.fn(() => ({ sessionId: 'session_from_thread' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })

    const result = await service.start({
      auth,
      query: '查询杭州天气',
      threadId: 'thread_existing',
      provider: null,
      executionMode: 'auto',
      beforeLaunch,
    })

    expect(result).toBe(run)
    expect(createRun).toHaveBeenCalledWith('session_from_thread', '查询杭州天气', {
      threadId: 'thread_existing',
      modelProvider: 'deepseek',
      modelName: null,
      runProfile: 'standard',
      goal: null,
      runtimeConfigSnapshot: expectedRuntimeConfig,
      contextReferences: [],
    })
    expect(startDetached).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      sessionId: 'session_from_thread',
      threadId: 'thread_existing',
      provider: 'deepseek',
      runProfile: 'standard',
      runtimeConfig: expectedRuntimeConfig,
    }), undefined)
    expect(beforeLaunch).toHaveBeenCalledWith(run)
    expect(order).toEqual(['createRun', 'beforeLaunch', 'startDetached'])
  })

  it('removes developer filesystem capability from non-admin runs and preserves it for platform admins', async () => {
    const runtimeConfig = {
      ...defaultRuntimeConfig(),
      developer: { enabled: true, allowedRoots: ['/srv/project'] },
    }
    const snapshots: AnalysisRun['runtimeConfigSnapshot'][] = []
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig) },
        getThread: vi.fn(() => ({ sessionId: 'session_1' } as never)),
        createThread: vi.fn(),
        createRun: vi.fn(async (_sessionId, _query, options) => {
          snapshots.push(options.runtimeConfigSnapshot ?? null)
          return fakeRun({ threadId: 'thread_1', modelProvider: 'deepseek' })
        }),
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached: vi.fn() },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })

    await service.start({
      auth: testAuth(),
      query: '普通分析',
      threadId: 'thread_1',
      beforeLaunch: vi.fn(),
    })
    await service.start({
      auth: testAuth('platform_admin'),
      query: '管理员开发任务',
      threadId: 'thread_1',
      beforeLaunch: vi.fn(),
    })

    expect(snapshots[0]?.developer.enabled).toBe(false)
    expect(snapshots[1]?.developer).toEqual(runtimeConfig.developer)
  })

  it('persists and launches the geospatial Compose profile without creating another runner path', async () => {
    const runtimeConfig = defaultRuntimeConfig()
    const run = fakeRun({ threadId: 'thread_compose', modelProvider: 'deepseek' })
    const createRun = vi.fn(async () => run)
    const startDetached = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig) },
        getThread: vi.fn(() => ({ sessionId: 'session_compose' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })

    await service.start({
      auth: testAuth(),
      query: '完成区域风险分析并复核结果',
      threadId: 'thread_compose',
      runProfile: 'geospatial_compose',
      beforeLaunch: vi.fn(),
    })

    expect(createRun).toHaveBeenCalledWith(
      'session_compose',
      '完成区域风险分析并复核结果',
      expect.objectContaining({ runProfile: 'geospatial_compose' }),
    )
    expect(startDetached).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'auto',
      runProfile: 'geospatial_compose',
    }), undefined)
  })

  it('persists a bounded Goal while keeping it out of the SDK runner options', async () => {
    const runtimeConfig = defaultRuntimeConfig()
    const run = fakeRun({ threadId: 'thread_goal', modelProvider: 'deepseek' })
    const createRun = vi.fn(async () => run)
    const startDetached = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig) },
        getThread: vi.fn(() => ({ sessionId: 'session_goal' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })
    const goal = {
      condition: '完成区域风险分析并提供客观证据。',
      acceptanceCriteria: ['分析步骤已完成', '存在可复核工具证据'],
      maxRechecks: 2,
      deadlineAt: '2099-08-08T12:00:00.000Z',
      maxTokenBudget: 20_000,
    }

    await service.start({
      auth: testAuth(),
      query: '完成区域风险分析',
      threadId: 'thread_goal',
      goal,
      beforeLaunch: vi.fn(),
    })

    expect(createRun).toHaveBeenCalledWith('session_goal', '完成区域风险分析', expect.objectContaining({ goal }))
    expect(startDetached).toHaveBeenCalledWith(expect.not.objectContaining({ goal: expect.anything() }), undefined)
  })

  it('rejects an expired Goal before usage admission or run creation', async () => {
    const createRun = vi.fn()
    const assertWorkspaceCanStartModelRun = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(defaultRuntimeConfig()) },
        getThread: vi.fn(() => ({ sessionId: 'session_goal' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached: vi.fn() },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })

    await expect(service.start({
      auth: testAuth(),
      query: '已过期目标',
      threadId: 'thread_goal',
      goal: {
        condition: '必须在过去完成。',
        acceptanceCriteria: [],
        maxRechecks: 1,
        deadlineAt: '2000-01-01T00:00:00.000Z',
        maxTokenBudget: null,
      },
      beforeLaunch: vi.fn(),
    })).rejects.toThrow('Goal 截止时间必须晚于当前时间')
    expect(assertWorkspaceCanStartModelRun).not.toHaveBeenCalled()
    expect(createRun).not.toHaveBeenCalled()
  })

  it('persists authorized map screenshot references without binary or Base64 payloads', async () => {
    const runtimeConfig = defaultRuntimeConfig()
    const run = fakeRun({ threadId: 'thread_map', modelProvider: 'vision' })
    const createRun = vi.fn(async () => run)
    const startDetached = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig) },
        getThread: vi.fn(() => ({ sessionId: 'session_map' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'vision' },
      runTasks: { startDetached },
      fileLifecycle: { list: vi.fn().mockResolvedValue([{
        id: 'file_map',
        name: 'map.png',
        sourceRelativePath: 'map.png',
        size: '8 B',
        sizeBytes: 8,
        uploadedAt: '2026-08-08T04:00:00.000Z',
        status: 'ready',
        threadId: 'thread_map',
        relativePath: `objects/sha256/aa/${'a'.repeat(64)}.png`,
        contentHash: 'a'.repeat(64),
        mediaType: 'image/png',
      }]) },
    })
    const mapContext = {
      capturedAt: '2026-08-08T04:00:00.000Z',
      viewport: { bounds: [119, 29, 121, 31] as [number, number, number, number], center: [120, 30] as [number, number], zoom: 8, bearing: 0, pitch: 20 },
      crs: 'OGC:CRS84',
      renderProjection: 'EPSG:3857',
      renderState: { status: 'idle' as const, tilesLoaded: true as const },
      renderedLayers: [],
      timeRange: null,
    }

    await service.start({
      auth: testAuth(),
      query: '解释地图截图',
      threadId: 'thread_map',
      attachments: [{
        fileId: 'file_map',
        name: 'map.png',
        mediaType: 'image/png',
        kind: 'map_screenshot',
        mapContext,
      }],
      beforeLaunch: vi.fn(),
    })

    const persistedOptions = createRun.mock.calls[0]?.[2]
    expect(persistedOptions?.contextReferences).toEqual([
      expect.objectContaining({
        referenceId: 'attachment:file_map',
        kind: 'map_screenshot',
        metadata: expect.objectContaining({ fileId: 'file_map', mapContext }),
      }),
    ])
    expect(JSON.stringify(persistedOptions)).not.toContain('base64')
    expect(JSON.stringify(persistedOptions)).not.toContain('data:image')
  })

  it('rejects an attachment that is not visible in the target thread before creating a run', async () => {
    const createRun = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(defaultRuntimeConfig()) },
        getThread: vi.fn(() => ({ sessionId: 'session_1' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached: vi.fn() },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })

    await expect(service.start({
      auth: testAuth(),
      query: '读取附件',
      threadId: 'thread_1',
      attachments: [{
        fileId: 'file_other',
        name: 'other.png',
        mediaType: 'image/png',
        kind: 'image',
        mapContext: null,
      }],
      beforeLaunch: vi.fn(),
    })).rejects.toThrow('不属于当前线程')
    expect(createRun).not.toHaveBeenCalled()
  })

  it('fails before creating a run when no provider is configured', async () => {
    const createRun = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeRoot: RUNTIME_ROOT,
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(null) },
        getThread: vi.fn(),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: '' },
      runTasks: { startDetached: vi.fn() },
      fileLifecycle: { list: vi.fn().mockResolvedValue([]) },
    })

    await expect(service.start({
      auth: testAuth(),
      query: '没有 provider',
      sessionId: 'session_1',
      beforeLaunch: vi.fn(),
    })).rejects.toThrow('必须显式指定模型 provider')
    expect(createRun).not.toHaveBeenCalled()
  })
})

function fakeRun(overrides: Partial<AnalysisRun>): AnalysisRun {
  return {
    id: 'run_1',
    threadId: null,
    sessionId: 'session_1',
    workspaceId: null,
    createdByUserId: 'user_1',
    visibility: 'private',
    userQuery: 'query',
    modelProvider: null,
    modelName: null,
    status: 'queued',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    state: {} as AnalysisRun['state'],
    conversationPath: null,
    runtimeConfigSnapshot: null,
    ...overrides,
  }
}

function testAuth(role: AuthContext['roles'][number]['role'] = 'analyst'): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.com',
    displayName: 'Test User',
    authSessionId: 'session_auth_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf_1',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role }],
  }
}
