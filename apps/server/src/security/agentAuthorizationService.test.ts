// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 持续授权测试
//
//   文件:       agentAuthorizationService.test.ts
//
//   日期:       2026年08月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { AnalysisRun } from '../schemas/types.js'
import type { AuthContext, AuthRoleBinding } from './types.js'
import {
  AgentAuthorizationRevokedError,
  AgentAuthorizationService,
} from './agentAuthorizationService.js'

const run = {
  id: 'run_1',
  workspaceId: 'workspace_1',
  createdByUserId: 'user_1',
  visibility: 'private',
} as AnalysisRun

const analystRole: AuthRoleBinding = {
  workspaceId: 'workspace_1',
  role: 'analyst',
}

const auth: AuthContext = {
  userId: 'user_1',
  subject: 'auth_user_1',
  email: 'user@example.com',
  displayName: 'User',
  authSessionId: 'session_1',
  authSessionExpiresAt: null,
  csrfToken: 'csrf',
  defaultWorkspaceId: 'workspace_1',
  roles: [analystRole],
}

describe('AgentAuthorizationService', () => {
  it('stops a background run after its login session is revoked', async () => {
    const service = createService({ active: false, roles: [analystRole] })

    await expect(service.authorizeModel(auth, run)).rejects.toMatchObject({
      name: 'AgentAuthorizationRevokedError',
      code: 'authorization_revoked',
    })
  })

  it('stops a run when the actor loses workspace membership', async () => {
    const service = createService({
      active: true,
      roles: [{ workspaceId: 'workspace_other', role: 'analyst' }],
    })

    await expect(service.authorizeRun(auth, run)).rejects.toBeInstanceOf(
      AgentAuthorizationRevokedError,
    )
  })

  it('refreshes roles and checks run plus tool authorization at the execution boundary', async () => {
    const assertResourceWorkspace = vi.fn(async () => {})
    const enforce = vi.fn(async () => {})
    const service = createService({
      active: true,
      roles: [analystRole],
      assertResourceWorkspace,
      enforce,
    })

    const current = await service.authorizeTool(auth, run, 'query_layer')

    expect(current.roles).toEqual([analystRole])
    expect(assertResourceWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', roles: [analystRole] }),
      'run',
      'execute',
      expect.objectContaining({ resourceId: 'run_1', workspaceId: 'workspace_1' }),
    )
    expect(enforce).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      'tool',
      'execute',
      { workspaceId: 'workspace_1', resourceId: 'query_layer' },
    )
  })

  it('rebuilds Automation service authorization instead of trusting queued roles', async () => {
    const buildServiceAuthContext = vi.fn(async () => ({
      ...auth,
      authSessionId: 'automation:user_1',
      roles: [analystRole],
    }))
    const service = createService({
      active: false,
      roles: [],
      buildServiceAuthContext,
    })

    await expect(service.authorizeRun({
      ...auth,
      authSessionId: 'automation:user_1',
    }, run)).resolves.toMatchObject({ roles: [analystRole] })
    expect(buildServiceAuthContext).toHaveBeenCalledWith('user_1', 'workspace_1')
  })

  it('rejects unowned legacy runs instead of guessing an authorization scope', async () => {
    const service = createService({ active: true, roles: [analystRole] })

    await expect(service.authorizeRun(auth, {
      ...run,
      workspaceId: null,
    })).rejects.toThrow('缺少可验证的工作区或创建者归属')
  })
})

function createService(options: {
  active: boolean
  roles: AuthRoleBinding[]
  assertResourceWorkspace?: ReturnType<typeof vi.fn>
  enforce?: ReturnType<typeof vi.fn>
  buildServiceAuthContext?: ReturnType<typeof vi.fn>
}): AgentAuthorizationService {
  return new AgentAuthorizationService({
    auth: {
      isAuthContextActive: async () => options.active,
      listUserRoles: async () => options.roles,
      buildServiceAuthContext: options.buildServiceAuthContext
        ?? vi.fn(async () => ({ ...auth, roles: options.roles })),
    },
    authorization: {
      assertResourceWorkspace: options.assertResourceWorkspace ?? vi.fn(async () => {}),
      enforce: options.enforce ?? vi.fn(async () => {}),
    },
  })
}
