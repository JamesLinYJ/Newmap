import manifest from "./manifest.json" with { type: "json" };
import { enterPlanModeTool, exitPlanModeTool, requestClarificationTool } from "./planTools.js";
const provider = { manifest, tools: () => [requestClarificationTool, enterPlanModeTool, exitPlanModeTool] };
export default provider;
