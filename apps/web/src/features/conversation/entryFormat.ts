export function formatTaskStatus(status: string) {
  if (status === 'pending') return '待处理'
  if (status === 'in_progress' || status === 'running') return '进行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'blocked') return '待确认'
  return status
}
