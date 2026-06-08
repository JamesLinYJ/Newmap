// +-------------------------------------------------------------------------
//
//   地理智能平台 - React Hook: WebSocket message stream
//
//   文件:       useMessages.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { useEffect, useState, useCallback } from 'react'
import { wsClient, type ServerMessage } from './client.js'

export function useWs() {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    wsClient.connect()
    const unsub = wsClient.on((msg) => {
      if (msg.type === 'connected') setConnected(true)
      if (msg.type === 'disconnected') setConnected(false)
    })
    return unsub
  }, [])

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    return wsClient.send(type, payload)
  }, [])

  const onMessage = useCallback((handler: (msg: ServerMessage) => void) => {
    return wsClient.on(handler)
  }, [])

  return { connected, send, onMessage }
}
