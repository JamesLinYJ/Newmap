// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket Client
//
//   文件:       client.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

export type ServerMessage = {
  type: string
  id: string | null
  payload: Record<string, unknown>
}

type MessageHandler = (msg: ServerMessage) => void

export class WsClient {
  private ws: WebSocket | null = null
  private handlers = new Set<MessageHandler>()
  private pending = new Map<string, { resolve: (msg: ServerMessage) => void; reject: (err: Error) => void }>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reqCounter = 0
  private _connected = false

  constructor(private url: string) {}

  get connected() { return this._connected }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this._connected = true
      this.notify({ type: 'connected', id: null, payload: {} })
    }

    this.ws.onmessage = (event) => {
      const lines = String(event.data).split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const msg: ServerMessage = JSON.parse(line)
          if (msg.type === 'keepalive') continue
          // Resolve pending request
          if (msg.id && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!.resolve(msg)
            this.pending.delete(msg.id)
          }
          this.notify(msg)
        } catch { /* skip malformed */ }
      }
    }

    this.ws.onclose = () => {
      this._connected = false
      this.notify({ type: 'disconnected', id: null, payload: {} })
      this.reconnect()
    }

    this.ws.onerror = () => {
      // onclose will fire after this
    }
  }

  private reconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }

  on(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  send(type: string, payload: Record<string, unknown> = {}): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket 未连接'))
        return
      }
      const id = `req_${++this.reqCounter}`
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ type, id, payload }) + '\n')
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.get(id)!.reject(new Error('请求超时'))
          this.pending.delete(id)
        }
      }, 30000)
    })
  }

  fire(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type, id: null, payload }) + '\n')
  }

  private notify(msg: ServerMessage): void {
    this.handlers.forEach(h => h(msg))
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this._connected = false
  }
}

// Singleton
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
export const wsClient = new WsClient(wsUrl)
