// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发工具结果构造
//
//   文件:       result.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// Developer tools 不生成伪 artifact。文件写入、搜索和命令执行只把可审计
// 的结果与 provenance 写回 run state，后续 UI 以工具卡片展示。

import type { ToolResult, ValueRef } from '../../../framework/types.js'
import { makeId } from '../../../utils/ids.js'

export function developerResult(
  toolName: string,
  message: string,
  payload: Record<string, unknown>,
  options: {
    warnings?: string[]
    valueRefs?: ValueRef[]
    provenance?: Record<string, unknown>
  } = {},
): ToolResult {
  return {
    message,
    payload,
    warnings: options.warnings ?? [],
    resultId: makeId('result'),
    source: `developer.${toolName}`,
    valueRefs: options.valueRefs,
    provenance: {
      providerId: 'geo-platform-developer-tools',
      toolName,
      ...(options.provenance ?? {}),
    },
  }
}
