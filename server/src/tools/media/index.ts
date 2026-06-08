import manifest from "./manifest.json" with { type: "json" }
import type { ToolProvider } from "../../framework/types.js"
import { ttsTool, digitalHumanTool } from "./mediaTools.js"
const provider: ToolProvider = { manifest, tools: () => [ttsTool, digitalHumanTool] }
export default provider
