// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发工具主体授权
//
//   文件:       developerToolAuthorization.ts
//
//   日期:       2026年08月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { AuthorizationError } from './authorizationService.js'
import type { AuthContext } from './types.js'

export function isDeveloperToolPrincipal(auth: AuthContext | null | undefined): auth is AuthContext {
  return Boolean(auth?.roles.some(binding => binding.role === 'platform_admin'))
}

/**
 * 部署根目录只定义能力上限，不构成用户授权。开发文件工具默认只允许
 * platform_admin，并在工具真正执行前再次检查，防止提示词或旧运行快照绕过。
 */
export function assertDeveloperToolPrincipal(
  auth: AuthContext | null | undefined,
): asserts auth is AuthContext {
  if (!isDeveloperToolPrincipal(auth)) {
    throw new AuthorizationError('开发文件工具仅允许平台管理员执行。')
  }
}
