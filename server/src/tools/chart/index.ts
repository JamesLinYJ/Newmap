import manifest from "./manifest.json" with { type: "json" };
import { chartTool } from "./chart.js";
const provider = { manifest, tools: () => [chartTool] };
export default provider;