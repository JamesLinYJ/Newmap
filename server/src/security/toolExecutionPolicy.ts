// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行安全策略
//
//   文件:       toolExecutionPolicy.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../framework/registry.js'
import type { AuthContext } from './types.js'
import { AuthorizationService } from './authorizationService.js'

// 裸 tool:run 是调试控制面，不是普通产品执行路径。
// 破坏性工具必须通过 Agent SDK approval 恢复，不能在后台绕开审批状态机。
export async function assertDirectToolRunAllowed(
  auth: AuthContext,
  authorization: AuthorizationService,
  registry: ToolRegistry,
  toolName: string,
): Promise<void> {
  await authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId, resourceId: toolName })
  const tool = registry.get(toolName)
  if (!tool) throw new Error(`工具 "${toolName}" 未注册`)
  if (tool.isDestructive || tool.requiresApproval === true) {
    throw new Error(`工具 "${toolName}" 是破坏性或审批敏感工具，必须通过 Agent 审批流程执行。`)
  }
}
