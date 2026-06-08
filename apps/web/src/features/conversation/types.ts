// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话功能类型
//
//   文件:       types.ts
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// conversation feature 的本地 UI 类型。ConversationItem 仍来自 shared-types，
// 这里只描述前端面板 props、编辑态和展示态，不创建新的聊天事实源。

import type {
  AgentRuntimeConfig,
  AgentThreadRecord,
  ClarificationOption,
  ClarificationState,
  ConversationItem,
  ToolDescriptor,
  UserIntent,
} from '@geo-agent-platform/shared-types'
import type { DataReferenceSummary } from '../../shared/constants'

export type MemoryEntry = {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  age: string
}

export type ComposerMode = 'plan' | 'auto'
export type TaskView = 'chat' | 'history'

export type ActiveClarification = {
  key: string
  question: string
  options: ClarificationOption[]
  allowFreeText: boolean
}

export interface ChatPanelProps {
  artifactCount: number
  currentRunId?: string
  currentThreadId?: string
  currentThreadTitle?: string
  runCreatedAt?: string
  providerLabel: string
  runStatus?: string
  query: string
  isSubmitting: boolean
  errorMessage?: string
  uploadedLayerName?: string
  intent?: UserIntent
  clarification?: ClarificationState | null
  sessionThreads: AgentThreadRecord[]
  items: ReadonlyArray<ConversationItem>
  runtimeConfig?: AgentRuntimeConfig
  availableTools?: ToolDescriptor[]
  onQueryChange: (value: string) => void
  onSubmit: (mode: ComposerMode) => void
  onInterrupt?: () => void
  onNewConversation: () => void
  onFillSample: (value: string) => void
  onSelectClarification: (value: string, id?: string | null) => void
  onUseTemplate: () => void
  onUploadFiles: (files: File[]) => void
  onSelectArtifact: (id: string) => void
  onSelectTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onDeleteTask: (id: string) => void
  onResolveApproval: (id: string, approved: boolean) => void
  dataReferences: DataReferenceSummary[]

  memories?: MemoryEntry[]
  onRefreshMemories?: () => void

  tokenBudget?: { used: number; max: number; status: 'normal' | 'warning' | 'critical' | 'exceeded' }

  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: { toolAttempts: number; toolSuccesses: number; toolFailures: number; tokensUsed: number }
  denialCounts?: Record<string, number>

  executionPlan?: { goal: string; steps: { tool: string; args: Record<string, unknown>; reason: string }[] } | null
  onApprovePlan?: () => void
  onEditPlan?: () => void

  tasks?: { id: string; content: string; status: string; activeForm: string }[]
}
