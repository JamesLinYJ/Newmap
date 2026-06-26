// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话条目文案格式化
//
//   文件:       entryFormat.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export function formatTaskStatus(status: string) {
  if (status === 'completed' || status === 'done') return '完成'
  if (status === 'running' || status === 'in_progress') return '进行中'
  if (status === 'failed') return '失败'
  if (status === 'blocked') return '受阻'
  if (status === 'cancelled') return '已取消'
  return '待处理'
}
