// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 运行命令
//
//   文件:       runCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'
import {
  agentRunProfileSchema,
  runAttachmentsSchema,
  runGoalInputSchema,
} from '../schemas/types.js'

import { assertRunCheckpointResumable } from '../agent/runResumePolicy.js'
import { optionalPositiveInteger, requiredRunProvider } from './payload.js'
import { respondDecision } from './decisionCommand.js'
import { reserveRunCapture, sendRunSnapshot, snapshotRun, subscribeToRun } from './subscriptions.js'
import { projectRunForTransport } from './runTransportProjection.js'
import type { WsCommandRegistry } from './commandRegistry.js'
import type { AuthContext } from '../security/types.js'

const runListPayloadSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const runIdPayloadSchema = z.object({ runId: z.string().min(1) }).passthrough()
const runSteerPayloadSchema = z.object({
  runId: z.string().min(1),
  steeringId: z.string().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
}).strict()
const runStartPayloadSchema = z.object({
  query: z.string().min(1),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelProvider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
  executionMode: z.enum(['auto', 'plan']).optional(),
  runProfile: agentRunProfileSchema.optional(),
  goal: runGoalInputSchema.nullable().optional(),
  reasoning: z.boolean().optional(),
  attachments: runAttachmentsSchema.default([]),
}).passthrough()
const respondDecisionPayloadSchema = z.object({
  runId: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1).nullable().optional(),
  text: z.string().nullable().optional(),
}).passthrough()

export function registerRunCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'run:list',
    payloadSchema: runListPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      const limit = optionalPositiveInteger(payload.limit, 'limit')
      return context.dependencies.store.listRunSummaries({
        sessionId: payload.sessionId,
        threadId: payload.threadId ?? null,
        cursor: payload.cursor ?? null,
        ...(limit !== undefined ? { limit } : {}),
      })
    },
  })

  registry.register({
    type: 'run:start',
    payloadSchema: runStartPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const auth = requireAuth(context.auth)
      const run = await context.dependencies.startRunService.start({
        auth,
        query: payload.query,
        sessionId: payload.sessionId ?? null,
        threadId: payload.threadId ?? null,
        provider: payload.provider ?? null,
        modelProvider: payload.modelProvider ?? null,
        modelName: payload.modelName ?? null,
        executionMode: payload.executionMode === 'plan' ? 'plan' : 'auto',
        runProfile: payload.runProfile ?? 'standard',
        goal: payload.goal ?? null,
        reasoning: payload.reasoning !== false,
        attachments: payload.attachments,
        beforeLaunch: run => subscribeToRun(
          context.ws,
          run.id,
          context.dependencies.store,
          context.dependencies.events,
          context.subscriptions,
        ),
        completion: { onComplete: runId => sendRunSnapshot(context.ws, runId, context.dependencies.store) },
      })
      return projectRunForTransport(run)
    },
  })

  registry.register({
    type: 'run:get',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      const scheduled = reserveRunCapture<Awaited<ReturnType<typeof snapshotRun>>>(context.ws, payload.runId)
      context.setResponseDelivery(scheduled.deliver)
      return scheduled.start(() => snapshotRun(payload.runId, context.dependencies.store))
    },
  })

  registry.register({
    type: 'run:cancel',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => projectRunForTransport(await context.runTasks.cancel(payload.runId)),
  })

  registry.register({
    type: 'run:steer',
    payloadSchema: runSteerPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.runTasks.steer(
      payload.runId,
      payload.steeringId,
      payload.content,
    ),
  })

  registry.register({
    type: 'run:resume',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const auth = requireAuth(context.auth)
      const run = context.dependencies.store.getRun(payload.runId)
      const checkpoint = await context.dependencies.store.getRunCheckpoint(payload.runId)
      assertRunCheckpointResumable(run, checkpoint)
      if (!run.threadId) throw new Error(`运行 '${payload.runId}' 缺少 threadId`)
      if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${payload.runId}' 缺少 runtimeConfigSnapshot`)
      context.dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
      subscribeToRun(context.ws, payload.runId, context.dependencies.store, context.dependencies.events, context.subscriptions)
      context.runTasks.startDetachedIfIdle({
        runId: payload.runId,
        threadId: run.threadId,
        sessionId: run.sessionId,
        query: run.userQuery,
        provider: requiredRunProvider(run.modelProvider),
        modelName: run.modelName,
        runtimeConfig: run.runtimeConfigSnapshot,
        runProfile: run.state.runProfile,
        resume: true,
        auth,
      }, { onComplete: runId => sendRunSnapshot(context.ws, runId, context.dependencies.store) })
      return projectRunForTransport(context.dependencies.store.getRun(payload.runId))
    },
  })

  registry.register({
    type: 'run:respond-decision',
    payloadSchema: respondDecisionPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => projectRunForTransport(await respondDecision(
      payload,
      context.dependencies,
      context.runTasks,
      context.ws,
      context.subscriptions,
      requireAuth(context.auth),
    )),
  })

  registry.register({
    type: 'run:subscribe',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      const scheduled = reserveRunCapture<Awaited<ReturnType<typeof snapshotRun>>>(context.ws, payload.runId)
      context.setResponseDelivery(scheduled.deliver)
      try {
        subscribeToRun(context.ws, payload.runId, context.dependencies.store, context.dependencies.events, context.subscriptions)
      } catch (error) {
        scheduled.cancel()
        throw error
      }
      return scheduled.start(() => snapshotRun(payload.runId, context.dependencies.store))
    },
  })

  registry.register({
    type: 'run:unsubscribe',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      context.subscriptions.get(payload.runId)?.()
      context.subscriptions.delete(payload.runId)
      return { unsubscribed: true, runId: payload.runId }
    },
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
