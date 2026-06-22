// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态 Hook
//
//   文件:       useRunState.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { useCallback, useEffect, useReducer, useRef, startTransition } from 'react'
import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ExecutionPlan,
  RunEvent,
  UserIntent,
  ConversationItem,
} from '@geo-agent-platform/shared-types'
import {
  subscribeRun,
  unsubscribeRun,
} from '../../api/client'
import { wsClient } from '../../ws/client'

// 运行状态所有权
//
// 这个 hook 只持有服务端 run 的 UI 投影：完成态通过 hydrate 获取事实快照，
// 聊天态通过 ConversationItem 追加；切换 run 时必须清理旧 item，避免历史串台。

interface RunState {
  run?: AnalysisRun
  agentState?: AgentState
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  events: RunEvent[]
  artifacts: ArtifactRef[]
  isSubmitting: boolean
  uiError?: string
  seenEventIds: Set<string>
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  featureCount?: number
  items: ConversationItem[]
}

const MAX_EVENTS = 1000

function initialState(): RunState {
  return { events: [], items: [], artifacts: [], isSubmitting: false, seenEventIds: new Set() }
}

function formatHydrationError(error: unknown) {
  // hydrate 错误必须显式浮出到 UI。
  //
  // 完成态快照是最终结果和 artifact 的事实来源；失败时不能静默吞掉。
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return '刷新运行状态失败。'
}

function itemTime(item: ConversationItem) {
  const value = new Date(item.timestamp || 0).getTime()
  return Number.isFinite(value) ? value : 0
}

function upsertConversationItem(current: ConversationItem[], item: ConversationItem) {
  // ConversationItem 是聊天事实源。
  //
  // started/delta/completed 可能反复更新同一个 itemId；这里必须 upsert，
  // 不能像 RunEvent 那样按“已见过”去重，否则流式正文会停在首帧。
  const next = [...current]
  const index = next.findIndex((existing) => existing.itemId === item.itemId)
  if (index >= 0) {
    next[index] = item
  } else {
    next.push(item)
  }
  return next.sort((left, right) => itemTime(left) - itemTime(right))
}

function mergeConversationItems(current: ConversationItem[], incoming: ConversationItem[]) {
  return incoming.reduce(upsertConversationItem, current)
}

// Reducer 只做纯状态转移
//
// 网络订阅、hydrate 和提交态收敛都在 hook 层完成，避免 render 期间写 ref
// 或由 effect 同步派生 React 本身已经能表达的状态。

type RunAction =
  | { type: 'SET_RUN'; run: AnalysisRun; agentState: AgentState; intent?: UserIntent; plan?: ExecutionPlan; artifacts: ArtifactRef[] }
  | { type: 'CLEAR_RUN' }
  | { type: 'APPEND_EVENT'; event: RunEvent }
  | { type: 'SET_EVENTS'; events: RunEvent[] }
  | { type: 'APPEND_ITEM'; item: ConversationItem }
  | { type: 'SET_SUBMITTING'; value: boolean }
  | { type: 'SET_ERROR'; error?: string }
  | { type: 'SET_INTENT'; intent: UserIntent }
  | { type: 'SET_PLAN'; plan: ExecutionPlan }
  | { type: 'APPEND_ARTIFACT'; artifact: ArtifactRef }
  | { type: 'SET_ITEMS'; items: ConversationItem[] }
  | { type: 'SET_PLACE_RESOLUTION'; placeResolution: RunState['placeResolution'] }

function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'SET_RUN': {
      const isDifferentRun = state.run?.id !== action.run.id
      const isRunning = action.run.status === 'running'
      return {
        ...state,
        run: action.run,
        agentState: action.agentState,
        intent: action.intent,
        executionPlan: action.plan,
        artifacts: action.artifacts ?? [],
        placeResolution: action.agentState?.placeResolution ?? state.placeResolution,
        isSubmitting: isDifferentRun ? isRunning : isRunning ? state.isSubmitting : false,
        uiError: isDifferentRun ? undefined : state.uiError,
        events: state.events,
        seenEventIds: state.seenEventIds,
        items: (isDifferentRun && state.run?.threadId !== action.run.threadId) ? [] : state.items,
      }
    }
    case 'SET_ITEMS':
      return { ...state, items: mergeConversationItems([], action.items) }
    case 'CLEAR_RUN':
      return {
        ...initialState(),
        seenEventIds: new Set(),
      }
    case 'APPEND_EVENT': {
      if (state.seenEventIds.has(action.event.eventId)) return state
      const retainedEvents = state.events.length >= MAX_EVENTS
        ? state.events.slice(-(MAX_EVENTS - 1))
        : state.events
      const events = [...retainedEvents, action.event]
      const seenEventIds = new Set(events.map((event) => event.eventId))
      return { ...state, events, seenEventIds }
    }
    case 'SET_EVENTS': {
      const events = action.events.slice(-MAX_EVENTS)
      return { ...state, events, seenEventIds: new Set(events.map((event) => event.eventId)) }
    }
    case 'APPEND_ITEM': {
      return {
        ...state,
        items: upsertConversationItem(state.items, action.item),
      }
    }
    case 'SET_SUBMITTING':
      return { ...state, isSubmitting: action.value }
    case 'SET_ERROR':
      return { ...state, uiError: action.error }
    case 'SET_INTENT':
      return { ...state, intent: action.intent }
    case 'SET_PLAN':
      return { ...state, executionPlan: action.plan }
    case 'APPEND_ARTIFACT':
      return {
        ...state,
        artifacts: state.artifacts.some((a) => a.artifactId === action.artifact.artifactId)
          ? state.artifacts
          : [...state.artifacts, action.artifact],
      }
    case 'SET_PLACE_RESOLUTION':
      return { ...state, placeResolution: action.placeResolution }
    default:
      return state
  }
}

// Hook 入口
//
// 对外暴露稳定命令函数；内部根据 runId 管理 WebSocket 订阅与快照回放。

export function useRunState() {
  const [state, dispatch] = useReducer(runReducer, undefined, initialState)
  const runId = state.run?.id
  const subscribedRunIdRef = useRef<string | null>(null)

  const absorbSnapshot = useCallback((snapshot: { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }) => {
    startTransition(() => {
      dispatch({
        type: 'SET_RUN',
        run: snapshot.run,
        agentState: snapshot.run.state,
        intent: snapshot.run.state.parsedIntent ?? undefined,
        plan: snapshot.run.state.executionPlan ?? undefined,
        artifacts: snapshot.run.state.artifacts,
      })
      dispatch({ type: 'SET_ITEMS', items: snapshot.items })
      dispatch({ type: 'SET_EVENTS', events: snapshot.events })
    })
    if (snapshot.run.status !== 'running') dispatch({ type: 'SET_SUBMITTING', value: false })
  }, [])

  const clearRun = useCallback(() => {
    startTransition(() => dispatch({ type: 'CLEAR_RUN' }))
  }, [])

  const hydrateRun = useCallback(async (runId: string) => {
    const snapshot = await subscribeRun(runId)
    subscribedRunIdRef.current = runId
    absorbSnapshot(snapshot)
    return snapshot.run
  }, [absorbSnapshot])

  const acceptRun = useCallback((latestRun: AnalysisRun) => {
    startTransition(() => {
      dispatch({
        type: 'SET_RUN',
        run: latestRun,
        agentState: latestRun.state,
        intent: latestRun.state.parsedIntent ?? undefined,
        plan: latestRun.state.executionPlan ?? undefined,
        artifacts: latestRun.state.artifacts,
      })
    })
  }, [])

  const startRun = useCallback(() => {
    dispatch({ type: 'SET_SUBMITTING', value: true })
  }, [])

  const stopSubmitting = useCallback(() => {
    dispatch({ type: 'SET_SUBMITTING', value: false })
  }, [])

  const finishRun = useCallback(async (runId: string) => {
    try {
      await hydrateRun(runId)
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
    } finally {
      dispatch({ type: 'SET_SUBMITTING', value: false })
    }
  }, [hydrateRun])

  const setError = useCallback((error?: string) => {
    dispatch({ type: 'SET_ERROR', error })
  }, [])

  const setIntent = useCallback((intent: UserIntent) => {
    startTransition(() => dispatch({ type: 'SET_INTENT', intent }))
  }, [])

  const setPlan = useCallback((plan: ExecutionPlan) => {
    startTransition(() => dispatch({ type: 'SET_PLAN', plan }))
  }, [])

  const appendArtifact = useCallback((artifact: ArtifactRef) => {
    startTransition(() => dispatch({ type: 'APPEND_ARTIFACT', artifact }))
  }, [])

  // WebSocket 订阅是运行实时状态的唯一主线；重连后主动重订阅并吸收完整快照。
  useEffect(() => {
    if (!runId) return
    let disposed = false

    const absorbCurrentSnapshot = (snapshot: { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }) => {
      if (disposed || snapshot.run.id !== runId) return
      subscribedRunIdRef.current = runId
      absorbSnapshot(snapshot)
    }

    const unsubscribeMessages = wsClient.on(message => {
      if (message.type === 'connected') {
        void subscribeRun(runId).then(absorbCurrentSnapshot).catch(error => {
          if (!disposed) dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
        })
        return
      }
      if (message.type === 'run.item' && message.payload.data.runId === runId) {
        startTransition(() => dispatch({ type: 'APPEND_ITEM', item: message.payload.data }))
      }
      if (message.type === 'run.event' && message.payload.data.runId === runId) {
        startTransition(() => dispatch({ type: 'APPEND_EVENT', event: message.payload.data }))
      }
      if (message.type === 'run.snapshot' && isRunSnapshot(message.payload.data) && message.payload.data.run.id === runId) {
        absorbCurrentSnapshot(message.payload.data)
      }
    })

    if (subscribedRunIdRef.current !== runId) {
      void subscribeRun(runId).then(absorbCurrentSnapshot).catch(error => {
        if (!disposed) dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
      })
    }

    return () => {
      disposed = true
      unsubscribeMessages()
      if (subscribedRunIdRef.current === runId) subscribedRunIdRef.current = null
      void unsubscribeRun(runId).catch(() => undefined)
    }
  }, [absorbSnapshot, runId])

  const setItems = useCallback((items: ConversationItem[]) => {
    startTransition(() => dispatch({ type: 'SET_ITEMS', items }))
  }, [])

  return {
    run: state.run,
    agentState: state.agentState,
    intent: state.intent,
    executionPlan: state.executionPlan,
    events: state.events,
    artifacts: state.artifacts,
    isSubmitting: state.isSubmitting,
    uiError: state.uiError,
    placeResolution: state.placeResolution,
    clearRun,
    items: state.items,
    hydrateRun,
    acceptRun,
    startRun,
    finishRun,
    stopSubmitting,
    setError,
    setIntent,
    setPlan,
    appendArtifact,
    setItems,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRunSnapshot(value: unknown): value is { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] } {
  return isRecord(value) && isRecord(value.run) && Array.isArray(value.items) && Array.isArray(value.events)
}
