// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool 框架类型（语言无关）
//
//   文件:       types.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// ToolProvider —— 第三方/内置实现的统一接口

export interface ToolManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  language: string
  homepage?: string
  endpoint?: string         // Python provider 的 HTTP 地址
  requires?: Record<string, string>
  tools: ToolManifestEntry[]
}

export interface ToolManifestEntry {
  name: string
  label: string
  description: string
  group: string
  tags: string[]
  isReadOnly: boolean
  isDestructive: boolean
  jsonSchema?: Record<string, unknown>
}

// ToolDef —— 运行时 tool 定义

export interface ToolDef {
  name: string
  label: string
  description: string
  group: string
  tags: string[]
  isReadOnly: boolean
  isDestructive: boolean
  jsonSchema: Record<string, unknown>
  handler: ToolHandler
  providerId?: string
  language?: string
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>

// ToolContext —— handler 运行时上下文

export interface ToolContext {
  runId: string
  sessionId: string
  threadId: string | null
  state: Map<string, unknown>
  log(level: 'info' | 'warn' | 'error', message: string): void
}

// ToolResult

export interface ToolResult {
  message: string
  payload: Record<string, unknown>
  warnings: string[]
  resultId: string
  source: string
  valueRefs?: ValueRef[]
}

export interface ValueRef {
  refId: string
  kind: string
  label: string
  value: unknown
  unit?: string | null
}

// ToolProvider 实例

export interface ToolProvider {
  manifest: ToolManifest
  tools(): ToolDef[]
  onInstall?(ctx: InstallContext): Promise<void>
  onUninstall?(ctx: InstallContext): Promise<void>
}

export interface InstallContext {
  config: Record<string, string | undefined>
  state: Map<string, unknown>
  log(level: 'info' | 'warn' | 'error', message: string): void
}
