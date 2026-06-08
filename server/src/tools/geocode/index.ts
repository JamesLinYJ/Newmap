import manifest from './manifest.json' with { type: 'json' }
import type { ToolProvider } from '../../framework/types.js'
import { geocodePlaceTool } from './handler.js'

const provider: ToolProvider = {
  manifest,
  tools: () => [geocodePlaceTool],
}
export default provider
