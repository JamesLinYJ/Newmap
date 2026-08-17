// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 持续授权服务
//
//   文件:       agentAuthorizationService.ts
//
//   日期:       2026年08月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import type { AnalysisRun } from '../schemas/types.js'
import type { AuthContext, AuthRoleBinding } from './types.js'
import { AuthorizationError } from './authorizationService.js'

interface AgentAuthReader {
  isAuthContextActive(auth: AuthContext): Promise<boolean>
  listUserRoles(userId: string): Promise<AuthRoleBinding[]>
  buildServiceAuthContext(platformUserId: string, workspaceId: string): Promise<AuthContext>
}

interface AgentAuthorizationReader {
  assertResourceWorkspace(
    auth: AuthContext,
    object: 'run',
    action: 'execute',
    resource: {
      workspaceId?: string | null
      createdByUserId?: string | null
      visibility?: string | null
      resourceId?: string | null
    },
  ): Promise<void>
  enforce(
    auth: AuthContext,
    object: 'tool',
    action: 'execute',
    scope: { workspaceId: string; resourceId: string },
  ): Promise<void>
}

export interface AgentAuthorizationPort {
  authorizeModel(auth: AuthContext | null, run: AnalysisRun): Promise<AuthContext>
  authorizeRun(auth: AuthContext | null, run: AnalysisRun): Promise<AuthContext>
  authorizeTool(auth: AuthContext | null, run: AnalysisRun, toolName: string): Promise<AuthContext>
}

export class AgentAuthorizationRevokedError extends AuthorizationError {
  readonly code = 'authorization_revoked'
  readonly failureSource = 'platform'
  override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'AgentAuthorizationRevokedError'
    this.cause = cause
  }
}

/**
 * 异步 Agent 持有的是身份线索，不是永久权限快照。每次模型请求和工具调用
 * 都通过本服务重新确认会话、用户、工作区成员关系和当前 RBAC 权限。
 */
export class AgentAuthorizationService implements AgentAuthorizationPort {
  constructor(private readonly dependencies: {
    auth: AgentAuthReader
    authorization: AgentAuthorizationReader
  }) {}

  authorizeModel(auth: AuthContext | null, run: AnalysisRun): Promise<AuthContext> {
    return this.authorizeRun(auth, run)
  }

  async authorizeRun(auth: AuthContext | null, run: AnalysisRun): Promise<AuthContext> {
    const workspaceId = requireOwnedRun(run)
    const actor = requireActor(auth, run)
    const current = await this.refreshActor(actor, workspaceId)
    try {
      await this.dependencies.authorization.assertResourceWorkspace(current, 'run', 'execute', {
        workspaceId: run.workspaceId,
        createdByUserId: run.createdByUserId,
        visibility: run.visibility,
        resourceId: run.id,
      })
    } catch (error) {
      throw authorizationRevoked(`运行 '${run.id}' 的当前执行权限已被撤销。`, error)
    }
    return current
  }

  async authorizeTool(
    auth: AuthContext | null,
    run: AnalysisRun,
    toolName: string,
  ): Promise<AuthContext> {
    const workspaceId = requireOwnedRun(run)
    const current = await this.authorizeRun(auth, run)
    try {
      await this.dependencies.authorization.enforce(current, 'tool', 'execute', {
        workspaceId,
        resourceId: toolName,
      })
    } catch (error) {
      throw authorizationRevoked(`工具 '${toolName}' 的当前执行权限已被撤销。`, error)
    }
    return current
  }

  private async refreshActor(auth: AuthContext, workspaceId: string): Promise<AuthContext> {
    if (auth.authSessionId.startsWith('automation:')) {
      try {
        return await this.dependencies.auth.buildServiceAuthContext(auth.userId, workspaceId)
      } catch (error) {
        throw authorizationRevoked('Automation 创建者已失效或已离开当前工作区。', error)
      }
    }

    if (!(await this.dependencies.auth.isAuthContextActive(auth))) {
      throw authorizationRevoked('登录会话已失效，后台运行已停止。')
    }
    const roles = await this.dependencies.auth.listUserRoles(auth.userId)
    const stillMember = roles.some(role => (
      role.role === 'platform_admin' || role.workspaceId === workspaceId
    ))
    if (!stillMember) {
      throw authorizationRevoked('用户已失去当前工作区成员关系，后台运行已停止。')
    }
    return {
      ...auth,
      defaultWorkspaceId: workspaceId,
      roles,
    }
  }
}

export function isAgentAuthorizationRevokedError(
  error: unknown,
): error is AgentAuthorizationRevokedError {
  return error instanceof AgentAuthorizationRevokedError
    || (error instanceof Error && error.name === 'AgentAuthorizationRevokedError')
}

function requireOwnedRun(run: AnalysisRun): string {
  if (!run.workspaceId || !run.createdByUserId) {
    throw authorizationRevoked(
      `运行 '${run.id}' 缺少可验证的工作区或创建者归属，不能继续执行。`,
    )
  }
  return run.workspaceId
}

function requireActor(auth: AuthContext | null, run: AnalysisRun): AuthContext {
  if (!auth) throw authorizationRevoked(`运行 '${run.id}' 缺少执行主体。`)
  if (auth.userId !== run.createdByUserId) {
    throw authorizationRevoked(`运行 '${run.id}' 的执行主体与创建者不一致。`)
  }
  return auth
}

function authorizationRevoked(message: string, cause?: unknown): AgentAuthorizationRevokedError {
  return cause instanceof AgentAuthorizationRevokedError
    ? cause
    : new AgentAuthorizationRevokedError(message, cause)
}
