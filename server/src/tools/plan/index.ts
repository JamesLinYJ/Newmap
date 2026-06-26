import manifest from "./manifest.json" with { type: "json" };
import { enterPlanModeTool, exitPlanModeTool } from "./planTools.js";
const provider = { manifest, tools: () => [enterPlanModeTool, exitPlanModeTool] };
export default provider;