// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 核心读命令
//
//   文件:       coreCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { AuthContext } from '../security/types.js'
import { buildSkillRegistry, searchSkillRegistry } from '../agent/skillRegistry.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const emptyPayloadSchema = z.object({}).passthrough()
const sessionGetPayloadSchema = z.object({ sessionId: z.string().min(1) }).passthrough()
const fileListPayloadSchema = z.object({ threadId: z.string().min(1) }).strict()
const skillSearchPayloadSchema = z.object({ query: z.string().trim().min(1).max(4000) }).strict()

export function registerCoreCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'session:get-default',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => {
      const auth = requireAuth(context.auth)
      return context.dependencies.store.getOrCreateUserDefaultSession({
        workspaceId: auth.defaultWorkspaceId,
        userId: auth.userId,
      })
    },
  })

  registry.register({
    type: 'session:get',
    payloadSchema: sessionGetPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.store.getSession(payload.sessionId),
  })

  registry.register({
    type: 'tool:list',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.toolRegistry.descriptors(),
  })

  registry.register({
    type: 'provider:list',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.modelRegistry.descriptors(),
  })

  registry.register({
    type: 'runtime-config:get',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (_payload, context) => {
      const auth = requireAuth(context.auth)
      await context.dependencies.security.authorization.enforce(
        auth,
        'admin',
        'admin',
        { workspaceId: auth.defaultWorkspaceId },
      )
      return resolveRuntimeConfig(
        context.dependencies.store.runtimeConfiguration,
        context.dependencies.defaultRuntimeConfig,
      )
    },
  })

  registry.register({
    type: 'skill:list',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (_payload, context) => {
      const config = await resolveRuntimeConfig(
        context.dependencies.store.runtimeConfiguration,
        context.dependencies.defaultRuntimeConfig,
      )
      return buildSkillRegistry(config.sdk.skills, process.cwd(), { strict: false }).snapshot
    },
  })

  registry.register({
    type: 'skill:search',
    payloadSchema: skillSearchPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      const config = await resolveRuntimeConfig(
        context.dependencies.store.runtimeConfiguration,
        context.dependencies.defaultRuntimeConfig,
      )
      const registrySnapshot = buildSkillRegistry(config.sdk.skills, process.cwd(), { strict: false })
      return { query: payload.query, matches: searchSkillRegistry(payload.query, registrySnapshot) }
    },
  })

  registry.register({
    type: 'system:get',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (_payload, context) => {
      const postgisStatus = await context.dependencies.managedLayers.status()
      return {
        catalogBackend: 'typescript',
        postgisEnabled: postgisStatus.available,
        postgisError: postgisStatus.error,
        payloadStoreRoot: context.dependencies.store.getPayloadStoreRoot(),
        providers: context.dependencies.modelRegistry.descriptors(),
        toolProviders: context.dependencies.toolRegistry.providerStatuses(),
      }
    },
  })

  registry.register({
    type: 'file:list',
    payloadSchema: fileListPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      const entries = await context.dependencies.fileLifecycle.list(payload.threadId)
      return { files: entries, total: entries.length }
    },
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
