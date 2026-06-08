import manifest from "./manifest.json" with { type: "json" }
import type { ToolProvider } from "../../framework/types.js"
import { enterPlanModeTool, exitPlanModeTool } from "./planTools.js"
const provider: ToolProvider = { manifest, tools: () => [enterPlanModeTool, exitPlanModeTool] }
export default provider
