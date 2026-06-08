// +-------------------------------------------------------------------------
//
//   workspacePointer 单元测试
//
//   文件:       workspacePointer.test.ts
//
//   日期:       2026年06月03日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 测试 localStorage 指针仅在 UI 选中提示角色下工作，
// 不承担会话归属或历史数据源职责。

import { describe, it, expect } from 'vitest'
import {
  readWorkspacePointer,
  normalizeWorkspacePointer,
  rememberWorkspacePointer,
  syncCleanWorkspaceUrl,
  buildWorkspaceShareUrl,
  WORKSPACE_POINTER_STORAGE_KEY,
} from '../shared/workspacePointer'
import type { WorkspacePointer } from '../shared/workspacePointer'

// 与 workspacePointer.ts 内 WorkspaceBrowserHost 一致的测试 mock 接口。
interface TestBrowserHost {
  location: Pick<Location, 'href'>
  history: Pick<History, 'replaceState'>
  localStorage: Pick<Storage, 'getItem' | 'setItem'>
}

// ---------------------------------------------------------------------------
// 轻量 host mock，不依赖真实浏览器 API
// ---------------------------------------------------------------------------

interface MockStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function makeMockHost(overrides?: {
  storage?: Record<string, string>
  href?: string
}): TestBrowserHost {
  const storage: Record<string, string> = overrides?.storage ?? {}
  const mockStorage: MockStorage = {
    getItem(key: string) {
      return storage[key] ?? null
    },
    setItem(key: string, value: string) {
      storage[key] = value
    },
  }

  return {
    location: { href: overrides?.href ?? 'https://geo.example.com/' },
    history: {
      replaceState(_data: unknown, _title: string, url?: string | URL | null) {
        // 仅跟踪最后一次 replace，不做真实导航
        ;(this as Record<string, unknown>).lastUrl = url
      },
    } as Pick<History, 'replaceState'>,
    localStorage: mockStorage as Pick<Storage, 'getItem' | 'setItem'>,
  }
}

// ---------------------------------------------------------------------------
// normalizeWorkspacePointer
// ---------------------------------------------------------------------------

describe('normalizeWorkspacePointer', () => {
  it('把空对象收敛为全空指针', () => {
    expect(normalizeWorkspacePointer({})).toEqual({})
  })

  it('保留有效 activeThreadId 和 activeRunId', () => {
    expect(
      normalizeWorkspacePointer({ activeThreadId: 'th-1', activeRunId: 'run-1' }),
    ).toEqual({ activeThreadId: 'th-1', activeRunId: 'run-1' })
  })

  it('丢弃空白字段', () => {
    expect(
      normalizeWorkspacePointer({ activeThreadId: '', activeRunId: 'run-1' }),
    ).toEqual({ activeRunId: 'run-1' })
  })
})

// ---------------------------------------------------------------------------
// readWorkspacePointer
// ---------------------------------------------------------------------------

describe('readWorkspacePointer', () => {
  it('localStorage 为空时返回空指针', () => {
    const host = makeMockHost({ storage: {} })
    expect(readWorkspacePointer(host)).toEqual({})
  })

  it('读取合法指针', () => {
    const host = makeMockHost({
      storage: {
        [WORKSPACE_POINTER_STORAGE_KEY]: JSON.stringify({
          activeThreadId: 'th-1',
          activeRunId: 'run-1',
        }),
      },
    })
    expect(readWorkspacePointer(host)).toEqual({
      activeThreadId: 'th-1',
      activeRunId: 'run-1',
    })
  })

  it('畸形 JSON 返回空指针', () => {
    const host = makeMockHost({
      storage: { [WORKSPACE_POINTER_STORAGE_KEY]: 'not-json{' },
    })
    expect(readWorkspacePointer(host)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// rememberWorkspacePointer
// ---------------------------------------------------------------------------

describe('rememberWorkspacePointer', () => {
  it('写入 activeThreadId/activeRunId 作为 UI 选中提示', () => {
    const storage: Record<string, string> = {}
    const host = makeMockHost({ storage })
    rememberWorkspacePointer({ activeThreadId: 'th-1', activeRunId: 'run-1' }, host)

    const raw = storage[WORKSPACE_POINTER_STORAGE_KEY]
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as WorkspacePointer
    expect(parsed.activeThreadId).toBe('th-1')
    expect(parsed.activeRunId).toBe('run-1')
  })

  it('syncCleanWorkspaceUrl 不写入 sessionId', () => {
    // syncCleanWorkspaceUrl 只写 activeThreadId/activeRunId 作为 UI 提示；
    // sessionId 通过服务器端默认工作台会话解析，不进入 localStorage。
    const storage: Record<string, string> = {}
    const host = makeMockHost({
      storage,
      href: 'https://geo.example.com/',
    })
    syncCleanWorkspaceUrl('server-session', 'run-9', 'th-5', host)

    const raw = storage[WORKSPACE_POINTER_STORAGE_KEY]
    const parsed = JSON.parse(raw!) as WorkspacePointer
    expect('sessionId' in parsed).toBe(false)
    expect(parsed.activeThreadId).toBe('th-5')
    expect(parsed.activeRunId).toBe('run-9')
  })
})

// ---------------------------------------------------------------------------
// buildWorkspaceShareUrl
// ---------------------------------------------------------------------------

describe('buildWorkspaceShareUrl', () => {
  const base = 'https://geo.example.com'

  it('仅 session 时只编码 session 参数', () => {
    const url = buildWorkspaceShareUrl(base, 'sess-1')
    expect(url).toContain('?session=sess-1')
    expect(url).not.toContain('thread=')
    expect(url).not.toContain('run=')
  })

  it('编码 session/thread/run 全部参数', () => {
    const url = buildWorkspaceShareUrl(base, 'sess-1', 'run-1', 'th-1')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('session')).toBe('sess-1')
    expect(parsed.searchParams.get('run')).toBe('run-1')
    expect(parsed.searchParams.get('thread')).toBe('th-1')
  })

  it('无参数时返回干净的 base URL', () => {
    const url = buildWorkspaceShareUrl(base)
    const parsed = new URL(url)
    expect([...parsed.searchParams.keys()]).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// syncCleanWorkspaceUrl
// ---------------------------------------------------------------------------

describe('syncCleanWorkspaceUrl', () => {
  it('清除地址栏参数并写回 UI 选中提示', () => {
    const storage: Record<string, string> = {}
    const host = makeMockHost({
      storage,
      href: 'https://geo.example.com/?session=abc&thread=xyz',
    })
    syncCleanWorkspaceUrl('sess-1', 'run-1', 'th-1', host)

    // 验证 localStorage 写入了 thread/run 提示，不含 sessionId。
    const raw = storage[WORKSPACE_POINTER_STORAGE_KEY]
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as WorkspacePointer
    expect('sessionId' in parsed).toBe(false)
    expect(parsed.activeThreadId).toBe('th-1')
    expect(parsed.activeRunId).toBe('run-1')
  })
})

// ---------------------------------------------------------------------------
// session 归属断言 — localStorage 不影响会话选择
// ---------------------------------------------------------------------------

describe('session 归属策略', () => {
  it('localStorage 中的 sessionId 会被丢弃', () => {
    const storage: Record<string, string> = {
      [WORKSPACE_POINTER_STORAGE_KEY]: JSON.stringify({
        sessionId: 'old-browser-local-session',
        activeThreadId: 'th-old',
      }),
    }
    const host = makeMockHost({ storage })
    const pointer = readWorkspacePointer(host)

    expect('sessionId' in pointer).toBe(false)
    expect(pointer.activeThreadId).toBe('th-old')
  })
})
