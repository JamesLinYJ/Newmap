// +-------------------------------------------------------------------------
//
//   地理智能平台 - 单次运行工具并发安全闸门测试
//
//   文件:       runToolConcurrencyGate.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { RunToolConcurrencyGate, toolExecutionLane, withToolAuthorizationLease } from './runToolConcurrencyGate.js'

describe('RunToolConcurrencyGate', () => {
  it('allows explicitly safe read-only calls to overlap', async () => {
    const gate = new RunToolConcurrencyGate()
    let active = 0
    let maxActive = 0
    const execute = () => gate.run('shared', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active -= 1
    })

    await Promise.all([execute(), execute()])

    expect(maxActive).toBe(2)
  })

  it('serializes ordinary, write, approval, and MCP-style exclusive calls', async () => {
    const gate = new RunToolConcurrencyGate()
    let active = 0
    let maxActive = 0
    const execute = () => gate.run('exclusive', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
    })

    await Promise.all([execute(), execute(), execute()])

    expect(maxActive).toBe(1)
  })

  it('revalidates authorization after a queued tool acquires its execution lease', async () => {
    const gate = new RunToolConcurrencyGate()
    let authorized = true
    let checks = 0
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => {
      void withToolAuthorizationLease(async () => {
        checks += 1
        if (!authorized) throw new Error('authorization_revoked')
      }, () => gate.run('exclusive', async () => {
        resolve()
        await new Promise<void>(release => { releaseFirst = release })
      }))
    })
    await firstStarted

    const second = withToolAuthorizationLease(async () => {
      checks += 1
      if (!authorized) throw new Error('authorization_revoked')
    }, () => gate.run('shared', async () => 'should-not-run'))

    authorized = false
    releaseFirst()

    await expect(second).rejects.toThrow('authorization_revoked')
    expect(checks).toBe(2)
  })

  it('requires every safety property before assigning the shared lane', () => {
    const safe = {
      parallelSafe: true,
      isReadOnly: true,
      isDestructive: false,
      requiresApproval: false,
    }
    expect(toolExecutionLane(safe, false)).toBe('shared')
    expect(toolExecutionLane({ ...safe, parallelSafe: undefined }, false)).toBe('shared')
    expect(toolExecutionLane({ ...safe, parallelSafe: false }, false)).toBe('exclusive')
    expect(toolExecutionLane({ ...safe, isReadOnly: false }, false)).toBe('exclusive')
    expect(toolExecutionLane({ ...safe, isDestructive: true }, false)).toBe('exclusive')
    expect(toolExecutionLane({ ...safe, requiresApproval: true }, false)).toBe('exclusive')
    expect(toolExecutionLane(safe, true)).toBe('exclusive')
  })
})
