// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面客户端
//
//   文件:       client.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { WsControlCommand, WsControlResponse, WsRunPush } from '@geo-agent-platform/shared-types'

type WsClientMessage =
  | WsRunPush
  | { type: 'connected'; id: null; payload: { data: null } }
  | { type: 'disconnected'; id: null; payload: { data: { reason: string } } }
  | { type: 'keepalive'; id: null; payload: { data: Record<string, unknown> } }

type Listener = (message: WsClientMessage) => void

interface PendingRequest {
  resolve: (message: WsControlResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 45_000
const RECONNECT_BASE_DELAY_MS = 1_200
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_MAX_ATTEMPTS = 8

class WebSocketControlClient {
  private socket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<Listener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private hasConnected = false
  private csrfToken: string | null = null

  async send(type: WsControlCommand, payload: Record<string, unknown>): Promise<WsControlResponse> {
    await this.ensureOpen()
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 当前未连接，本次写命令没有发送。')
    }

    const id = `req_${crypto.randomUUID().replaceAll('-', '')}`
    const securedPayload = this.csrfToken ? { ...payload, csrfToken: this.csrfToken } : payload
    const request = JSON.stringify({ type, id, payload: securedPayload })

    return new Promise<WsControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`WebSocket 命令超时：${type}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket?.send(request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    void this.ensureOpen().catch(() => undefined)
    return () => this.listeners.delete(listener)
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token
  }

  private async ensureOpen(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(resolveWsUrl())
      this.socket = socket

      const cleanupInitial = () => {
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('error', handleInitialError)
      }
      const handleOpen = () => {
        cleanupInitial()
        this.hasConnected = true
        this.reconnectAttempts = 0
        this.connectPromise = null
        this.emit({ type: 'connected', id: null, payload: { data: null } })
        resolve()
      }
      const handleInitialError = () => {
        cleanupInitial()
        this.connectPromise = null
        reject(new Error('WebSocket 连接失败，请确认 API 服务和 /ws 代理已经启动。'))
      }

      socket.addEventListener('open', handleOpen)
      socket.addEventListener('error', handleInitialError)
      socket.addEventListener('message', event => this.handleMessage(event.data))
      socket.addEventListener('close', event => {
        this.connectPromise = null
        if (this.socket === socket) this.socket = null
        this.rejectPending(`WebSocket 已断开：${event.reason || event.code}`)
        this.emit({ type: 'disconnected', id: null, payload: { data: { reason: event.reason || String(event.code) } } })
        if (isAuthCloseCode(event.code)) {
          this.hasConnected = false
          return
        }
        this.scheduleReconnect()
      })
    })

    return this.connectPromise
  }

  private handleMessage(raw: unknown) {
    const text = typeof raw === 'string' ? raw : raw instanceof Blob ? '' : String(raw)
    if (!text) return
    let message: WsControlResponse | WsRunPush | { type: string; id: string | null; payload: unknown }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }

    if (message.type === 'response') {
      const pending = message.id ? this.pending.get(message.id) : undefined
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id!)
      const response = message as WsControlResponse
      if (isFailedResponsePayload(response.payload) && isAuthFailure(response.payload.error.message)) {
        this.emit({ type: 'disconnected', id: null, payload: { data: { reason: response.payload.error.message } } })
      }
      pending.resolve(response)
      return
    }

    this.emit(message as WsClientMessage)
  }

  private rejectPending(reason: string) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  private scheduleReconnect() {
    if (!this.hasConnected || this.reconnectTimer) return
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.emit({
        type: 'disconnected',
        id: null,
        payload: { data: { reason: 'WebSocket 重连次数已达上限，请刷新或重新登录。' } },
      })
      return
    }
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * (2 ** this.reconnectAttempts),
    )
    const jitter = Math.floor(Math.random() * 250)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureOpen().catch(() => this.scheduleReconnect())
    }, delay + jitter)
  }

  private emit(message: WsClientMessage) {
    for (const listener of this.listeners) {
      listener(message)
    }
  }
}

export const wsClient = new WebSocketControlClient()

function resolveWsUrl() {
  const baseUrl = deriveApiBaseUrl(import.meta.env.VITE_API_BASE_URL)
  if (baseUrl) {
    const url = new URL(baseUrl, window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/ws`
    url.search = ''
    return url.toString()
  }

  const url = new URL('/ws', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function deriveApiBaseUrl(envBaseUrl?: string) {
  const explicit = envBaseUrl?.trim()
  if (!explicit || explicit === '/') {
    return ''
  }
  return explicit.replace(/\/+$/u, '')
}

function isAuthCloseCode(code: number): boolean {
  return code === 1008 || code === 4001 || code === 4401
}

function isAuthFailure(message: string): boolean {
  return /未登录|登录会话已失效|CSRF|Unauthorized|Forbidden/iu.test(message)
}

function isFailedResponsePayload(
  payload: WsControlResponse['payload'],
): payload is { ok: false; error: { code: string; message: string } } {
  return payload.ok === false
}
