// 气象工具 → Python sidecar HTTP 代理
import type { ToolDef } from '../../tools.js'
import { makeId } from '../../utils/ids.js'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8012'

async function proxyToWorker(endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${WORKER_URL}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Worker error: ${res.status}`)
  return res.json() as Promise<Record<string, unknown>>
}

export const weatherInspectTool: ToolDef = {
  name: 'inspect_weather_dataset', label: '查看气象数据集',
  description: '检查 NetCDF/GRIB 数据集的结构（变量、维度、时间范围）',
  group: '气象', toolKind: 'registry', tags: ['weather', 'read'],
  isReadOnly: true, isDestructive: false, isConcurrencySafe: true,

  jsonSchema: {
    type: 'object',
    properties: { datasetId: { type: 'string', description: '数据集 ID' } },
    required: ['datasetId'],
  },

  async handler(args, _runtime) {
    const result = await proxyToWorker('/weather/datasets/inspect', { datasetId: args.datasetId })
    return {
      message: `数据集已检查: ${JSON.stringify(result)}`,
      payload: result, warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'weather_worker',
    }
  },
}
