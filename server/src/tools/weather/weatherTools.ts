// 气象工具 → Python sidecar HTTP 代理
import { getEnv } from '../../framework/env.js'
import type { ToolDef, ToolResult } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'

function proxy(name: string): ToolDef['handler'] {
  return async (args, _ctx) => {
    const workerUrl = getEnv().WORKER_URL
    if (!workerUrl) throw new Error('WORKER_URL 未配置，气象工具不可用')
    const res = await fetch(`${workerUrl}/tools/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }), signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`气象工具 ${name} 返回 ${res.status}`)
    return res.json() as Promise<ToolResult>
  }
}

function tool(name: string, label: string, desc: string, tags: string[], ro: boolean, dest: boolean): ToolDef {
  return { name, label, description: desc, group: '气象', tags, isReadOnly: ro, isDestructive: dest, jsonSchema: { type: 'object', properties: {} }, handler: proxy(name) }
}

export const meteorologicalInspect = tool('meteorological_inspect', '气象数据探查', '检查 NetCDF/GRIB/GeoTIFF/HDF5 数据集结构', ['meteorology', 'read'], true, false)
export const meteorologicalRender = tool('meteorological_render', '气象栅格渲染', '渲染气象栅格为 PNG 热力图', ['meteorology', 'render'], true, false)
export const meteorologicalStats = tool('meteorological_stats', '气象统计分析', '气象数据统计分析', ['meteorology', 'statistics'], true, false)
export const meteorologicalThreshold = tool('meteorological_threshold', '气象阈值分析', '气象要素阈值区域分析', ['meteorology', 'threshold'], true, false)
export const meteorologicalContour = tool('meteorological_contour', '气象等值线', '生成气象要素等值线', ['meteorology', 'contour'], true, false)
export const meteorologicalReport = tool('meteorological_report', '气象报告生成', '生成 DOCX 气象分析报告', ['meteorology', 'report'], false, false)
export const precipitationNowcast = tool('precipitation_nowcast', '降水短临预报', '雷达回波外推降水短临预报', ['meteorology', 'nowcast'], true, false)
