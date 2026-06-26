// +-------------------------------------------------------------------------
//
//   地理智能平台 - 路径规划 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------
import { getEnv } from '../../framework/env.js';
import manifest from './manifest.json' with { type: 'json' };
import { createRoutePlannerTool } from './routePlanner.js';
export function createRoutingProvider() {
    const env = getEnv();
    return {
        manifest,
        tools: () => [createRoutePlannerTool(env.VALHALLA_BASE_URL ?? '', env.ROUTING_TIMEOUT_MS)],
    };
}