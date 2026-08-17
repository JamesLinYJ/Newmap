// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行实时传输投影测试
//
//   文件:       runTransportProjection.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { gzipSync } from 'node:zlib'

import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  runSnapshotSchema,
} from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import {
  projectConversationItemForTransport,
  projectRunEventForTransport,
  projectRunForTransport,
  projectRunSnapshotForTransport,
} from './runTransportProjection.js'

describe('run realtime transport projection', () => {
  it('never transports the internal runtime configuration snapshot', () => {
    const run = analysisRunSchema.parse({
      id: 'run_secret_projection',
      sessionId: 'session_1',
      threadId: 'thread_1',
      workspaceId: 'workspace_1',
      visibility: 'workspace',
      userQuery: '测试配置投影',
      status: 'queued',
      runtimeConfigSnapshot: {
        sdk: {
          mcp: {
            enabled: true,
            servers: [{
              name: 'private-mcp',
              transport: 'streamable_http',
              url: 'https://mcp.example.test',
              headers: { Authorization: 'Bearer secret-value' },
              env: { API_TOKEN: 'secret-value' },
            }],
          },
        },
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
      state: { sessionId: 'session_1', threadId: 'thread_1', userQuery: '测试配置投影' },
    })

    const projected = projectRunForTransport(run)

    expect(run.runtimeConfigSnapshot).not.toBeNull()
    expect(projected.runtimeConfigSnapshot).toBeNull()
    expect(JSON.stringify(projected)).not.toContain('secret-value')
  })

  it('keeps canonical large values server-side and produces a bounded client snapshot', () => {
    const coordinates = Array.from({ length: 14_000 }, (_, index) => [
      118 + index / 100_003,
      29 + index / 200_003,
    ])
    const largeValue = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { name: '杭州短临边界' },
      }],
    }
    const run = analysisRunSchema.parse({
      id: 'run_projection',
      sessionId: 'session_projection',
      threadId: 'thread_projection',
      visibility: 'workspace',
      userQuery: '分析连续 NC 文件',
      status: 'completed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
      state: {
        sessionId: 'session_projection',
        threadId: 'thread_projection',
        userQuery: '分析连续 NC 文件',
        toolValueRefs: [{
          refId: 'ref_large_geometry',
          kind: 'feature_collection',
          label: '完整杭州边界',
          value: largeValue,
        }],
        toolResults: [{
          stepId: 'step_1',
          tool: 'query_layer',
          status: 'completed',
          message: '已查询图层',
          valueRefs: [{
            refId: 'ref_large_geometry',
            kind: 'feature_collection',
            label: '完整杭州边界',
            value: largeValue,
          }],
        }],
      },
    })
    const output = conversationItemSchema.parse({
      itemId: 'item_output',
      itemType: 'function_call_output',
      runId: run.id,
      threadId: run.threadId,
      callId: 'call_1',
      output: JSON.stringify({
        message: '已查询杭州图层',
        payload: largeValue,
        resultId: 'result_query',
      }),
      status: 'completed',
      timestamp: new Date(1).toISOString(),
    })
    const answer = conversationItemSchema.parse({
      itemId: 'item_answer',
      itemType: 'message',
      runId: run.id,
      threadId: run.threadId,
      role: 'assistant',
      body: '杭州未来三小时累计雨量约 7.4 mm。',
      status: 'completed',
      timestamp: new Date(2).toISOString(),
    })
    const event = runEventSchema.parse({
      eventId: 'event_tool',
      runId: run.id,
      threadId: run.threadId,
      type: 'tool.completed',
      message: '图层查询完成',
      timestamp: new Date(1).toISOString(),
      payload: { toolName: 'query_layer', result: largeValue },
    })

    const snapshot = runSnapshotSchema.parse({
      run,
      items: [output, answer],
      events: [event],
      itemStream: {
        streamId: 'stream_projection',
        cursors: [
          { itemId: output.itemId, sequence: 0, utf16Offset: 0 },
          { itemId: answer.itemId, sequence: 0, utf16Offset: answer.body?.length ?? 0 },
        ],
      },
    })
    const projected = projectRunSnapshotForTransport(snapshot)
    const wire = JSON.stringify({
      type: 'run.snapshot',
      id: null,
      payload: { data: projected },
    })

    expect(run.state.toolValueRefs[0]?.value).toEqual(largeValue)
    expect(projected.run.state.toolValueRefs[0]?.value).toBeNull()
    expect(projected.items.at(-1)?.body).toBe('杭州未来三小时累计雨量约 7.4 mm。')
    expect(projected.items[0]?.output).toContain('bounded_json')
    expect(projected.events[0]?.payload.transportProjection).toBe('bounded_run_event')
    expect(gzipSync(wire).byteLength).toBeLessThan(48 * 1024)
  })

  it('bounds individual incremental tool items and events', () => {
    const raw = JSON.stringify({ values: Array.from({ length: 50_000 }, (_, index) => index / 7) })
    const item = conversationItemSchema.parse({
      itemId: 'item_large',
      itemType: 'function_call_output',
      runId: 'run_1',
      output: raw,
      timestamp: new Date(0).toISOString(),
    })
    const event = runEventSchema.parse({
      eventId: 'event_large',
      runId: 'run_1',
      type: 'tool.completed',
      message: '完成',
      timestamp: new Date(0).toISOString(),
      payload: { raw },
    })

    expect(Buffer.byteLength(JSON.stringify(projectConversationItemForTransport(item)), 'utf8'))
      .toBeLessThan(24 * 1024)
    expect(Buffer.byteLength(JSON.stringify(projectRunEventForTransport(event)), 'utf8'))
      .toBeLessThan(16 * 1024)
  })

  it('keeps streamed message and reasoning bodies exact beyond the old 48 KiB projection limit', () => {
    const body = '杭州短临结论。'.repeat(10_000)
    for (const itemType of ['message', 'reasoning'] as const) {
      const item = conversationItemSchema.parse({
        itemId: `item_${itemType}`,
        itemType,
        runId: 'run_1',
        role: 'assistant',
        body,
        status: 'completed',
        timestamp: new Date(0).toISOString(),
      })

      expect(projectConversationItemForTransport(item).body).toBe(body)
    }
  })

  it('keeps an early running item in a capped snapshot so its next delta remains recoverable', () => {
    const run = analysisRunSchema.parse({
      id: 'run_active_overlay', sessionId: 'session_1', threadId: 'thread_1',
      visibility: 'workspace', userQuery: '测试', status: 'running',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString(),
      state: { sessionId: 'session_1', threadId: 'thread_1', userQuery: '测试' },
    })
    const items = Array.from({ length: 602 }, (_, index) => conversationItemSchema.parse({
      itemId: `item_${index}`, itemType: 'message', runId: run.id, threadId: run.threadId,
      role: 'assistant', body: index === 0 ? '仍在生成' : `历史 ${index}`,
      status: index === 0 ? 'running' : 'completed',
      timestamp: new Date(index).toISOString(),
    }))
    const snapshot = runSnapshotSchema.parse({
      run,
      items,
      events: [],
      itemStream: {
        streamId: 'stream_active_overlay',
        cursors: items.map(item => ({
          itemId: item.itemId,
          sequence: 0,
          utf16Offset: (item.body ?? '').length,
        })),
      },
    })

    const projected = projectRunSnapshotForTransport(snapshot)

    expect(projected.items).toHaveLength(601)
    expect(projected.items[0]?.itemId).toBe('item_0')
    expect(projected.itemStream.cursors).toContainEqual({
      itemId: 'item_0', sequence: 0, utf16Offset: 4,
    })
  })

  it('charges string budgets by actual content instead of the per-field cap', () => {
    const artifact = {
      artifactId: 'artifact_preview',
      artifactType: 'raster_png',
      name: '风险图预览',
      uri: '/api/v1/results/artifact_preview',
      display: {
        primarySurface: 'mini_app',
        surfaces: ['mini_app', 'download'],
        map: null,
      },
    }
    const item = conversationItemSchema.parse({
      itemId: 'item_artifact',
      itemType: 'function_call_output',
      runId: 'run_1',
      output: '{}',
      metadata: { artifacts: [artifact] },
      timestamp: new Date(0).toISOString(),
    })

    expect(projectConversationItemForTransport(item).metadata).toMatchObject({
      artifacts: [artifact],
    })
  })
})
