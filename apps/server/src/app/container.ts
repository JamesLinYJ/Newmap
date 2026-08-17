// +-------------------------------------------------------------------------
//
//   地理智能平台 - 应用依赖装配容器
//
//   文件:       container.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import path from 'node:path'
import { sql } from 'drizzle-orm'

import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { OpenAIAgentsRuntime, type OpenAIAgentsRuntimeOptions } from '../agent/runtime.js'
import { RunTaskManager } from '../agent/runTaskManager.js'
import { createDb, type Database } from '../db/connection.js'
import { verifyDatabaseSchemaCompatibility } from '../db/schemaCompatibility.js'
import { ApplicationInstanceLock } from '../db/applicationInstanceLock.js'
import type { Env } from '../framework/env.js'
import { discoverAndLoad } from '../framework/loader.js'
import { ToolRegistry } from '../framework/registry.js'
import { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import { LocalRasterTileRenderer } from '../map/localRasterTileRenderer.js'
import { MapTileGateway } from '../map/mapTileGateway.js'
import { TiandituBasemapGateway } from '../map/tiandituBasemapGateway.js'
import { PostgisVectorTileSource } from '../map/postgisVectorTileSource.js'
import { seedLayersFromDirectory } from '../gis/seedLayers.js'
import { ModelAdapterRegistry } from '../model/registry.js'
import { ModelCompletionService, ModelResultCacheStore } from '../model/modelResultCache.js'
import {
  ProviderCredentialCipher,
  ProviderCredentialStagingService,
} from '../model/customProviderCredentials.js'
import { CustomProviderService } from '../model/customProviderService.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import type { LocalAgentTracing } from '../observability/agentTracing.js'
import { ensureMeteorologicalTables } from '../routes/meteorology.js'
import { ensureSecurityTables } from '../security/database.js'
import { BetterAuthService } from '../security/authService.js'
import { SecurityAdminService } from '../security/adminService.js'
import { AuthorizationError, AuthorizationService } from '../security/authorizationService.js'
import { PlatformIdentityService } from '../security/platformIdentityService.js'
import type { SecurityServices } from '../security/routes.js'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import {
  PostgresRuntimeIntegrityCatalog,
  RuntimeIntegrityChecker,
} from '../store/runtimeIntegrityChecker.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { FileLifecycleService } from '../store/fileLifecycleService.js'
import { ArtifactPublicationRepository } from '../store/postgres/artifactPublicationRepository.js'
import { AuthSessionRepository } from '../store/postgres/authSessionRepository.js'
import { MembershipRepository } from '../store/postgres/membershipRepository.js'
import { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import { MapStore } from '../store/postgres/mapStore.js'
import { AuditStore } from '../store/postgres/auditStore.js'
import { RbacPolicyReader } from '../store/postgres/rbacPolicyReader.js'
import { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'
import { FileObjectRepository } from '../store/postgres/fileObjectRepository.js'
import { validateToolContracts } from '../tools/contractValidator.js'
import { createAutomationExecutionProvider } from '../tools/automationExecution/index.js'
import { UsageStatsService } from '../usage/usageStatsService.js'
import { BackgroundTaskRegistry } from '../automations/backgroundTaskRegistry.js'
import { JobQueueService } from '../automations/jobQueueService.js'
import { ScheduledTaskService } from '../automations/scheduledTaskService.js'
import { AutomationRunner } from '../automations/automationRunner.js'
import { createAutomationRegistryFromDirectory, type AutomationRegistry } from '../automations/automationRegistry.js'
import { AutomationCompiler } from '../automations/automationCompiler.js'
import { AutomationDefinitionService } from '../automations/automationDefinitionService.js'
import { AutomationInvocationService } from '../automations/automationInvocationService.js'
import { PlatformEventHub } from '../store/platformEventHub.js'
import { ObjectPublicationCoordinator } from '../store/objectPublicationCoordinator.js'
import { StartRunService } from '../conversation/startRunService.js'
import { buildRuntimeCapabilities } from '../runtime/releaseCapabilities.js'
import type { RuntimeCapabilities } from '@geo-agent-platform/shared-types/release'
import { ToolResultCommitService } from '../tools/resultPersistence.js'

export interface AppContainer {
  env: Env
  db: Database
  instanceLock: ApplicationInstanceLock
  runtimeRoot: string
  runtimeFiles: RuntimeFileStore
  fileLifecycle: FileLifecycleService
  store: PlatformPersistenceFacade
  events: PlatformEventHub
  managedLayers: ManagedLayerService
  artifactRepository: ArtifactPublicationRepository
  mapStore: MapStore
  mapTileGateway: MapTileGateway
  tiandituBasemapGateway: TiandituBasemapGateway
  auditStore: AuditStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  customProviderService: CustomProviderService
  modelCompletions: ModelCompletionService
  runtime: OpenAIAgentsRuntime
  runTasks: RunTaskManager
  startRunService: StartRunService
  resultCommitService: ToolResultCommitService
  automationRegistry: AutomationRegistry
  automationDefinitionService: AutomationDefinitionService
  automationInvocationService: AutomationInvocationService
  scheduledTaskService: ScheduledTaskService
  backgroundTasks: BackgroundTaskRegistry
  usageStats: UsageStatsService
  jobQueue: JobQueueService
  security: SecurityServices
  defaultRuntimeConfig: ReturnType<typeof defaultRuntimeConfig>
  capabilities: RuntimeCapabilities
  shutdown(): Promise<void>
  checkReadiness(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }>
}

export async function createAppContainer(input: {
  env: Env
  projectRoot: string
  agentTracing?: LocalAgentTracing
}): Promise<AppContainer> {
  const { env, projectRoot, agentTracing } = input
  const db = createDb(env.DATABASE_URL)
  const instanceLock = new ApplicationInstanceLock(db)
  const runtimeRoot = path.resolve(env.RUNTIME_ROOT)
  const events = new PlatformEventHub()
  const objectPublication = new ObjectPublicationCoordinator()
  const runtimeFiles = new RuntimeFileStore(runtimeRoot)
  const fileLifecycle = new FileLifecycleService(
    new FileObjectRepository(db),
    runtimeFiles,
    objectPublication,
  )
  const store = new PlatformPersistenceFacade(db, path.join(runtimeRoot, 'conversations'), {
    events,
    runtimeFiles,
    fileLifecycle,
    objectPublication,
  })
  const resultCommitService = new ToolResultCommitService(store)
  const managedLayers = new ManagedLayerService(db)
  const artifactRepository = new ArtifactPublicationRepository(db)
  const mapStore = new MapStore(db, events.mapScenes)
  const mapTileGateway = new MapTileGateway(
    new PostgisVectorTileSource(db.pool, env.MAP_TILE_TIMEOUT_MS),
    new LocalRasterTileRenderer({
      runtimeRoot,
      timeoutMs: env.MAP_TILE_TIMEOUT_MS,
    }),
  )
  const tiandituBasemapGateway = new TiandituBasemapGateway(env.TIANDITU_API_KEY)
  const auditStore = new AuditStore(db)
  const userRepository = new PlatformUserRepository(db)
  const workspaceRepository = new WorkspaceRepository(db)
  const membershipRepository = new MembershipRepository(db)
  const identityService = new PlatformIdentityService({
    db,
    users: userRepository,
    workspaces: workspaceRepository,
    memberships: membershipRepository,
    authSessions: new AuthSessionRepository(db),
  })
  const adminService = new SecurityAdminService({
    db,
    users: userRepository,
    workspaces: workspaceRepository,
    memberships: membershipRepository,
    policies: new RbacPolicyReader(db),
    audit: auditStore,
  })
  const toolRegistry = new ToolRegistry()
  const modelRegistry = new ModelAdapterRegistry(env)
  const customProviderService = new CustomProviderService(
    store.customProviders,
    modelRegistry,
    new ProviderCredentialCipher(env.BETTER_AUTH_SECRET),
    new ProviderCredentialStagingService(),
  )
  const security: SecurityServices = {
    auth: new BetterAuthService({ db, env, identity: identityService }),
    authorization: new AuthorizationService(db, auditStore),
    admin: adminService,
  }
  const runtimeConfigDefaults = defaultRuntimeConfig({
    sandbox: {
      backend: env.SANDBOX_BACKEND,
    },
  })
  let startedJobQueue: JobQueueService | null = null

  try {
    await instanceLock.acquire()
    // DeepSeek 的 OpenAI-compatible transport 在构造时启动 DNS 预热；
    // 监听端口前等待它完成，确保 supervisor 报告 healthy 后首个问题
    // 不再承担冷解析延迟。
    await modelRegistry.warmup()
    await verifyDatabaseSchemaCompatibility(db)
    await ensureMeteorologicalTables(db)
    await ensureSecurityTables(db)
    await store.initialize()
    await customProviderService.loadPersistedProviders()
    await new RuntimeIntegrityChecker(
      new PostgresRuntimeIntegrityCatalog(db),
      runtimeFiles,
      runtimeRoot,
    ).verify()

  if (env.SEED_LAYERS_DIR) {
    const seedDirectory = path.resolve(projectRoot, env.SEED_LAYERS_DIR)
    const seededLayers = await seedLayersFromDirectory(managedLayers, seedDirectory)
    logger.info({ count: seededLayers.length, seedLayersConfigured: true }, 'seeded layers')
  }

  const modelCompletions = new ModelCompletionService(modelRegistry, new ModelResultCacheStore(db), {
    enabled: env.DEEPSEEK_RESULT_CACHE_ENABLED,
    ttlSeconds: env.DEEPSEEK_RESULT_CACHE_TTL_SECONDS,
    maxBytes: env.DEEPSEEK_RESULT_CACHE_MAX_BYTES,
  })
  const runtime = new OpenAIAgentsRuntime(
    store,
    toolRegistry,
    modelRegistry,
    {
      ...(agentTracing ? { agentTracing } : {}),
      authorizationLease: async (auth, run) => {
        if (!run.workspaceId) {
          throw new AuthorizationError(`运行 '${run.id}' 缺少 workspaceId，无法刷新执行授权。`)
        }
        const refreshed = auth.authSessionId.startsWith('automation:')
          ? await security.auth.buildServiceAuthContext(auth.userId, run.workspaceId)
          : await refreshInteractiveAuthContext(security, auth)
        await security.authorization.assertResourceWorkspace(refreshed, 'run', 'execute', {
          workspaceId: run.workspaceId,
          createdByUserId: run.createdByUserId,
          visibility: run.visibility,
          resourceId: run.id,
        })
        return refreshed
      },
    },
    modelCompletions,
  )
  const usageStats = new UsageStatsService(store, env)
  const backgroundTasks = new BackgroundTaskRegistry()
  const runTasks = new RunTaskManager(runtime, store, backgroundTasks)
  const startRunService = new StartRunService({
    store,
    usageStats,
    modelRegistry,
    runTasks,
    fileLifecycle,
    defaultRuntimeConfig: runtimeConfigDefaults,
  })
  const automationRegistry = await createAutomationRegistryFromDirectory(path.join(projectRoot, 'apps', 'server', 'config', 'automations'))
  const automationCompiler = new AutomationCompiler(toolRegistry)
  const automationDefinitionService = new AutomationDefinitionService({
    automations: store.automations,
    registry: automationRegistry,
    compiler: automationCompiler,
    security,
  })
  const jobQueue = new JobQueueService(env)
  const scheduledTaskService = new ScheduledTaskService({
    automations: store.automations,
    conversations: store,
    definitions: automationDefinitionService,
    compiler: automationCompiler,
    jobQueue,
    backgroundTasks,
    runTasks,
    usageStats,
    security,
  })
  const automationRunner = new AutomationRunner({
    automations: store.automations,
    conversations: store,
    toolExecutionStore: store,
    resultCommitService,
    runtimeConfiguration: store.runtimeConfiguration,
    definitions: automationDefinitionService,
    compiler: automationCompiler,
    toolRegistry,
    runTasks,
    modelRegistry,
    modelCompletions,
    security,
    usageStats,
    backgroundTasks,
    defaultRuntimeConfig: runtimeConfigDefaults,
    unscheduleTask: async taskId => {
      const task = await store.automations.getScheduledTask(taskId)
      await jobQueue.unscheduleTask(taskId, task?.queueJobId)
    },
  })
  const automationInvocationService = new AutomationInvocationService({
    store: {
      getRun: runId => store.getRun(runId),
      createAutomationRunRecord: input => store.automations.createAutomationRunRecord(input),
      getAutomationRunRecord: automationRunId => store.automations.getAutomationRunRecord(automationRunId),
      listAutomationRuns: workspaceId => store.automations.listAutomationRuns(workspaceId),
      countMeteorologicalDatasets: input => store.meteorology.countMeteorologicalDatasets(input),
    },
    definitions: automationDefinitionService,
    compiler: automationCompiler,
    runner: automationRunner,
  })
  await discoverAndLoad(managedLayers, { env, registry: toolRegistry, scheduledTaskService })
  toolRegistry.register(createAutomationExecutionProvider(automationInvocationService))
  const workerContractDigest = await validateWorkerContracts(env, toolRegistry)
  const capabilities = buildRuntimeCapabilities({
    workerContractDigest,
    environment: {
      GEO_AGENT_PLATFORM_RELEASE_ID: env.GEO_AGENT_PLATFORM_RELEASE_ID,
      GEO_AGENT_PLATFORM_ROOT: process.env.GEO_AGENT_PLATFORM_ROOT,
    },
  })
  await automationDefinitionService.initialize()
  await jobQueue.start((payload, queueJobId) => automationRunner.executeQueuedJob(payload, queueJobId))
  startedJobQueue = jobQueue
  await scheduledTaskService.reconcileQueuedAutomationRuns()
  await scheduledTaskService.reconcileSchedules()

  return {
    env,
    db,
    instanceLock,
    runtimeRoot,
    runtimeFiles,
    fileLifecycle,
    store,
    events,
    managedLayers,
    artifactRepository,
    mapStore,
    mapTileGateway,
    tiandituBasemapGateway,
    auditStore,
    toolRegistry,
    modelRegistry,
    customProviderService,
    modelCompletions,
    runtime,
    runTasks,
    startRunService,
    resultCommitService,
    automationRegistry,
    automationDefinitionService,
    automationInvocationService,
    scheduledTaskService,
    backgroundTasks,
    usageStats,
    jobQueue,
    security,
    defaultRuntimeConfig: runtimeConfigDefaults,
    capabilities,
    shutdown: async () => {
      await jobQueue.stop()
      await Promise.all([runTasks.drain(), backgroundTasks.drain(), mapTileGateway.close()])
      await Promise.all([modelRegistry.close(), agentTracing?.shutdown()])
    },
    checkReadiness: () => checkReadiness({ db, managedLayers, instanceLock, env }),
  }
  } catch (error) {
    logger.error({ error: errorLogPayload(error) }, 'application container initialization failed')
    if (startedJobQueue) {
      await startedJobQueue.stop().catch(cleanupError => {
        logger.error({ error: errorLogPayload(cleanupError) }, 'job queue cleanup after startup failure failed')
      })
    }
    await modelRegistry.close().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'model transport cleanup after startup failure failed')
    })
    await mapTileGateway.close().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'map tile renderer cleanup after startup failure failed')
    })
    await store.closeConversationStore().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'payload store cleanup after startup failure failed')
    })
    await instanceLock.release().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'instance lock cleanup after startup failure failed')
    })
    await db.close().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'database cleanup after startup failure failed')
    })
    throw error
  }
}

async function refreshInteractiveAuthContext(
  security: SecurityServices,
  auth: Parameters<NonNullable<OpenAIAgentsRuntimeOptions['authorizationLease']>>[0],
) {
  if (!(await security.auth.isAuthContextActive(auth))) {
    throw new AuthorizationError('登录会话已失效，运行授权已撤销。')
  }
  const roles = await security.auth.listUserRoles(auth.userId)
  if (!roles.length) throw new AuthorizationError('用户已失去平台角色，运行授权已撤销。')
  return { ...auth, roles }
}

async function validateWorkerContracts(env: Env, toolRegistry: ToolRegistry): Promise<string | null> {
  if (!env.WORKER_URL) return null
  if (!env.WORKER_SHARED_SECRET) {
    throw new Error('WORKER_URL 已配置但 WORKER_SHARED_SECRET 未配置。')
  }
  const contractReport = await validateToolContracts(toolRegistry, env.WORKER_URL, env.WORKER_SHARED_SECRET)
  if (!contractReport.passed) {
    const reasons = [
      ...contractReport.errors,
      ...contractReport.missingInRegistry.map(name => `Node 工具目录缺少 ${name}`),
      ...contractReport.missingInWorker.map(name => `Worker 工具目录缺少 ${name}`),
    ]
    throw new Error(`工具契约校验失败：${reasons.join('；')}`)
  }
  return contractReport.workerContractDigest
}

async function checkReadiness(input: {
  db: Database
  managedLayers: ManagedLayerService
  instanceLock: ApplicationInstanceLock
  env: Env
}): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}
  checks.instanceLock = input.instanceLock.isHeld()
    ? { ok: true }
    : { ok: false, detail: 'PostgreSQL 平台单写实例锁未持有' }
  try {
    // Health check 是明确允许的 raw SQL：只验证数据库连接可用性，不读写业务表。
    await input.db.execute(sql`SELECT 1`)
    checks.database = { ok: true }
  } catch (error) {
    logger.error({ error: errorLogPayload(error) }, 'database health check failed')
    checks.database = { ok: false, detail: '数据库不可用' }
  }

  const postgisStatus = await input.managedLayers.status()
  if (postgisStatus.available) {
    checks.postgis = { ok: true }
  } else {
    checks.postgis = { ok: false, detail: 'PostGIS 不可用' }
  }

  if (input.env.WORKER_URL) {
    try {
      const response = await fetch(new URL('/health', input.env.WORKER_URL).toString(), { signal: AbortSignal.timeout(2_000) })
      checks.worker = response.ok ? { ok: true } : { ok: false, detail: `Worker HTTP ${response.status}` }
    } catch (error) {
      logger.error({ error: errorLogPayload(error) }, 'worker health check failed')
      checks.worker = { ok: false, detail: 'Worker 不可用' }
    }
  }

  return {
    status: Object.values(checks).every(check => check.ok) ? 'ok' : 'degraded',
    checks,
  }
}
