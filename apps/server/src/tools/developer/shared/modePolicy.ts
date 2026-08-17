import path from 'node:path'

import type { ToolContext } from '../../../framework/types.js'
import { assertDeveloperToolPrincipal } from '../../../security/developerToolAuthorization.js'
import { isInsidePath, parseExplicitAllowedRoots } from './pathPolicy.js'

/** Require caller authorization, the per-run switch, and the deployment allowlist intersection. */
export function assertDeveloperMode(context: ToolContext): string[] {
  // 允许根目录只是部署能力上限，不能替代主体授权。该检查位于每次文件工具
  // handler 的共同入口，已准备或从 checkpoint 恢复的调用也必须重新通过。
  assertDeveloperToolPrincipal(context.auth)
  const config = context.runtimeConfig?.developer
  if (!config?.enabled) throw new Error('当前运行未显式启用开发者模式。')
  if (!config.allowedRoots.length) throw new Error('开发者模式没有配置允许根目录。')
  const deploymentRoots = parseExplicitAllowedRoots()
  if (!deploymentRoots.length) throw new Error('部署未配置 DEVELOPER_TOOL_ALLOWED_ROOTS。')
  const roots = config.allowedRoots.map(root => path.resolve(root))
  for (const root of roots) {
    if (!deploymentRoots.some(deploymentRoot => isInsidePath(root, deploymentRoot))) {
      throw new Error(`运行时开发根目录不在部署允许范围内：${root}`)
    }
  }
  return [...new Set(roots)]
}
