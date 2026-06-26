import manifest from "./manifest.json" with { type: "json" };
import { ttsTool, digitalHumanTool } from "./mediaTools.js";
const provider = {
    manifest,
    tools: () => [ttsTool, digitalHumanTool],
    async onInstall(ctx) {
        const workerUrl = ctx.config.MEDIA_WORKER_URL;
        if (!workerUrl)
            throw new Error('MEDIA_WORKER_URL 未配置');
        const response = await fetch(`${workerUrl.replace(/\/$/u, '')}/health`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok)
            throw new Error(`媒体 Worker 健康检查失败：HTTP ${response.status}`);
    },
};
export default provider;