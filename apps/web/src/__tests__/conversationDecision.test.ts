// +-------------------------------------------------------------------------
//
//   地理智能平台 - 用户决策投影测试
//
//   文件:       conversationDecision.test.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 用户决策面板只从 canonical DecisionRequest 派生。
// 测试覆盖服务端 pending 决策优先级；composer 执行方式选择不进入服务端决策流。

import { describe, expect, it } from 'vitest'
import type { DecisionRequest } from '@geo-agent-platform/shared-types'
import { pickPendingDecision } from '../features/conversation/useConversation'

describe('conversation decision projection', () => {
  it('优先显示 pending approval，其次才是 pending clarification', () => {
    const clarification = decision({ decisionId: 'clarification_1', kind: 'clarification' })
    const approval = decision({ decisionId: 'approval_1', kind: 'approval' })

    expect(pickPendingDecision([clarification, approval])?.decisionId).toBe('approval_1')
  })

  it('忽略已经 resolved 的决策', () => {
    const answered = decision({
      decisionId: 'clarification_done',
      kind: 'clarification',
      status: 'answered',
      resolvedAt: '2026-06-30T00:00:00.000Z',
    })
    const pending = decision({ decisionId: 'clarification_pending', kind: 'clarification' })

    expect(pickPendingDecision([answered, pending])?.decisionId).toBe('clarification_pending')
  })

  it('不把本地 execution_mode 当作待处理服务端决策', () => {
    const local = decision({ decisionId: 'execution_mode', kind: 'execution_mode' })

    expect(pickPendingDecision([local])).toBeNull()
  })
})

function decision(overrides: Partial<DecisionRequest>): DecisionRequest {
  return {
    decisionId: overrides.decisionId ?? 'decision_1',
    kind: overrides.kind ?? 'clarification',
    title: overrides.title ?? '需要确认',
    question: overrides.question ?? '请选择下一步。',
    description: overrides.description ?? '',
    options: overrides.options ?? [],
    allowFreeText: overrides.allowFreeText ?? false,
    status: overrides.status ?? 'pending',
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? '2026-06-30T00:00:00.000Z',
    resolvedAt: overrides.resolvedAt ?? null,
  }
}
