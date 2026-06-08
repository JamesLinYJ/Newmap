import manifest from "./manifest.json" with { type: "json" }
import type { ToolProvider } from "../../framework/types.js"
import { chartTool } from "./chart.js"
const provider: ToolProvider = { manifest, tools: () => [chartTool] }
export default provider
