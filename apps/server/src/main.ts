// +-------------------------------------------------------------------------
//
//   地理智能平台 - Node API 与 WebSocket 服务入口
//
//   文件:       main.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 workspaces 子目录启动时，dotenv 需要指向项目根目录的 .env
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
dotenv.config({ path: path.join(projectRoot, '.env') })

import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { metricsResponse, normalizedRouteLabel, observeHttpMetrics } from './observability/metrics.js'
import {
  logger,
  logHttpRequestSummary,
  traceId,
  withLogContext,
} from './observability/logger.js'
import { LocalAgentTracing } from './observability/agentTracing.js'
import { getEnv } from './framework/env.js'
import { artifactRoutes } from './routes/artifacts.js'
import { desktopExportRoutes } from './routes/desktopExports.js'
import { routeErrorResponse } from './routes/errors.js'
import { fileRoutes } from './routes/files.js'
import { layerRoutes } from './routes/layers.js'
import { mapRoutes } from './routes/map.js'
import { meteorologyRoutes } from './routes/meteorology.js'
import { createWsHandler } from './ws/handler.js'
import { requireHttpAuth, securityRoutes } from './security/routes.js'
import {
  authRateLimitMiddleware,
  apiRateLimitMiddleware,
} from './security/httpRateLimit.js'
import { installLifecycleManager } from './lifecycle.js'
import { createAppContainer } from './app/container.js'
import { platformNotFoundHandler } from './app/httpNotFound.js'
import {
  ServiceAdmission,
  serviceAdmissionMiddleware,
  shuttingDownHealth,
} from './app/serviceAdmission.js'

const env = getEnv()
// SDK tracing 使用进程级 provider。这里只安装本地结构化处理器，不注册
// OpenAI exporter，也不记录模型正文或工具输入输出。
const agentTracing = new LocalAgentTracing()
agentTracing.install()
const container = await createAppContainer({ env, projectRoot, agentTracing })
const admission = new ServiceAdmission()

const app = new Hono()
// 匿名分享已永久退役。该边界必须先于全局 CORS 注册，确保预检请求也稳定
// 返回 404，而不是被 CORS 中间件提前处理成伪可用的 204。
const retiredPublicShareRoot = ['/api', 'share'].join('/')
app.all(retiredPublicShareRoot, platformNotFoundHandler)
app.all(`${retiredPublicShareRoot}/*`, platformNotFoundHandler)
const trustedOrigins = new Set([
  ...container.security.auth.trustedOrigins(),
  env.APP_BASE_URL.replace(/\/+$/u, ''),
])
app.use('*', cors({
  origin: origin => origin && trustedOrigins.has(origin.replace(/\/+$/u, '')) ? origin : '',
  credentials: true,
  allowHeaders: ['Content-Type', env.CSRF_HEADER_NAME],
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
}))
app.use('*', async (c, next) => {
  const requestTraceId = traceId()
  c.header('x-geo-agent-platform-trace-id', requestTraceId)
  const started = performance.now()
  await withLogContext({
    traceId: requestTraceId,
    httpMethod: c.req.method,
  }, async () => {
    try {
      await next()
    } finally {
      logHttpRequestSummary({
        traceId: requestTraceId,
        method: c.req.method,
        route: normalizedRouteLabel(c),
        statusCode: c.res.status || 200,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      })
    }
  })
})
app.use('*', observeHttpMetrics)
app.use('*', serviceAdmissionMiddleware(admission))
app.get('/health/live', c => c.json({ status: 'ok', live: true }))
app.get('/health/capabilities', c => c.json(container.capabilities))
app.get('/health', async c => {
  const shutdown = shuttingDownHealth(admission)
  if (shutdown) return c.json(shutdown, 503)
  const health = await container.checkReadiness()
  return c.json(health, health.status === 'ok' ? 200 : 503)
})
app.get('/metrics', async () => {
  return metricsResponse()
})
app.on(['GET', 'POST'], '/api/auth/*', authRateLimitMiddleware, c => container.security.auth.handler(c.req.raw))
app.use('/api/v1/*', apiRateLimitMiddleware(container.security), (c, next) => requireHttpAuth(container.security, c, next))
app.route('/', securityRoutes(container.security))
app.route('/', fileRoutes(container.runtimeRoot, container.fileLifecycle, container.store, container.security, env))
app.route('/', layerRoutes(container.runtimeRoot, container.managedLayers, container.store, container.security, env))
app.route('/', artifactRoutes(container.artifactRepository, container.runtimeRoot, container.security))
app.route('/', desktopExportRoutes({
  artifacts: container.artifactRepository,
  audit: container.auditStore,
  mapStore: container.mapStore,
  security: container.security,
  store: container.store,
}))
app.route('/', mapRoutes({
  mapStore: container.mapStore,
  tileGateway: container.mapTileGateway,
  tiandituBasemapGateway: container.tiandituBasemapGateway,
  security: container.security,
}))
app.route('/', meteorologyRoutes(container.runtimeRoot, container.fileLifecycle, container.store, container.security, env))
app.onError((error, c) => {
  const response = routeErrorResponse(error)
  return c.json({ detail: response.detail }, response.status as never)
})
app.notFound(platformNotFoundHandler)

const server = createServer(getRequestListener(app.fetch))
const wsServer = createWsHandler(server, {
  env,
  store: container.store,
  events: container.events,
  toolRegistry: container.toolRegistry,
  modelRegistry: container.modelRegistry,
  customProviderService: container.customProviderService,
  modelCompletions: container.modelCompletions,
  managedLayers: container.managedLayers,
  runtimeRoot: container.runtimeRoot,
  runtimeFiles: container.runtimeFiles,
  fileLifecycle: container.fileLifecycle,
  defaultRuntimeConfig: container.defaultRuntimeConfig,
  runtime: container.runtime,
  runTasks: container.runTasks,
  startRunService: container.startRunService,
  resultCommitService: container.resultCommitService,
  scheduledTaskService: container.scheduledTaskService,
  automationDefinitionService: container.automationDefinitionService,
  backgroundTasks: container.backgroundTasks,
  usageStats: container.usageStats,
  mapStore: container.mapStore,
  security: container.security,
  admission,
})
installLifecycleManager({
  server,
  wsServer,
  store: container.store,
  db: container.db,
  instanceLock: container.instanceLock,
  onShutdownStart: () => { admission.beginShutdown() },
  beforeDrain: () => container.shutdown(),
})

server.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({
    event: 'lifecycle.api.listening',
    category: 'lifecycle',
    retention: 'operational',
    host: env.API_HOST,
    port: env.API_PORT,
  }, 'API 服务已开始监听。')
  logger.info({
    event: 'tool.providers.loaded',
    category: 'tool',
    retention: 'operational',
    tools: container.toolRegistry.list().length,
    providers: container.toolRegistry.listProviders().length,
  }, '工具 Provider 已加载。')
})
