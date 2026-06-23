// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 文件会话测试
//
//   文件:       fileAgentsSession.test.ts
//
//   日期:       2026年06月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// FileAgentsSession 是 SDK Session 与 canonical transcript 的边界。
// provider reasoning 只服务当前 run 的 UI 回放，不能成为后续模型历史。

import type { AgentInputItem } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { FileAgentsSession } from './fileAgentsSession.js'

describe('FileAgentsSession', () => {
  it('does not persist provider reasoning as replayable session history', async () => {
    const projected: AgentInputItem[][] = []
    const session = new FileAgentsSession('test-session', [], async items => {
      projected.push(items)
    })

    await session.addItems([
      { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '内部推理' }] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '可见回答' }],
      },
    ])

    expect(projected).toEqual([[
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '可见回答' }],
      },
    ]])
    expect(await session.getItems()).toEqual(projected[0])
  })
})
