// +-------------------------------------------------------------------------
//
//   地理智能平台 - GIS/气象 Agent 开发工具 Provider
//
//   文件:       index.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Provider 安装阶段只校验根目录可用性；具体文件权限仍由每次工具调用的
// 路径解析器执行，避免启动后配置或符号链接变化绕过边界。

import type { ToolProvider } from '../../framework/types.js'
import { developerManifest, developerTools } from './definitions.js'
import { ensureConfiguredRootsExist } from './shared/pathPolicy.js'

const developerProvider: ToolProvider = {
  manifest: developerManifest,
  tools: () => developerTools,
  async onInstall(ctx) {
    await ensureConfiguredRootsExist(ctx.config)
  },
}

export default developerProvider
