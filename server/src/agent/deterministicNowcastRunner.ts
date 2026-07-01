// +-------------------------------------------------------------------------
//
//   地理智能平台 - 确定性短时临近预报（短临）运行器
//
//   文件:       deterministicNowcastRunner.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolResult, ValueRef } from '../framework/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { ItemSink } from '../conversation/itemSink.js'
import type { RunEventSink } from './turnRunner.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'

const METEOROLOGICAL_FILE_SUFFIXES = ['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5', '.bz2']

export async function shouldRunDeterministicNowcast(
  store: PostgresPlatformStore,
  query: string,
  threadId: string,
): Promise<boolean> {
  if (!isNowcastQuestion(query)) return false
  const files = await new RuntimeFileStore(store.runtimeRoot).list(threadId)
  return files.some(file => METEOROLOGICAL_FILE_SUFFIXES.some(suffix => file.name.toLowerCase().endsWith(suffix)))
}

// runDeterministicNowcast
//
// 气象事实只经工具和 valueRef 流转；模型不参与该交付链，也没有文本降级路径。
export async function runDeterministicNowcast(options: {
  store: PostgresPlatformStore
  coordinator: ToolExecutionCoordinator
  eventSink: RunEventSink
  itemSink: ItemSink
  runId: string
  threadId: string
  turnId: string
  query: string
}): Promise<void> {
  const listed = await options.coordinator.executeDirect('list_meteorological_files', {})
  const collectionRef = requiredResultRef(listed, ['meteorological_file_collection'])
  const files = isRecord(collectionRef.value) && Array.isArray(collectionRef.value.files) ? collectionRef.value.files : []
  if (files.length < 2) throw new Error(`杭州短时临近预报（短临）分析至少需要两个气象文件，当前线程找到 ${files.length} 个`)

  const sequence = await options.coordinator.executeDirect('create_nowcast_sequence', {
    file_collection_ref: collectionRef.refId,
  })
  const sequenceRef = requiredResultRef(sequence, ['nowcast_sequence'])
  const prepared = await options.coordinator.executeDirect('prepare_hangzhou_nowcast_scope', { question: options.query })
  const scopeRef = requiredResultRef(prepared, ['nowcast_area', 'nowcast_coordinate', 'bbox'])
  const analyzed = await options.coordinator.executeDirect('meteorological_precipitation_nowcast', {
    sequence_ref: sequenceRef.refId,
    scope_ref: scopeRef.refId,
  })
  const analysisRef = requiredResultRef(analyzed, ['nowcast_analysis'])
  const answered = await options.coordinator.executeDirect('answer_nowcast_question', {
    nowcast_analysis_ref: analysisRef.refId,
    question: options.query,
  })
  if (typeof answered.payload.answer !== 'string' || !answered.payload.answer.trim()) {
    throw new Error('短时临近预报（短临）回答工具未返回可交付文本')
  }
  const answer = answered.payload.answer.trim()
  const answerEntry = await options.store.appendTranscript({
    threadId: options.threadId,
    runId: options.runId,
    turnId: options.turnId,
    kind: 'message',
    payload: { role: 'assistant', content: answer },
  })
  options.itemSink.appendAssistantMessage(answer, { transcriptEntryId: answerEntry.entryId })
}

function isNowcastQuestion(query: string): boolean {
  const normalized = query.replace(/\s+/gu, '')
  return /(天气怎么样|天气如何|会不会下雨|会下雨吗|下雨吗|短时临近预报（短临）|未来.{0,8}(降水|降雨|天气)|接下来.{0,8}(天气|降水|降雨|下雨))/u.test(normalized)
}

function requiredResultRef(result: ToolResult, kinds: string[]): ValueRef {
  const ref = result.valueRefs?.find(candidate => kinds.includes(candidate.kind))
  if (!ref) throw new Error(`工具结果缺少 ${kinds.join(' / ')} valueRef`)
  return ref
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
