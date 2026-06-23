// +-------------------------------------------------------------------------
//
//   地理智能平台 - 第三方气象 Mini-App 模型
//
//   文件:       toolMiniAppModel.ts
//
//   日期:       2026年06月23日
//   作者:       Codex
// --------------------------------------------------------------------------

// Mini-app 类型由工具名确定；这里保持纯函数，React 组件只消费结果。

export type MiniAppKind = 'radar_mosaic_console' | 'rainfall_risk_map_console' | 'area_rainfall_table_console'

export function miniAppKindForTool(toolName?: string | null): MiniAppKind | null {
  if (!toolName) return null
  if ([
    'inspect_radar_station_collection',
    'recommend_radar_mosaic_strategy',
    'render_radar_mosaic',
    'compare_radar_mosaic_reference',
  ].includes(toolName)) return 'radar_mosaic_console'
  if (['define_rainfall_risk_thresholds', 'render_rainfall_risk_map'].includes(toolName)) return 'rainfall_risk_map_console'
  if (toolName === 'generate_area_rainfall_table') return 'area_rainfall_table_console'
  return null
}
