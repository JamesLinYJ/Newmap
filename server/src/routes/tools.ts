// Tools 路由
import { Hono } from 'hono'
import type { ToolRegistry } from '../tools.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'

export function toolRoutes(registry: ToolRegistry, _store: PostgresPlatformStore) {
  return new Hono()
    .get('/api/v1/tools', (c) => {
      return c.json(registry.descriptors())
    })
}
