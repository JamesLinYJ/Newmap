// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 选择派生逻辑
//
//   文件:       artifactSelection.ts
//
//   日期:       2026年04月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------
// 模块职责
//
// 集中处理当前 artifact 的默认选中规则，减少页面组件重复拼装选择逻辑。
import type { ArtifactRef } from '@geo-agent-platform/shared-types'

export function pickPreferredArtifactId(artifacts: ArtifactRef[]): string | undefined {
  return artifacts.at(-1)?.artifactId
}
