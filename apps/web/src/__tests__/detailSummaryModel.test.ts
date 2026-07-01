// +-------------------------------------------------------------------------
//
//   地理智能平台 - 结果摘要事实模型测试
//
//   文件:       detailSummaryModel.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { buildDetailSummaryFacts, formatCurrentRunStatus } from '../features/artifacts/detailSummaryModel'

describe('detail summary model', () => {
  it('uses auditable facts instead of synthetic dashboard metrics', () => {
    // 摘要卡只能展示运行、产物、对象和参考图层这些事实；不允许再引入伪指标。
    const facts = buildDetailSummaryFacts({
      runStatus: 'completed',
      artifactCount: 2,
      resultFeatureCount: 13,
      activeReferenceLayerCount: 1,
      totalReferenceLayerCount: 3,
    })

    expect(facts).toEqual([
      { label: '运行状态', value: '已完成' },
      { label: '结果产物', value: '2 个' },
      { label: '结果对象', value: '13 个' },
      { label: '参考图层', value: '1/3 已启用' },
    ])
    expect(facts.map(item => item.label)).not.toContain('活跃指数')
    expect(facts.map(item => item.label)).not.toContain('增长率')
  })

  it('distinguishes no results from non-feature file results', () => {
    expect(buildDetailSummaryFacts({
      artifactCount: 0,
      resultFeatureCount: 0,
      activeReferenceLayerCount: 0,
      totalReferenceLayerCount: 0,
    }).find(item => item.label === '结果对象')?.value).toBe('暂无')

    expect(buildDetailSummaryFacts({
      artifactCount: 1,
      resultFeatureCount: 0,
      activeReferenceLayerCount: 0,
      totalReferenceLayerCount: 0,
    }).find(item => item.label === '结果对象')?.value).toBe('无要素表')
  })

  it('formats run status in Chinese', () => {
    expect(formatCurrentRunStatus()).toBe('等待输入')
    expect(formatCurrentRunStatus('running')).toBe('执行中')
    expect(formatCurrentRunStatus('waiting_approval')).toBe('待审批')
    expect(formatCurrentRunStatus('clarification_needed')).toBe('待澄清')
    expect(formatCurrentRunStatus('failed')).toBe('失败')
  })
})
