// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runs 路由（ConversationItem stream）
//
//   文件:       runs.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { ToolRegistry } from '../tools.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import { GeoAgentRuntime } from '../agent/runtime.js'

// Default runtime config (matches Python supervisor_config.build_default_runtime_config)
function defaultRuntimeConfig(): AgentRuntimeConfig {
  return {
    loopTraceLimit: 80,
    maxTurns: 50,
    supervisor: {
      name: 'geo_agent_supervisor',
      systemPrompt: '',
      approvalInterruptTools: ['import_managed_layer', 'export_collection', 'create_weather_report'],
      permissionRules: [],
    },
    subAgents: [
      {
        agentId: 'spatial_analyst',
        name: '空间分析助手',
        role: 'spatial_analyst',
        summary: '负责地理空间分析和图层查询',
        systemPrompt: '你是一个空间分析专家，可以使用 GIS 工具分析地理数据。',
        tools: ['geocode_place', 'query_layer', 'spatial_analysis', 'create_chart'],
      },
    ],
    ui: { transcriptMaxEntries: 40, showInternalReasoningLabels: true, eventGroupingWindowMs: 1500 },
    catalog: { allowEmptyCatalog: true, adminEnabled: true },
    planning: { maxPlanRepairRounds: 2, allowTextOnlyDelivery: true, externalSourcePriority: ['catalog', 'external_poi', 'geosearch'] },
    context: {
      memoryFilePaths: ['/AGENTS.md', '/THREAD_CONTEXT.md'],
      historyRunLimit: 4, eventWindow: 24, toolCallWindow: 8,
      artifactWindow: 6, warningWindow: 6, promptMaxChars: 12000,
      contextEntryWindow: 18, memoryFileCharLimit: 4000,
      memoryEnabled: true, memoryBaseDir: '.geoagent/memory',
    },
    geosearch: { provider: 'nominatim', enabled: true, baseUrl: 'https://nominatim.openstreetmap.org', userAgent: 'geo-agent-platform/0.1', timeoutMs: 2500, maxCandidates: 5 },
    externalPoi: { provider: 'overpass', enabled: true, baseUrl: 'https://overpass-api.de/api/interpreter', userAgent: 'geo-agent-platform/0.1', timeoutMs: 8000, maxResults: 200 },
    nowcast: {
      defaultCityName: '杭州市', forecastHorizonMinutes: 180, pointBufferMeters: 1000,
      districtLayerKey: null, districtNameField: null,
      rainLevelThresholds: { none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 },
      candidateLimit: 12,
    },
    hookConfigs: [],
  }
}

export function runRoutes(
  store: PostgresPlatformStore,
  toolRegistry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
) {
  const runtime = new GeoAgentRuntime(store, toolRegistry, modelRegistry)

  return new Hono()
    // Create a new run
    .post('/api/v2/runs', async (c) => {
      const body = await c.req.json<{
        sessionId: string; query: string; threadId?: string | null
        modelProvider?: string | null; modelName?: string | null
        clarificationOptionId?: string | null; executionMode?: 'plan' | 'auto'
      }>()

      if (!body.sessionId?.trim()) return c.json({ detail: 'sessionId 不能为空。' }, 400)
      if (!body.query?.trim()) return c.json({ detail: 'query 不能为空。' }, 400)

      const runtimeConfig = defaultRuntimeConfig()
      const run = store.createRun(body.sessionId, body.query, {
        threadId: body.threadId,
        modelProvider: body.modelProvider,
        modelName: body.modelName,
        runtimeConfigSnapshot: runtimeConfig,
      })

      startRuntimeRun(runtime, run.id, body.query, {
        threadId: run.threadId,
        sessionId: run.sessionId,
        provider: body.modelProvider ?? 'openai_compatible',
        modelName: body.modelName ?? undefined,
        clarificationOptionId: body.clarificationOptionId,
        executionMode: body.executionMode ?? 'auto',
        runtimeConfig,
      })

      return c.json(run)
    })

    .post('/api/v2/threads/:threadId/runs', async (c) => {
      const threadId = c.req.param('threadId')
      const body = await c.req.json<{
        query: string
        modelProvider?: string | null
        modelName?: string | null
        clarificationOptionId?: string | null
        executionMode?: 'plan' | 'auto'
      }>()

      if (!body.query?.trim()) return c.json({ detail: 'query 不能为空。' }, 400)

      try {
        const thread = store.getThread(threadId)
        const runtimeConfig = defaultRuntimeConfig()
        const run = store.createRun(thread.sessionId, body.query, {
          threadId,
          modelProvider: body.modelProvider,
          modelName: body.modelName,
          runtimeConfigSnapshot: runtimeConfig,
        })
        await store.updateThread(threadId, {
          latestRunId: run.id,
          latestUserQuery: body.query,
          latestRunStatus: run.status,
          runCount: thread.runCount + 1,
        })

        startRuntimeRun(runtime, run.id, body.query, {
          threadId,
          sessionId: run.sessionId,
          provider: body.modelProvider ?? 'openai_compatible',
          modelName: body.modelName ?? undefined,
          clarificationOptionId: body.clarificationOptionId,
          executionMode: body.executionMode ?? 'auto',
          runtimeConfig,
        })

        return c.json(run)
      } catch {
        return c.json({ detail: '线程不存在' }, 404)
      }
    })

    .get('/api/v2/runs/:runId/events.json', (c) => {
      return c.json(store.listEvents(c.req.param('runId')))
    })

    .get('/api/v2/runs/:runId/items', (c) => {
      return c.json(store.listItems(c.req.param('runId')))
    })

    .get('/api/v2/runs/:runId/items/stream', (c) => {
      const runId = c.req.param('runId')

      return streamSSE(c, async (stream) => {
        const seenItemIds = new Set<string>()
        for (const item of store.listItems(runId)) {
          seenItemIds.add(item.itemId)
          await stream.writeSSE({
            id: item.itemId,
            event: item.status === 'running' ? 'item/started' : 'item/completed',
            data: JSON.stringify(item),
          })
        }

        const unsubItem = store.itemBus.subscribe(runId, async (item) => {
          const isFirstFrame = !seenItemIds.has(item.itemId)
          seenItemIds.add(item.itemId)
          await stream.writeSSE({
            id: item.itemId,
            event: item.status === 'running'
              ? isFirstFrame ? 'item/started' : 'item/delta'
              : 'item/completed',
            data: JSON.stringify(item),
          })
        })

        const keepAlive = setInterval(async () => {
          try { await stream.writeSSE({ event: 'keep_alive', data: '' }) } catch { /* client disconnected */ }
        }, 15000)

        await waitUntilClosed(stream, () => {
          clearInterval(keepAlive)
          unsubItem()
        })
      })
    })

    // Diagnostic SSE stream for run events. Chat UI must not consume this.
    .get('/api/v2/runs/:runId/events', (c) => {
      const runId = c.req.param('runId')

      return streamSSE(c, async (stream) => {
        for (const event of store.listEvents(runId)) {
          await stream.writeSSE({
            id: event.eventId,
            event: event.type,
            data: JSON.stringify(event),
          })
        }

        const unsubEvent = store.eventBus.subscribe(runId, async (event) => {
          await stream.writeSSE({
            id: event.eventId,
            event: event.type,
            data: JSON.stringify(event),
          })
        })

        const keepAlive = setInterval(async () => {
          try { await stream.writeSSE({ event: 'keep_alive', data: '' }) } catch { /* client disconnected */ }
        }, 15000)

        await waitUntilClosed(stream, () => {
          clearInterval(keepAlive)
          unsubEvent()
        })
      })
    })

    // Get run by id
    .get('/api/v2/runs/:runId', (c) => {
      try {
        return c.json(store.getRun(c.req.param('runId')))
      } catch {
        return c.json({ detail: '运行不存在' }, 404)
      }
    })

    .post('/api/v2/runs/:runId/cancel', (c) => {
      try {
        return c.json(runtime.cancel(c.req.param('runId')))
      } catch (error) {
        return c.json({ detail: error instanceof Error ? error.message : '运行取消失败' }, 400)
      }
    })

    // Resolve approval
    .post('/api/v2/runs/:runId/approvals/:approvalId', async (c) => {
      const { approved } = await c.req.json<{ approved: boolean }>()
      try {
        const run = await runtime.resolveApproval(
          c.req.param('runId'),
          c.req.param('approvalId'),
          approved,
        )
        return c.json(run)
      } catch {
        return c.json({ detail: '审批处理失败' }, 400)
      }
    })
}

function startRuntimeRun(
  runtime: GeoAgentRuntime,
  runId: string,
  query: string,
  opts: {
    threadId: string | null
    sessionId: string
    provider: string
    modelName?: string | null
    clarificationOptionId?: string | null
    executionMode: 'plan' | 'auto'
    runtimeConfig: AgentRuntimeConfig
  },
) {
  runtime.run({
    runId,
    threadId: opts.threadId,
    sessionId: opts.sessionId,
    query,
    provider: opts.provider,
    modelName: opts.modelName,
    runtimeConfig: opts.runtimeConfig,
    clarificationOptionId: opts.clarificationOptionId,
    executionMode: opts.executionMode,
  }).catch(err => console.error('Run failed:', err))
}

async function waitUntilClosed(stream: { closed: boolean }, cleanup: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (stream.closed) {
        clearInterval(check)
        cleanup()
        resolve()
      }
    }, 1000)
  })
}
