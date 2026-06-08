// Config 路由
import { Hono } from 'hono'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../tools.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { getEnv } from '../env.js'

export function configRoutes(registry: ModelAdapterRegistry, toolRegistry: ToolRegistry, store: PostgresPlatformStore) {
  return new Hono()
    .get('/api/v1/providers', (c) => {
      return c.json(registry.descriptors())
    })
    .get('/api/v1/system/components', (c) => {
      return c.json({
        catalogBackend: 'typescript-postgis',
        postgisEnabled: true,
        sidecarBackend: 'python-special-tools',
        sessionLogRoot: getEnv().RUNTIME_ROOT,
        providers: registry.descriptors(),
      })
    })
}
