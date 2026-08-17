// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry 执行授权测试
//
//   文件:       registryAuthorization.test.ts
//
//   日期:       2026年08月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { AuthContext } from '../security/types.js'
import { ToolRegistry } from './registry.js'
import type { ToolContext, ToolProvider } from './types.js'

const currentAuth: AuthContext = {
  userId: 'user_1',
  subject: 'auth_1',
  email: 'user@example.com',
  displayName: 'User',
  authSessionId: 'session_1',
  authSessionExpiresAt: null,
  csrfToken: 'csrf',
  defaultWorkspaceId: 'workspace_1',
  roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
}

describe('ToolRegistry execution authorization', () => {
  it('refreshes the actor immediately before the handler executes', async () => {
    const handler = vi.fn(async () => result())
    const authorize = vi.fn(async () => currentAuth)
    const registry = new ToolRegistry()
    registry.register(provider(handler))
    registry.setExecutionAuthorizer(authorize)
    const toolContext = context()

    await expect(registry.execute('authorized_example', {}, toolContext)).resolves.toMatchObject({
      resultId: 'result_1',
    })

    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledWith('authorized_example', toolContext)
    expect(toolContext.auth).toBe(currentAuth)
    expect(handler).toHaveBeenCalledOnce()
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(handler.mock.invocationCallOrder[0]!)
  })

  it('does not enter a tool handler after authorization is revoked', async () => {
    const handler = vi.fn(async () => result())
    const registry = new ToolRegistry()
    registry.register(provider(handler))
    registry.setExecutionAuthorizer(async () => {
      throw new Error('authorization_revoked')
    })

    await expect(registry.execute('authorized_example', {}, context())).rejects.toThrow(
      'authorization_revoked',
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects multiple competing execution authorizers', () => {
    const registry = new ToolRegistry()
    registry.setExecutionAuthorizer(async () => currentAuth)

    expect(() => registry.setExecutionAuthorizer(async () => currentAuth)).toThrow(
      '执行授权器已经配置',
    )
  })
})

function provider(handler: ToolProvider['tools'] extends () => infer Tools
  ? Tools extends Array<infer Tool>
    ? Tool extends { handler: infer Handler }
      ? Handler
      : never
    : never
  : never): ToolProvider {
  const definition = {
    name: 'authorized_example',
    label: '授权测试工具',
    description: '验证工具执行授权顺序。',
    prompt: '仅用于测试 ToolRegistry 的授权边界。',
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: { type: 'object', properties: {} },
  }
  return {
    manifest: {
      id: 'authorization-test-provider',
      name: '授权测试 Provider',
      version: '1',
      author: 'test',
      language: 'typescript',
      description: '授权测试 Provider',
      tools: [definition],
    },
    tools: () => [{ ...definition, handler }],
  }
}

function context(): ToolContext {
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    signal: new AbortController().signal,
    state: new Map(),
    resolveValueRef: refId => { throw new Error(`未知 valueRef：${refId}`) },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

function result() {
  return {
    message: '成功',
    payload: {},
    warnings: [],
    resultId: 'result_1',
    source: 'test',
  }
}
