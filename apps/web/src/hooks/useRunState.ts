// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态 Hook
//
//   文件:       useRunState.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { useCallback, useEffect, useReducer, startTransition } from 'react'
import type {
  AgentMessage,
  AgentMessageFrame,
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ExecutionPlan,
  RunEvent,
  UserIntent,
} from '@geo-agent-platform/shared-types'
import { getRun, getRunItems, getRunMessages, openRunMessageStream } from '../api'
import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { applyAgentMessageFrame } from '../messageLedger'

// 运行状态所有权
//
// 这个 hook 只持有服务端 run 的 UI 投影：完成态通过 hydrate 获取事实快照，
// 聊天态通过 AgentMessageFrame 追加；切换 run 时必须清理旧消息，避免历史串台。

interface RunState {
  run?: AnalysisRun
  agentState?: AgentState
  intent?: UserIntent
  executionPlan?: ExecutionPlan
  events: RunEvent[]
  messages: AgentMessage[]
  artifacts: ArtifactRef[]
  isSubmitting: boolean
  uiError?: string
  seenEventIds: Set<string>
  seenFrameIds: Set<string>
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  featureCount?: number
  items: ConversationItem[]
}

const MAX_EVENTS = 1000

function initialState(): RunState {
  return { events: [], messages: [], items: [], artifacts: [], isSubmitting: false, seenEventIds: new Set(), seenFrameIds: new Set() }
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

// Reducer 只做纯状态转移
//
// 网络订阅、hydrate 和提交态收敛都在 hook 层完成，避免 render 期间写 ref
// 或由 effect 同步派生 React 本身已经能表达的状态。

type RunAction =
  | { type: 'SET_RUN'; run: AnalysisRun; agentState: AgentState; intent?: UserIntent; plan?: ExecutionPlan; artifacts: ArtifactRef[] }
  | { type: 'SET_MESSAGES'; messages: AgentMessage[] }
  | { type: 'CLEAR_RUN' }
  | { type: 'APPEND_EVENT'; event: RunEvent }
  | { type: 'APPEND_FRAME'; frame: AgentMessageFrame }
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
        messages: (isDifferentRun && state.run?.threadId !== action.run.threadId) ? [] : state.messages,
        seenFrameIds: isDifferentRun ? new Set() : state.seenFrameIds,
      }
    }
    case 'SET_MESSAGES':
      return {
        ...state,
        messages: action.messages,
        seenFrameIds: new Set(),
      }
    case 'SET_ITEMS':
      return { ...state, items: action.items }
      }
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
    case 'APPEND_FRAME': {
      if (state.seenFrameIds.has(action.frame.frameId)) return state
      return {
        ...state,
        messages: applyAgentMessageFrame(state.messages, action.frame),
        seenFrameIds: new Set([...state.seenFrameIds, action.frame.frameId]),
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
// 对外暴露稳定命令函数；内部根据 runId/runStatus 管理 SSE 生命周期。

export function useRunState() {
  const [state, dispatch] = useReducer(runReducer, undefined, initialState)
  const runId = state.run?.id
  const runStatus = state.run?.status

  const clearRun = useCallback(() => {
    startTransition(() => dispatch({ type: 'CLEAR_RUN' }))
  }, [])

  const hydrateRun = useCallback(async (runId: string) => {
    const latestRun = await getRun(runId)
    const messages = latestRun.status === 'running' ? [] : await getRunMessages(runId)
    let items: ConversationItem[] = []
    if (latestRun.status !== 'running') {
      try { items = await getRunItems(runId) } catch { /* items 端点可能不可用 */ }
    }
    startTransition(() => {
      dispatch({
        type: 'SET_RUN',
        run: latestRun,
        agentState: latestRun.state,
        intent: latestRun.state.parsedIntent,
        plan: latestRun.state.executionPlan,
        artifacts: latestRun.state.artifacts,
      })
      dispatch({ type: 'SET_MESSAGES', messages })
      dispatch({ type: 'SET_ITEMS', items })
    })
    return latestRun
  }, [])

  const acceptRun = useCallback((latestRun: AnalysisRun) => {
    startTransition(() => {
      dispatch({
        type: 'SET_RUN',
        run: latestRun,
        agentState: latestRun.state,
        intent: latestRun.state.parsedIntent,
        plan: latestRun.state.executionPlan,
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
      const latestRun = await getRun(runId)
      const messages = await getRunMessages(runId)
      startTransition(() => {
        dispatch({
          type: 'SET_RUN',
          run: latestRun,
          agentState: latestRun.state,
          intent: latestRun.state.parsedIntent,
          plan: latestRun.state.executionPlan,
          artifacts: latestRun.state.artifacts,
        })
        dispatch({ type: 'SET_MESSAGES', messages })
      })
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
    } finally {
      dispatch({ type: 'SET_SUBMITTING', value: false })
    }
  }, [])

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

  // SSE connection
  useEffect(() => {
    if (!runId || runStatus !== 'running') return

    let source: EventSource | undefined
    let reconnectTimer: number | undefined
    let disposed = false
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 10

    // 流式消息帧按动画帧批量提交，避免每个 token 触发一次全量 re-render。
    let pendingFrames: AgentMessageFrame[] = []
    let rafId = 0

    const flushFrames = () => {
      rafId = 0
      if (pendingFrames.length === 0) return
      const batch = pendingFrames
      pendingFrames = []
      startTransition(() => {
        for (const frame of batch) {
          dispatch({ type: 'APPEND_FRAME', frame })
        }
      })
    }

    const enqueueFrame = (frame: AgentMessageFrame) => {
      pendingFrames.push(frame)
      if (rafId === 0) {
        rafId = requestAnimationFrame(flushFrames)
      }
    }

    const connect = () => {
      if (disposed) return

      source = openRunMessageStream(
        runId,
        (frame) => {
          reconnectAttempts = 0

          if (frame.op === 'block_delta') {
            enqueueFrame(frame)
          } else {
            if (rafId) {
              cancelAnimationFrame(rafId)
              rafId = 0
            }
            flushFrames()
            startTransition(() => dispatch({ type: 'APPEND_FRAME', frame }))
          }

          if (frame.op === 'result') {
            const resultType = String(frame.result?.type ?? '')
            if (resultType === 'failed') {
              const errors = frame.result?.errors
              dispatch({
                type: 'SET_ERROR',
                error: Array.isArray(errors) ? errors.join('；') : String(frame.result?.message ?? '运行失败。'),
              })
            }
            getRun(runId)
              .then((latestRun) => {
                if (disposed) return
                startTransition(() => {
                  dispatch({
                    type: 'SET_RUN',
                    run: latestRun,
                    agentState: latestRun.state,
                    intent: latestRun.state.parsedIntent,
                    plan: latestRun.state.executionPlan,
                    artifacts: latestRun.state.artifacts,
                  })
                })
              })
              .catch((error) => {
                if (disposed) return
                dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
              })
              .finally(() => {
                if (disposed) return
                dispatch({ type: 'SET_SUBMITTING', value: false })
              })
          }
        },
        () => {
          if (disposed) return
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            dispatch({ type: 'SET_ERROR', error: '事件流连续断开，已停止等待实时更新。' })
            dispatch({ type: 'SET_SUBMITTING', value: false })
            source?.close()
            return
          }
          reconnectAttempts += 1
          const delay = Math.min(1500 * Math.pow(2, reconnectAttempts - 1), 30000)
          getRun(runId)
            .then((latestRun) => {
              if (disposed) return
              startTransition(() => {
                dispatch({
                  type: 'SET_RUN',
                  run: latestRun,
                  agentState: latestRun.state,
                  intent: latestRun.state.parsedIntent,
                  plan: latestRun.state.executionPlan,
                  artifacts: latestRun.state.artifacts,
                })
              })
              if (!disposed && latestRun.status === 'running') {
                reconnectTimer = window.setTimeout(connect, delay)
              } else {
                dispatch({ type: 'SET_SUBMITTING', value: false })
              }
            })
            .catch(() => {
              if (!disposed) {
                reconnectTimer = window.setTimeout(connect, delay)
              }
            })
        },
      )
    }

    connect()

    return () => {
      disposed = true
      source?.close()
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      if (rafId) cancelAnimationFrame(rafId)
      pendingFrames = []
    }
  }, [runId, runStatus])

  return {
    run: state.run,
    agentState: state.agentState,
    intent: state.intent,
    executionPlan: state.executionPlan,
    events: state.events,
    messages: state.messages,
    artifacts: state.artifacts,
    isSubmitting: state.isSubmitting,
    uiError: state.uiError,
    placeResolution: state.placeResolution,
    clearRun,
    hydrateRun,
    acceptRun,
    startRun,
    finishRun,
    stopSubmitting,
    setError,
    setIntent,
    setPlan,
    appendArtifact,
    setMessages: (messages: AgentMessage[]) => startTransition(() => dispatch({ type: 'SET_MESSAGES', messages })),
  }
}
