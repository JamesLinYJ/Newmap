import type { AgentRuntimeConfig } from '../schemas/types.js'
import { scopeMemoryContextConfig } from '../memory/paths.js'
import type { AuthContext } from './types.js'

/**
 * Convert the administrator-defined global runtime ceiling into the exact
 * capabilities and storage roots granted to one authenticated principal.
 *
 * This function is the only supported bridge from global runtime config to a
 * user/service execution context. Callers must persist or execute the returned
 * value; they must not fall back to the unscoped global object.
 */
export function scopeRuntimeConfigToPrincipal(
  runtimeRoot: string,
  config: AgentRuntimeConfig,
  auth: Pick<AuthContext, 'defaultWorkspaceId' | 'userId' | 'roles'>,
  projectRoot = process.cwd(),
): AgentRuntimeConfig {
  const isPlatformAdmin = auth.roles.some(binding => binding.role === 'platform_admin')
  return {
    ...config,
    developer: {
      ...config.developer,
      enabled: config.developer.enabled && isPlatformAdmin,
    },
    context: scopeMemoryContextConfig(
      runtimeRoot,
      config.context,
      {
        workspaceId: auth.defaultWorkspaceId,
        userId: auth.userId,
      },
      projectRoot,
    ),
  }
}
