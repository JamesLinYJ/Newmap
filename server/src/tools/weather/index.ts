import manifest from "./manifest.json" with { type: "json" }
import type { ToolProvider } from "../../framework/types.js"
import { meteorologicalInspect, meteorologicalRender, meteorologicalStats, meteorologicalThreshold, meteorologicalContour, meteorologicalReport, precipitationNowcast } from "./weatherTools.js"
const provider: ToolProvider = { manifest, tools: () => [meteorologicalInspect, meteorologicalRender, meteorologicalStats, meteorologicalThreshold, meteorologicalContour, meteorologicalReport, precipitationNowcast] }
export default provider
