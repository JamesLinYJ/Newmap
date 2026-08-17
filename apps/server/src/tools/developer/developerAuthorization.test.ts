// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发工具主体授权测试
//
//   文件:       developerAuthorization.test.ts
//
//   日期:       2026年08月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from '../../agent/defaultRuntimeConfig.js'
import type { ToolContext } from '../../framework/types.js'
import type { AuthContext } from '../../security/types.js'
import { assertDeveloperMode } from './shared/modePolicy.js'

const previousRoots = process.env.DEVELOPER_TOOL_ALLOWED_ROOTS

afterEach(() => {
  if (previousRoots === undefined) delete process.env.DEVELOPER_TOOL_ALLOWED_ROOTS
  else process.env.DEVELOPER_TOOL_ALLOWED_ROOTS = previousRoots
})

describe('developer tool authorization', () => {
  it('does not grant an ordinary analyst the globally enabled file capability', () => {
    const root = path.resolve('developer-test-root')
    process.env.DEVELOPER_TOOL_ALLOWED_ROOTS = root

    expect(() => assertDeveloperMode(context(root, 'analyst'))).toThrow(
      '仅允许平台管理员',
    )
  })

  it('allows a platform administrator only inside the deployment root intersection', () => {
    const deploymentRoot = path.resolve('developer-test-root')
    process.env.DEVELOPER_TOOL_ALLOWED_ROOTS = deploymentRoot
    const child = path.join(deploymentRoot, 'workspace')

    expect(assertDeveloperMode(context(child, 'platform_admin'))).toEqual([child])
    expect(() => assertDeveloperMode(
      context(path.resolve('different-root'), 'platform_admin'),
    )).toThrow('不在部署允许范围内')
  })
})

function context(root: string, role: 'analyst' | 'platform_admin'): ToolContext {
  const auth: AuthContext = {
    userId: 'user_1',
    subject: 'auth_1',
    email: 'user@example.com',
    displayName: 'User',
    authSessionId: 'session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role }],
  }
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    signal: new AbortController().signal,
    runtimeConfig: {
      ...defaultRuntimeConfig(),
      developer: { enabled: true, allowedRoots: [root] },
    },
    auth,
    state: new Map(),
    resolveValueRef: refId => { throw new Error(`未知 valueRef：${refId}`) },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}
