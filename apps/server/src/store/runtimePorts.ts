// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 运行时持久化端口
//
//   文件:       runtimePorts.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  CompactionRecord,
  ContentRef,
  RunCheckpoint,
  RunEvent,
  RunSteeringRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  ToolValueRef,
  TranscriptEntry,
  TranscriptEntryKind,
  ConversationItem,
} from '../schemas/types.js'
import type { ConversationItemStoreUpdate } from '../conversation/itemUpdates.js'
import type { VisibleArtifactResource } from './postgres/artifactRepository.js'
import type { FileLifecyclePort } from './fileLifecycleService.js'
import type { MeteorologicalStore } from './postgres/meteorologicalStore.js'

export interface AppendTranscriptInput {
  threadId: string
  runId?: string | null
  turnId?: string | null
  kind: TranscriptEntryKind
  payload?: Record<string, unknown>
  parentEntryId?: string | null
  logicalParentEntryId?: string | null
  entryId?: string
}

export interface AgentRuntimeStore {
  readonly runtimeRoot: string
  readonly fileLifecycle: Pick<FileLifecyclePort, 'list' | 'readAuthorized'>
  readonly meteorology: Pick<MeteorologicalStore,
    | 'listMeteorologicalDatasets'
    | 'resolveMeteorologicalDataset'
  >
  getRun(runId: string): AnalysisRun
  listRunsForThread(threadId: string): AnalysisRun[]
  mutateRunState(runId: string, mutation: (state: AgentState) => Partial<AgentState>): Promise<AnalysisRun>
  updateRunState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun>
  updateRunStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun>
  completeRun(runId: string, status: string): Promise<AnalysisRun>
  saveRunCheckpoint(
    runId: string,
    fields?: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  getRunCheckpoint(runId: string): Promise<RunCheckpoint>
  appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void>
  saveAgentsSdkState(
    runId: string,
    serializedState: string,
    metadata: {
      agentsSdkVersion: string
      runtimeConfigDigest: string
      inputLeaseId?: string | null
      terminalToolCallIds?: readonly string[]
    },
  ): Promise<RunSteeringRecord[]>
  readAgentsSdkState(runId: string): Promise<string>
  appendEvent(runId: string, event: RunEvent): Promise<void>
  listEvents(runId: string): Promise<RunEvent[]>
  appendItem(update: ConversationItemStoreUpdate): Promise<void>
  projectPersistedItems(items: readonly ConversationItem[]): Promise<void>
  listItems(runId: string): Promise<ConversationItem[]>
  enqueueRunInput(input: {
    inputId: string
    entryId: string
    itemId: string
    runId: string
    content: string
  }): Promise<RunSteeringRecord>
  getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null>
  leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]>
  requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]>
  listRunInputs(runId: string): Promise<RunSteeringRecord[]>
  activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]>
  appendTranscript(input: AppendTranscriptInput): Promise<TranscriptEntry>
  getThreadManifest(threadId: string): Promise<ThreadManifest>
  getThreadMemory(threadId: string): Promise<ThreadMemoryDocument>
  updateThreadMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source?: ThreadMemoryDocument['source'],
    basedOnEntryId?: string | null,
  ): Promise<ThreadMemoryDocument>
  appendCompaction(record: CompactionRecord): Promise<void>
  putConversationObject(content: string | Uint8Array, mediaType?: string): Promise<ContentRef>
  publishConversationObject<T>(
    content: string | Uint8Array,
    mediaType: string,
    commitReference: (reference: ContentRef) => Promise<T>,
  ): Promise<T>
  readConversationObject(reference: ContentRef): Promise<Uint8Array>
  appendToolValue(runId: string, value: ToolValueRef): Promise<void>
  persistArtifact(artifact: ArtifactRef): Promise<void>
  commitToolResult: (
    runId: string,
    resultId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ) => Promise<boolean>
  listArtifactsVisibleToRun(
    runId: string,
    options?: { artifactIds?: readonly string[]; limit?: number },
  ): Promise<VisibleArtifactResource[]>
}

export type RunLookupStore = Pick<AgentRuntimeStore, 'getRun'>

export type ThreadContextStore = Pick<AgentRuntimeStore,
  | 'runtimeRoot'
  | 'fileLifecycle'
  | 'activeTranscript'
  | 'appendCompaction'
  | 'appendTranscript'
  | 'getThreadManifest'
  | 'getThreadMemory'
  | 'listRunsForThread'
  | 'readConversationObject'
  | 'updateThreadMemory'
>

export type MemoryConversationStore = Pick<AgentRuntimeStore,
  | 'activeTranscript'
  | 'getRun'
  | 'getThreadManifest'
  | 'getThreadMemory'
  | 'updateThreadMemory'
>

export type ToolExecutionStore = Pick<AgentRuntimeStore,
  | 'activeTranscript'
  | 'appendToolValue'
  | 'appendTranscript'
  | 'commitToolResult'
  | 'getRun'
  | 'meteorology'
  | 'persistArtifact'
  | 'putConversationObject'
  | 'publishConversationObject'
  | 'runtimeRoot'
  | 'saveRunCheckpoint'
  | 'mutateRunState'
  | 'updateRunState'
>

export type PersistentToolStore = ToolExecutionStore & Pick<AgentRuntimeStore,
  | 'appendEvent'
  | 'appendItem'
>
