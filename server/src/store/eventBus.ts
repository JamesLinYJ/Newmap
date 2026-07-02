// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内存事件总线
//
//   文件:       eventBus.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

type Listener<T> = (item: T) => void
const DEFAULT_HISTORY_LIMIT = 500

export class InMemoryEventBus<T> {
  private readonly subscribers = new Map<string, Set<Listener<T>>>()
  private readonly history = new Map<string, T[]>()

  constructor(private readonly historyLimit = DEFAULT_HISTORY_LIMIT) {}

  subscribe(key: string, listener: Listener<T>): () => void {
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set())
    this.subscribers.get(key)?.add(listener)
    return () => {
      const listeners = this.subscribers.get(key)
      listeners?.delete(listener)
      if (listeners && listeners.size === 0) this.subscribers.delete(key)
    }
  }

  publish(key: string, item: T): void {
    const items = this.history.get(key) ?? []
    items.push(item)
    if (items.length > this.historyLimit) items.splice(0, items.length - this.historyLimit)
    this.history.set(key, items)
    this.subscribers.get(key)?.forEach(callback => {
      try {
        callback(item)
      } catch (error) {
        console.error('[event-bus] subscriber failed:', error instanceof Error ? error.message : String(error))
      }
    })
  }

  list(key: string): T[] {
    return [...(this.history.get(key) ?? [])]
  }

  clear(key: string): void {
    this.subscribers.delete(key)
    this.history.delete(key)
  }
}
