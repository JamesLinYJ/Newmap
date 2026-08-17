// +-------------------------------------------------------------------------
//
//   地理智能平台 - StartRun 应用服务
//
//   线程/运行创建、provider 校验和后台任务启动属于一个应用用例。
//   WS 只负责授权、DTO 映射和订阅投影。
// --------------------------------------------------------------------------

import {
  runAttachmentsSchema,
  type AgentRunProfile,
  type AgentRuntimeConfig,
  type AnalysisRun,
  type RunAttachmentInput,
  type RunGoalInput,
} from '../schemas/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { AuthContext } from '../security/types.js'
import { scopeRuntimeConfigToPrincipal } from '../security/runtimePrincipalScope.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { RunTaskCompletionTarget, RunTaskManager } from '../agent/runTaskManager.js'
import type { RunOptions } from '../agent/runtime.js'
import { resolveRuntimeConfig } from '../runtime/runtimeConfig.js'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'
import { authorizeRunAttachments } from './runAttachmentAuthorization.js'

export interface StartRunInput {
  auth: AuthContext
  query: string
  sessionId?: string | null
  threadId?: string | null
  provider?: string | null
  modelProvider?: string | null
  modelName?: string | null
  executionMode?: 'auto' | 'plan'
  runProfile?: AgentRunProfile
  goal?: RunGoalInput | null
  reasoning?: boolean
  attachments?: RunAttachmentInput[]
  completion?: RunTaskCompletionTarget
  /**
   * 在后台任务真正启动前建立调用方所需的观察关系。
   *
   * 该回调是启动顺序的一部分而不是完成通知：运行已经持久化，但此时尚未
   * 产生任何实时事件。调用方必须同步完成订阅，避免快速运行的首批事件丢失。
   */
  beforeLaunch: (run: AnalysisRun) => void
}

type StartRunStore = Pick<PlatformPersistenceFacade, 'createThread' | 'getThread' | 'createRun' | 'runtimeRoot'>
  & Pick<PlatformPersistenceFacade, 'runtimeConfiguration'>

export class StartRunService {
  constructor(private readonly dependencies: {
    store: StartRunStore
    usageStats: Pick<UsageStatsService, 'assertWorkspaceCanStartModelRun'>
    modelRegistry: Pick<ModelAdapterRegistry, 'defaultProvider'>
    runTasks: Pick<RunTaskManager, 'startDetached'>
    fileLifecycle: Pick<FileLifecyclePort, 'list'>
    defaultRuntimeConfig?: AgentRuntimeConfig
  }) {}

  async start(input: StartRunInput): Promise<AnalysisRun> {
    const sessionId = input.sessionId
      ?? (input.threadId ? this.dependencies.store.getThread(input.threadId).sessionId : null)
    if (!sessionId) throw new Error('sessionId 不能为空')
    if (input.goal?.deadlineAt && Date.parse(input.goal.deadlineAt) <= Date.now()) {
      throw new Error('Goal 截止时间必须晚于当前时间。')
    }

    this.dependencies.usageStats.assertWorkspaceCanStartModelRun(input.auth)
    const resolvedRuntimeConfig = await resolveRuntimeConfig(
      this.dependencies.store.runtimeConfiguration,
      this.dependencies.defaultRuntimeConfig,
    )
    const runtimeConfig = scopeRuntimeConfigToPrincipal(
      this.dependencies.store.runtimeRoot,
      resolvedRuntimeConfig,
      input.auth,
    )
    const selectedProvider = input.provider
      ?? input.modelProvider
      ?? this.dependencies.modelRegistry.defaultProvider
    if (!selectedProvider) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')

    const threadId = input.threadId
      ?? (await this.dependencies.store.createThread(sessionId, input.query.slice(0, 32))).id
    const attachments = runAttachmentsSchema.parse(input.attachments ?? [])
    const contextReferences = await authorizeRunAttachments(
      this.dependencies.fileLifecycle,
      threadId,
      attachments,
    )
    const run = await this.dependencies.store.createRun(sessionId, input.query, {
      threadId,
      modelProvider: selectedProvider,
      modelName: input.modelName ?? null,
      runProfile: input.runProfile ?? 'standard',
      goal: input.goal ?? null,
      runtimeConfigSnapshot: runtimeConfig,
      contextReferences,
    })

    const options: RunOptions = {
      runId: run.id,
      threadId,
      sessionId,
      query: input.query,
      provider: selectedProvider,
      modelName: run.modelName,
      runtimeConfig,
      executionMode: input.executionMode === 'plan' ? 'plan' : 'auto',
      runProfile: input.runProfile ?? 'standard',
      reasoning: input.reasoning !== false,
      auth: input.auth,
    }
    input.beforeLaunch(run)
    this.dependencies.runTasks.startDetached(options, input.completion)
    return run
  }
}
