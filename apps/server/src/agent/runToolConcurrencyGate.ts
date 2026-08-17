// +-------------------------------------------------------------------------
//
//   地理智能平台 - 单次运行工具并发安全闸门
//
//   文件:       runToolConcurrencyGate.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolDef } from '../framework/types.js'

export type ToolExecutionLane = 'shared' | 'exclusive'

type AuthorizationLease = () => Promise<void>

interface ExecutionLease {
  lane: ToolExecutionLane
  nestedExclusiveTail: Promise<void>
}

interface WaitingLease {
  lane: ToolExecutionLane
  resolve(): void
}

const authorizationLeaseContext = new AsyncLocalStorage<AuthorizationLease>()

/**
 * Bind a live authorization lease to one Agent execution. Every tool operation
 * that crosses RunToolConcurrencyGate revalidates this lease immediately before
 * dispatch, after any queue wait. Nested sub-agent/MCP operations inherit the
 * same lease through AsyncLocalStorage.
 */
export function withToolAuthorizationLease<T>(
  assertAuthorized: AuthorizationLease,
  operation: () => Promise<T>,
): Promise<T> {
  return authorizationLeaseContext.run(assertAuthorized, operation)
}

// SDK 决定同一轮哪些 function call 并发启动；本闸门只实施平台安全约束。
// 无副作用只读调用默认共享通道，可用 parallelSafe=false 显式退出；其它调用互斥。独占子智能体内部的工具调用
// 使用同一租约内的串行队列，既避免重入死锁，也不向其它调用释放独占权。
export class RunToolConcurrencyGate {
  private readonly context = new AsyncLocalStorage<ExecutionLease>()
  private readonly waiting: WaitingLease[] = []
  private activeShared = 0
  private activeExclusive = false

  run<T>(lane: ToolExecutionLane, operation: () => Promise<T>): Promise<T> {
    const parent = this.context.getStore()
    if (parent?.lane === 'exclusive') {
      if (lane === 'shared') return this.runAuthorized(operation)
      return this.runNestedExclusive(parent, operation)
    }
    if (parent?.lane === 'shared') {
      if (lane === 'shared') return this.runAuthorized(operation)
      return Promise.reject(new Error('并发安全调用内部禁止提升为独占工具执行'))
    }
    return this.runWithLease(lane, operation)
  }

  private async runWithLease<T>(lane: ToolExecutionLane, operation: () => Promise<T>): Promise<T> {
    await this.acquire(lane)
    const lease: ExecutionLease = { lane, nestedExclusiveTail: Promise.resolve() }
    return this.context.run(lease, async () => {
      try {
        return await this.runAuthorized(operation)
      } finally {
        this.release(lane)
      }
    })
  }

  private runNestedExclusive<T>(lease: ExecutionLease, operation: () => Promise<T>): Promise<T> {
    const pending = lease.nestedExclusiveTail.then(
      () => this.runAuthorized(operation),
      () => this.runAuthorized(operation),
    )
    lease.nestedExclusiveTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async runAuthorized<T>(operation: () => Promise<T>): Promise<T> {
    const assertAuthorized = authorizationLeaseContext.getStore()
    if (assertAuthorized) await assertAuthorized()
    return operation()
  }

  private acquire(lane: ToolExecutionLane): Promise<void> {
    if (this.waiting.length === 0 && this.canAcquire(lane)) {
      this.markAcquired(lane)
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiting.push({ lane, resolve })
      this.pump()
    })
  }

  private release(lane: ToolExecutionLane): void {
    if (lane === 'exclusive') this.activeExclusive = false
    else this.activeShared = Math.max(0, this.activeShared - 1)
    this.pump()
  }

  private pump(): void {
    if (this.activeExclusive || this.waiting.length === 0) return
    const first = this.waiting[0]
    if (!first) return
    if (first.lane === 'exclusive') {
      if (this.activeShared > 0) return
      this.waiting.shift()
      this.markAcquired('exclusive')
      first.resolve()
      return
    }
    while (this.waiting[0]?.lane === 'shared' && !this.activeExclusive) {
      const next = this.waiting.shift()
      if (!next) return
      this.markAcquired('shared')
      next.resolve()
    }
  }

  private canAcquire(lane: ToolExecutionLane): boolean {
    if (lane === 'exclusive') return !this.activeExclusive && this.activeShared === 0
    return !this.activeExclusive
  }

  private markAcquired(lane: ToolExecutionLane): void {
    if (lane === 'exclusive') this.activeExclusive = true
    else this.activeShared += 1
  }
}

export function toolExecutionLane(
  definition: Pick<ToolDef, 'parallelSafe' | 'isReadOnly' | 'isDestructive' | 'requiresApproval'>,
  approvalRequired: boolean,
): ToolExecutionLane {
  return definition.parallelSafe !== false
    && definition.isReadOnly
    && !definition.isDestructive
    && definition.requiresApproval !== true
    && !approvalRequired
    ? 'shared'
    : 'exclusive'
}
