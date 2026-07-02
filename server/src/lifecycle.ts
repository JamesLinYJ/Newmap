// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务生命周期管理
//
//   文件:       lifecycle.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import type { Database } from './db/connection.js'
import type { PostgresPlatformStore } from './store/platformStore.js'

interface LifecycleOptions {
  server: Server
  wsServer: WebSocketServer
  store: PostgresPlatformStore
  db: Database
  onShutdownStart: () => void
  timeoutMs?: number
}

// 生命周期管理器是进程关闭的唯一协调点。
//
// 这里不尝试伪装多进程 runtime 写入安全；单进程在收到信号后只做有界排空，
// 超时则显式失败退出，避免半关闭状态继续接收新的 Agent 任务。
export function installLifecycleManager(options: LifecycleOptions): void {
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    options.onShutdownStart()
    const timeoutMs = options.timeoutMs ?? 10_000
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`服务关闭超时：${timeoutMs}ms`)), timeoutMs).unref()
    })

    try {
      await Promise.race([drain(options), timeout])
      process.exit(0)
    } catch (error) {
      console.error(`[lifecycle] ${signal} shutdown failed:`, error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  }

  process.once('SIGINT', signal => { void shutdown(signal) })
  process.once('SIGTERM', signal => { void shutdown(signal) })
}

async function drain(options: LifecycleOptions): Promise<void> {
  for (const socket of options.wsServer.clients) {
    socket.close(1001, 'server shutting down')
  }
  await Promise.all([
    new Promise<void>((resolve, reject) => options.server.close(error => error ? reject(error) : resolve())),
    new Promise<void>(resolve => options.wsServer.close(() => resolve())),
  ])
  await options.store.conversationStore.flush()
  await options.db.close()
}
