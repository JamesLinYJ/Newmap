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

export class InMemoryEventBus<T> {
  private readonly subscribers = new Map<string, Set<Listener<T>>>()
  private readonly history = new Map<string, T[]>()

  subscribe(key: string, listener: Listener<T>): () => void {
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set())
    this.subscribers.get(key)?.add(listener)
    return () => this.subscribers.get(key)?.delete(listener)
  }

  publish(key: string, item: T): void {
    const items = this.history.get(key) ?? []
    items.push(item)
    this.history.set(key, items)
    this.subscribers.get(key)?.forEach(callback => callback(item))
  }

  list(key: string): T[] {
    return [...(this.history.get(key) ?? [])]
  }

  clear(key: string): void {
    this.subscribers.delete(key)
    this.history.delete(key)
  }
}
