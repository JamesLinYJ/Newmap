import manifest from "./manifest.json" with { type: "json" }
import type { ToolProvider } from "../../framework/types.js"
import { taskCreateTool, taskListTool } from "./handler.js"
const provider: ToolProvider = { manifest, tools: () => [taskCreateTool, taskListTool] }
export default provider
