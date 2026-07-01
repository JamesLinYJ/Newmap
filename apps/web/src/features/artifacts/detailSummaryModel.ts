// +-------------------------------------------------------------------------
//
//   地理智能平台 - 结果摘要事实模型
//
//   文件:       detailSummaryModel.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 结果摘要只展示可追溯事实。
//
// 前端不能根据要素数量临时编造“指数、增长率、覆盖面积”等业务指标。
// 这里把摘要事实集中成模型函数，让组件只负责渲染，也让测试能锁住边界。

export interface DetailSummaryFact {
  label: string
  value: string
}

interface DetailSummaryInput {
  runStatus?: string
  artifactCount: number
  resultFeatureCount: number
  activeReferenceLayerCount: number
  totalReferenceLayerCount: number
}

export function buildDetailSummaryFacts({
  runStatus,
  artifactCount,
  resultFeatureCount,
  activeReferenceLayerCount,
  totalReferenceLayerCount,
}: DetailSummaryInput): DetailSummaryFact[] {
  return [
    { label: '运行状态', value: formatCurrentRunStatus(runStatus) },
    { label: '结果产物', value: `${artifactCount} 个` },
    { label: '结果对象', value: resultFeatureCount ? `${resultFeatureCount} 个` : artifactCount ? '无要素表' : '暂无' },
    { label: '参考图层', value: `${activeReferenceLayerCount}/${totalReferenceLayerCount} 已启用` },
  ]
}

export function formatCurrentRunStatus(status?: string) {
  if (!status) {
    return '等待输入'
  }
  if (status === 'completed') {
    return '已完成'
  }
  if (status === 'waiting_approval') {
    return '待审批'
  }
  if (status === 'failed') {
    return '失败'
  }
  if (status === 'clarification_needed') {
    return '待澄清'
  }
  if (status === 'running') {
    return '执行中'
  }
  return '排队中'
}
