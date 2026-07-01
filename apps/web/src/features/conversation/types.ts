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
  ConversationItem,
  ContextAssemblyReport,
  DecisionRequest,
  MemoryFileRecord,
  MemorySearchResult,
  ThreadMemoryDocument,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'
import type { DataReferenceSummary } from '../../shared/constants'

export type MemoryEntry = {
  scope: 'private' | 'team'
  relativePath: string
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  age: string
}

export type MemoryWriteInput = {
  scope: 'private' | 'team'
  type: 'user' | 'feedback' | 'project' | 'reference'
  name: string
  description: string
  content: string
  relativePath?: string | null
}

export type ComposerMode = 'plan' | 'auto'
export type TaskView = 'chat' | 'history'

export type ActiveDecision = DecisionRequest & {
  source: 'server' | 'local'
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
  decisions?: DecisionRequest[]
  sessionThreads: AgentThreadRecord[]
  items: ReadonlyArray<ConversationItem>
  runtimeConfig?: AgentRuntimeConfig
  availableTools?: ToolDescriptor[]
  onQueryChange: (value: string) => void
  onSubmit: (mode: ComposerMode) => void
  onInterrupt?: () => void
  onNewConversation: () => void
  onFillSample: (value: string) => void
  onRespondDecision: (decisionId: string, optionId?: string | null, text?: string | null) => void
  onUseTemplate: () => void
  onUploadFiles: (files: File[]) => void
  onSelectArtifact: (id: string) => void
  onSelectTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onDeleteTask: (id: string) => void
  onForkMessage?: (entryId: string) => void
  dataReferences: DataReferenceSummary[]
  threadContext?: ContextAssemblyReport
  threadMemory?: ThreadMemoryDocument
  onLoadThreadContext?: () => void
  onCompactThread?: () => void
  onSaveThreadMemory?: (content: string) => void
  onRebuildThreadMemory?: () => void
  trashedThreads?: Array<{ thread: AgentThreadRecord; deletedAt: string; purgeAfter: string }>
  onLoadTrash?: () => void
  onRestoreThread?: (threadId: string) => void
  onPurgeThread?: (threadId: string) => void

  memories?: MemoryEntry[]
  memoryRecords?: MemoryFileRecord[]
  onRefreshMemories?: () => Promise<void> | void
  onReadMemory?: (scope: 'private' | 'team', relativePath: string) => Promise<MemoryFileRecord>
  onWriteMemory?: (input: MemoryWriteInput) => Promise<MemoryFileRecord>
  onDeleteMemory?: (scope: 'private' | 'team', relativePath: string) => Promise<void>
  onSearchMemories?: (query: string) => Promise<MemorySearchResult[]>
  onDreamMemories?: () => Promise<void>

  tokenBudget?: { used: number; max: number; status: 'normal' | 'warning' | 'critical' | 'exceeded' }

  activeSkills?: string[]
  compactionLevel?: string | null
  runStats?: { toolAttempts: number; toolSuccesses: number; toolFailures: number; tokensUsed: number }
  denialCounts?: Record<string, number>

  executionPlan?: { goal: string; steps: { tool: string; args: Record<string, unknown>; reason: string }[] } | null

  tasks?: { id: string; content: string; status: string; activeForm: string }[]
}
