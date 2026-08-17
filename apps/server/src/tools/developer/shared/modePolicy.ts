import path from 'node:path'

import type { ToolContext } from '../../../framework/types.js'
import { isInsidePath, parseExplicitAllowedRoots } from './pathPolicy.js'

/** Require an explicit platform-admin principal plus both runtime and deployment root grants. */
export function assertDeveloperMode(context: ToolContext): string[] {
  const auth = context.auth
  if (!auth || !auth.roles.some(binding => binding.role === 'platform_admin')) {
    throw new Error('开发者工具仅允许平台管理员执行。')
  }
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
