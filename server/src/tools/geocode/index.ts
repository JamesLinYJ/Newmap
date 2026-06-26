import manifest from './manifest.json' with { type: 'json' };
import { geocodePlaceTool } from './handler.js';
const provider = {
    manifest,
    tools: () => [geocodePlaceTool],
};
export default provider;