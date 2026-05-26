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
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ExecutionPlan,
  RunEvent,
  UserIntent,
} from '@geo-agent-platform/shared-types'
import { getRun, openRunEventStream } from '../api'

// 运行状态所有权
//
// 这个 hook 只持有服务端 run 的 UI 投影：完成态通过 hydrate 获取事实快照，
// 运行态通过 SSE 追加事件；切换 run 时必须清理旧事件，避免历史事件串台。

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
}

const MAX_EVENTS = 1000

function initialState(): RunState {
  return { events: [], artifacts: [], isSubmitting: false, seenEventIds: new Set() }
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
  | { type: 'CLEAR_RUN' }
  | { type: 'APPEND_EVENT'; event: RunEvent }
  | { type: 'SET_SUBMITTING'; value: boolean }
  | { type: 'SET_ERROR'; error?: string }
  | { type: 'SET_INTENT'; intent: UserIntent }
  | { type: 'SET_PLAN'; plan: ExecutionPlan }
  | { type: 'APPEND_ARTIFACT'; artifact: ArtifactRef }
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
        events: isDifferentRun ? [] : state.events,
        seenEventIds: isDifferentRun ? new Set() : state.seenEventIds,
      }
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

    // 流式事件按动画帧批量提交，避免每个 token 触发一次全量 re-render
    let pendingEvents: RunEvent[] = []
    let rafId = 0

    const flushEvents = () => {
      rafId = 0
      if (pendingEvents.length === 0) return
      const batch = pendingEvents
      pendingEvents = []
      startTransition(() => {
        for (const evt of batch) {
          dispatch({ type: 'APPEND_EVENT', event: evt })
        }
      })
    }

    const enqueueEvent = (event: RunEvent) => {
      pendingEvents.push(event)
      if (rafId === 0) {
        rafId = requestAnimationFrame(flushEvents)
      }
    }

    const connect = () => {
      if (disposed) return

      source = openRunEventStream(
        runId,
        (event) => {
          reconnectAttempts = 0

          const isStreaming = event.type === 'message.delta' || event.type === 'thinking.delta' || event.type === 'loop.updated'
          if (isStreaming) {
            enqueueEvent(event)
          } else {
            startTransition(() => dispatch({ type: 'APPEND_EVENT', event }))
          }

          if (event.type === 'intent.parsed') {
            startTransition(() => dispatch({ type: 'SET_INTENT', intent: event.payload as unknown as UserIntent }))
          }
          if (event.type === 'plan.ready') {
            startTransition(() => dispatch({ type: 'SET_PLAN', plan: event.payload as unknown as ExecutionPlan }))
          }
          if (event.type === 'artifact.created' && event.payload) {
            const artifact = event.payload as unknown as ArtifactRef
            if (artifact?.artifactId) {
              startTransition(() => dispatch({ type: 'APPEND_ARTIFACT', artifact }))
            }
          }
          // 工具完成后，通用提取坐标数据驱动地图飞行（不针对特定工具）
          if (event.type === 'tool.completed' && event.payload) {
            const p = event.payload as Record<string, unknown>
            const result = p.result as Record<string, unknown> | undefined
            const selected = result?.selected as Record<string, unknown> | undefined
            const lat = selected?.latitude ?? result?.latitude ?? result?.center_lat ?? result?.lat
            const lng = selected?.longitude ?? result?.longitude ?? result?.center_lng ?? result?.lng
            if (typeof lat === 'number' && typeof lng === 'number') {
              startTransition(() => dispatch({
                type: 'SET_PLACE_RESOLUTION',
                placeResolution: { status: 'resolved', selected: { latitude: lat, longitude: lng } },
              }))
            }
          }
          if (event.type === 'warning.raised') {
            dispatch({ type: 'SET_ERROR', error: undefined })
          }
          if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'approval.required' || event.type === 'clarification.required') {
            if (event.type === 'run.failed') {
              const payload = event.payload as Record<string, unknown> | undefined
              dispatch({
                type: 'SET_ERROR',
                error: String((payload?.errors as string[] | undefined)?.join('；') || event.message),
              })
            }
            // 终止态统一 hydrate；人工等待事件会落到对应的 waiting_* 快照。
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
      pendingEvents = []
    }
  }, [runId, runStatus])

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
    hydrateRun,
    acceptRun,
    startRun,
    finishRun,
    stopSubmitting,
    setError,
    setIntent,
    setPlan,
    appendArtifact,
  }
}
