// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象工具 Provider 适配器
//
//   文件:       weatherTools.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getEnv } from '../../framework/env.js'
import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { RuntimeFileStore } from '../../store/fileStore.js'
import { makeId } from '../../utils/ids.js'

const DATASET_SUFFIXES = ['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5']
const NETCDF_SUFFIXES = ['.nc', '.nc4']
const RADAR_SUFFIXES = ['.bz2']
const BOUNDARY_SUFFIXES = ['.zip', '.shp', '.geojson', '.json']
const WEATHER_SUFFIXES = [...DATASET_SUFFIXES, ...RADAR_SUFFIXES, ...BOUNDARY_SUFFIXES]
const HANGZHOU_DISTRICTS = ['上城区', '拱墅区', '西湖区', '滨江区', '萧山区', '余杭区', '富阳区', '临安区', '钱塘区', '临平区', '桐庐县', '淳安县', '建德市']
const HANGZHOU_BOUNDARY_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/330100_full.json'

export const weatherTools: ToolDef[] = [
  tool('list_meteorological_files', '列出气象文件', '列出当前线程可用的通用气象文件', {}, listMeteorologicalFiles),
  tool('inspect_radar_station_collection', '检查雷达站文件集', '检查雷达 bz2 文件的站点和候选时次', {
    radar_collection_ref: refParameter('雷达文件集合引用', ['radar_file_collection']),
  }, inspectRadarStationCollection, ['radar_collection_ref']),
  tool('recommend_radar_mosaic_strategy', '推荐雷达拼图策略', '根据业务目标推荐雷达拼图算法策略', {
    goal_mode: selectParameter('业务目标', ['quicklook', 'quality', 'smooth']),
    time_strategy: selectParameter('时间策略', ['nearest', 'wide']),
  }, recommendRadarMosaicStrategy),
  tool('render_radar_mosaic', '生成雷达拼图', '根据站点集合、时次和策略生成雷达拼图 PNG/NPZ', {
    radar_collection_ref: refParameter('雷达文件集合引用', ['radar_station_collection']),
    target_time_ref: refParameter('目标时次引用', ['radar_target_time']),
    strategy_ref: refParameter('拼图策略引用', ['radar_mosaic_strategy']),
    product: selectParameter('雷达产品', ['reflectivity', 'velocity', 'spectrum_width']),
    level_index: numberParameter('层级索引'),
    tolerance_sec: numberParameter('时间容差秒'),
  }, renderRadarMosaic, ['radar_collection_ref', 'target_time_ref', 'strategy_ref']),
  tool('compare_radar_mosaic_reference', '对比雷达拼图与 NC 参考', '生成拼图结果与参考 NC 的差异对比图和滑块素材', {
    radar_mosaic_result_ref: refParameter('雷达拼图结果引用', ['radar_mosaic_result']),
    dataset_ref: refParameter('NC 参考数据引用', ['meteorological_dataset', 'meteorological_file']),
    target_time_ref: refParameter('目标时次引用', ['radar_target_time']),
    level_index: numberParameter('层级索引'),
  }, compareRadarMosaicReference, ['radar_mosaic_result_ref', 'dataset_ref', 'target_time_ref']),
  tool('inspect_meteorological_dataset', '检查气象数据集', '检查变量、维度、时间、层级和地图能力', {
    dataset_ref: refParameter('气象文件引用', ['meteorological_file']),
  }, inspectDataset, ['dataset_ref']),
  tool('interpret_meteorological_dataset', '解读气象数据集', '保存经过结构化校验的模型气象解读', {
    dataset_ref: refParameter('数据集引用'),
  }, interpretDataset, ['dataset_ref']),
  workerDatasetTool('render_meteorological_raster', '渲染气象栅格', '渲染气象变量为地图 PNG', 'png', {
    dataset_ref: refParameter('数据集引用'),
    variable_ref: refParameter('变量引用'),
    time_index_ref: refParameter('时间索引引用'),
    level_index_ref: refParameter('层级索引引用'),
    bbox_ref: refParameter('范围引用'),
  }, ['dataset_ref', 'variable_ref']),
  workerDatasetTool('meteorological_stats', '气象统计', '计算变量统计值', null, {
    dataset_ref: refParameter('数据集引用'),
    variable_ref: refParameter('变量引用'),
    time_index_ref: refParameter('时间索引引用'),
    level_index_ref: refParameter('层级索引引用'),
    bbox_ref: refParameter('范围引用'),
  }, ['dataset_ref', 'variable_ref']),
  workerDatasetTool('meteorological_threshold_area', '气象阈值区域', '计算超过阈值的区域', 'geojson', {
    dataset_ref: refParameter('数据集引用'),
    variable_ref: refParameter('变量引用'),
    threshold_ref: refParameter('阈值引用'),
    time_index_ref: refParameter('时间索引引用'),
    level_index_ref: refParameter('层级索引引用'),
    bbox_ref: refParameter('范围引用'),
    operator: textParameter('比较运算符'),
  }, ['dataset_ref', 'variable_ref', 'threshold_ref']),
  workerDatasetTool('meteorological_contours', '气象等值线', '生成气象变量等值线', 'geojson', {
    dataset_ref: refParameter('数据集引用'),
    variable_ref: refParameter('变量引用'),
    levels_ref: refParameter('等值线层级引用'),
    time_index_ref: refParameter('时间索引引用'),
    level_index_ref: refParameter('层级索引引用'),
    bbox_ref: refParameter('范围引用'),
  }, ['dataset_ref', 'variable_ref']),
  tool('generate_meteorological_report', '生成气象报告', '使用显式模型解读引用生成 DOCX 报告', {
    dataset_ref: refParameter('数据集引用'),
    interpretation_ref: refParameter('模型解读引用'),
  }, generateReport, ['dataset_ref', 'interpretation_ref']),
  tool('define_rainfall_risk_thresholds', '定义降雨风险阈值', '保存降雨风险区划图使用的阈值和调色板', {
    thresholds: jsonParameter('阈值调色板 JSON', { type: 'array', items: { type: 'object' } }),
  }, defineRainfallRiskThresholds),
  tool('render_rainfall_risk_map', '生成降雨风险区划图', '使用 NC、变量、边界和阈值生成风险/渐变/对比图', {
    dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
    variable_ref: refParameter('变量引用', ['meteorological_variable']),
    boundary_ref: refParameter('边界引用', ['meteorological_file', 'feature_collection', 'nowcast_area']),
    thresholds_ref: refParameter('阈值引用', ['rainfall_risk_thresholds']),
    map_mode: selectParameter('图件模式', ['regional', 'gradient', 'compare']),
    aggregation: selectParameter('区划聚合', ['mean', 'max', 'sum']),
    label_field: textParameter('区划名称字段'),
    title: textParameter('图名'),
  }, renderRainfallRiskMap, ['dataset_ref', 'variable_ref', 'boundary_ref', 'thresholds_ref']),
  tool('generate_area_rainfall_table', '生成面雨量表格', '生成短临面雨量排行 Excel 和 PNG 表格', {
    file_collection_ref: refParameter('NC 文件集合或短临序列引用', ['meteorological_file_collection', 'nowcast_sequence']),
    boundary_ref: refParameter('边界文件引用', ['meteorological_file', 'feature_collection', 'nowcast_area']),
    top_n: numberParameter('展示前 N 个区域'),
    label_field: textParameter('区划名称字段'),
    style: jsonParameter('表格样式 JSON', { type: 'object' }),
  }, generateAreaRainfallTable, ['file_collection_ref', 'boundary_ref']),
  tool('create_nowcast_sequence', '创建短临序列', '从当前线程气象文件集合创建短临序列引用', {
    file_collection_ref: refParameter('文件集合引用'),
    variable_ref: refParameter('变量引用'),
  }, createNowcastSequence, ['file_collection_ref']),
  tool('inspect_nowcast_sequence', '检查短临序列', '检查短临序列每个时次的数据集', {
    sequence_ref: refParameter('短临序列引用'),
  }, inspectNowcastSequence, ['sequence_ref']),
  tool('prepare_hangzhou_nowcast_scope', '准备杭州短临范围', '根据问题准备杭州区县边界或地点坐标引用', {
    question: textParameter('短临问题'),
  }, prepareHangzhouNowcastScope, ['question']),
  tool('analyze_nowcast_precipitation', '分析短临降水', '按时次和杭州区划或地点范围计算降水统计事实', {
    sequence_ref: refParameter('短临序列引用'),
    variable_ref: refParameter('变量引用'),
    scope_ref: refParameter('杭州区划或地点范围引用'),
  }, analyzeNowcast, ['sequence_ref']),
  tool('answer_nowcast_question', '回答短临问题', '根据短临分析事实回答明确问题并生成代表时次地图', {
    nowcast_analysis_ref: refParameter('短临分析引用'),
    question: textParameter('问题'),
  }, answerNowcast, ['nowcast_analysis_ref', 'question']),
  tool('generate_nowcast_forecast_text', '生成短临预报文本', '保存基于短临分析事实生成并校验的模型文本', {
    nowcast_analysis_ref: refParameter('短临分析引用'),
  }, generateNowcastText, ['nowcast_analysis_ref']),
  tool('render_nowcast_raster', '渲染短临栅格', '渲染短临候选时次为地图 PNG', {
    nowcast_map_candidate_ref: refParameter('短临地图候选引用'),
  }, renderNowcastRaster, ['nowcast_map_candidate_ref']),
]

function tool(
  name: string,
  label: string,
  description: string,
  properties: Record<string, unknown>,
  handler: ToolDef['handler'],
  required: string[] = [],
): ToolDef {
  const miniApp = miniAppMetadata(name)
  return {
    name, label, description, group: '气象', tags: ['meteorology'],
    isReadOnly: name !== 'generate_meteorological_report',
    isDestructive: false,
    jsonSchema: { type: 'object', properties, required, ...(miniApp ? { 'x-mini-app': miniApp } : {}) },
    handler,
  }
}

function miniAppMetadata(name: string): Record<string, string> | null {
  if ([
    'inspect_radar_station_collection',
    'recommend_radar_mosaic_strategy',
    'render_radar_mosaic',
    'compare_radar_mosaic_reference',
  ].includes(name)) return { type: 'radar_mosaic_console' }
  if (['define_rainfall_risk_thresholds', 'render_rainfall_risk_map'].includes(name)) return { type: 'rainfall_risk_map_console' }
  if (name === 'generate_area_rainfall_table') return { type: 'area_rainfall_table_console' }
  return null
}

function workerDatasetTool(
  name: string,
  label: string,
  description: string,
  artifactType: 'png' | 'geojson' | null,
  properties: Record<string, unknown>,
  required = ['dataset_ref'],
): ToolDef {
  return tool(name, label, description, properties, async (args, ctx) => {
    const file = datasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset']))
    const workerArgs: Record<string, unknown> = {
      file_relative_path: file.relativePath,
      variable: optionalRefValue(ctx, args, 'variable_ref', 'name'),
      time_index: optionalRefValue(ctx, args, 'time_index_ref'),
      level_index: optionalRefValue(ctx, args, 'level_index_ref'),
      bbox: optionalRefValue(ctx, args, 'bbox_ref'),
      threshold: optionalRefValue(ctx, args, 'threshold_ref'),
      levels: optionalRefValue(ctx, args, 'levels_ref'),
      operator: typeof args.operator === 'string' ? args.operator : undefined,
    }
    let artifact = null
    if (artifactType === 'png') {
      artifact = artifactTarget(ctx, 'png', `${file.name} 栅格图`)
      workerArgs.output_relative_path = artifact.relativePath
    }
    const worker = await callWorker(name, workerArgs)
    if (artifactType === 'png' && artifact) {
      mergeArtifactMetadata(artifact, worker.payload)
    }
    if (artifactType === 'geojson') {
      artifact = artifactTarget(ctx, 'geojson', `${file.name} ${label}`)
      await writeJsonArtifact(artifact.relativePath, worker.payload)
    }
    const refs = resultRefs(name, label, worker.payload)
    return result(name, worker.message, worker.payload, refs, artifact ? [artifact] : [])
  }, required)
}

async function listMeteorologicalFiles(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.threadId) throw new Error('列出气象文件需要当前 thread')
  // 开发期旧数据可能存在同名重传；按已排序列表保留最新条目，避免重复时次进入序列。
  const entries = (await new RuntimeFileStore(getEnv().RUNTIME_ROOT).list(ctx.threadId))
    .filter(entry => WEATHER_SUFFIXES.some(suffix => entry.name.toLowerCase().endsWith(suffix)))
    .filter((entry, index, all) => all.findIndex(candidate => candidate.name === entry.name) === index)
  const fileRefs: ValueRef[] = entries.map(entry => ({
    refId: makeId('ref'),
    kind: 'meteorological_file',
    label: entry.name,
    value: { fileId: entry.id, name: entry.name, relativePath: entry.relativePath },
    metadata: { threadId: entry.threadId, sizeBytes: entry.sizeBytes, inputKind: inputKind(entry.name) },
  }))
  const datasetFiles = fileRefs.filter(ref => ref.metadata?.inputKind === 'dataset').map(ref => refObject(ref.value))
  const radarFiles = fileRefs.filter(ref => ref.metadata?.inputKind === 'radar').map(ref => refObject(ref.value))
  const boundaryFiles = fileRefs.filter(ref => ref.metadata?.inputKind === 'boundary').map(ref => refObject(ref.value))
  const collection: ValueRef = {
    refId: makeId('ref'),
    kind: 'meteorological_file_collection',
    label: `${datasetFiles.length} 个气象数据文件`,
    value: { files: datasetFiles },
  }
  const radarCollection: ValueRef | null = radarFiles.length ? {
    refId: makeId('ref'),
    kind: 'radar_file_collection',
    label: `${radarFiles.length} 个雷达 bz2 文件`,
    value: { files: radarFiles },
  } : null
  const boundaryCollection: ValueRef | null = boundaryFiles.length ? {
    refId: makeId('ref'),
    kind: 'meteorological_boundary_collection',
    label: `${boundaryFiles.length} 个边界文件`,
    value: { files: boundaryFiles },
  } : null
  return result('list_meteorological_files', `找到 ${entries.length} 个气象相关文件`, {
    files: entries,
    counts: { dataset: datasetFiles.length, radar: radarFiles.length, boundary: boundaryFiles.length },
  }, [
    ...fileRefs,
    collection,
    ...(radarCollection ? [radarCollection] : []),
    ...(boundaryCollection ? [boundaryCollection] : []),
  ])
}

async function inspectRadarStationCollection(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'radar_collection_ref', ['radar_file_collection']).value)
  const files = collectionFiles(collection, 'radar_collection_ref')
  const worker = await callWorker('inspect_radar_station_collection', { files })
  const refs: ValueRef[] = [{
    refId: makeId('ref'),
    kind: 'radar_station_collection',
    label: '雷达站文件集',
    value: { files, inspection: worker.payload },
    metadata: { sourceCollectionRef: args.radar_collection_ref },
  }]
  const candidateTimes = Array.isArray(worker.payload.candidateTimes) ? worker.payload.candidateTimes.filter(isRecord) : []
  for (const item of candidateTimes) {
    const timestamp = typeof item.timestamp === 'string' ? item.timestamp : ''
    if (!timestamp) continue
    refs.push({
      refId: makeId('ref'),
      kind: 'radar_target_time',
      label: `${timestamp} 雷达候选时次`,
      value: timestamp,
      metadata: { fileCount: item.fileCount },
    })
  }
  return result('inspect_radar_station_collection', worker.message, worker.payload, refs)
}

async function recommendRadarMosaicStrategy(args: Record<string, unknown>): Promise<ToolResult> {
  const worker = await callWorker('recommend_radar_mosaic_strategy', {
    goal_mode: typeof args.goal_mode === 'string' ? args.goal_mode : 'quicklook',
    time_strategy: typeof args.time_strategy === 'string' ? args.time_strategy : 'nearest',
  })
  const strategy = typeof worker.payload.strategy === 'string' ? worker.payload.strategy : ''
  if (!strategy) throw new Error('雷达策略推荐未返回 strategy')
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'radar_mosaic_strategy',
    label: `雷达拼图策略：${strategy}`,
    value: worker.payload,
  }
  return result('recommend_radar_mosaic_strategy', worker.message, worker.payload, [ref])
}

async function renderRadarMosaic(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'radar_collection_ref', ['radar_station_collection']).value)
  const files = collectionFiles(collection, 'radar_collection_ref')
  const targetTime = String(requiredRefKind(ctx, args, 'target_time_ref', ['radar_target_time']).value)
  const strategySource = refObject(requiredRefKind(ctx, args, 'strategy_ref', ['radar_mosaic_strategy']).value)
  const strategy = typeof strategySource.strategy === 'string' ? strategySource.strategy : ''
  if (!strategy) throw new Error('strategy_ref 不包含雷达拼图策略')
  const png = artifactTarget(ctx, 'png', `${targetTime} 雷达拼图`)
  const npz = artifactTarget(ctx, 'npz', `${targetTime} 雷达拼图数据`)
  const worker = await callWorker('render_radar_mosaic', {
    files,
    target_time: targetTime,
    strategy,
    product: typeof args.product === 'string' ? args.product : 'reflectivity',
    level_index: typeof args.level_index === 'number' ? args.level_index : 0,
    tolerance_sec: typeof args.tolerance_sec === 'number' ? args.tolerance_sec : 300,
    output_png_relative_path: png.relativePath,
    output_npz_relative_path: npz.relativePath,
  })
  mergeArtifactMetadata(png, { ...worker.payload, previewRole: 'radar_mosaic' })
  mergeArtifactMetadata(npz, { ...worker.payload, dataRole: 'radar_mosaic_npz' })
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'radar_mosaic_result',
    label: `${targetTime} 雷达拼图结果`,
    value: {
      ...worker.payload,
      targetTime,
      pngArtifactId: png.artifactId,
      npzArtifactId: npz.artifactId,
      npzRelativePath: npz.relativePath,
    },
  }
  return result('render_radar_mosaic', worker.message, worker.payload, [ref], [png, npz], {
    thirdPartySource: 'radar_mosaic_agent',
    inputRefs: { radarCollectionRef: args.radar_collection_ref, targetTimeRef: args.target_time_ref, strategyRef: args.strategy_ref },
  })
}

async function compareRadarMosaicReference(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const mosaic = refObject(requiredRefKind(ctx, args, 'radar_mosaic_result_ref', ['radar_mosaic_result']).value)
  const npzRelativePath = typeof mosaic.npzRelativePath === 'string' ? mosaic.npzRelativePath : ''
  if (!npzRelativePath) throw new Error('radar_mosaic_result_ref 缺少 NPZ 文件路径')
  const reference = datasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset', 'meteorological_file']))
  assertSuffix(reference.name, NETCDF_SUFFIXES, 'NC 参考数据')
  const targetTime = String(requiredRefKind(ctx, args, 'target_time_ref', ['radar_target_time']).value)
  const comparison = artifactTarget(ctx, 'png', `${targetTime} 雷达拼图对比`)
  const referencePng = artifactTarget(ctx, 'png', `${targetTime} NC 参考图`)
  const worker = await callWorker('compare_radar_mosaic_reference', {
    mosaic_npz_relative_path: npzRelativePath,
    reference_files: [{ name: reference.name, relativePath: reference.relativePath }],
    target_time: targetTime,
    level_index: typeof args.level_index === 'number' ? args.level_index : 0,
    output_png_relative_path: comparison.relativePath,
    output_reference_png_relative_path: referencePng.relativePath,
  })
  mergeArtifactMetadata(comparison, {
    ...worker.payload,
    previewRole: 'radar_reference_comparison',
    baseImageArtifactId: referencePng.artifactId,
    overlayImageArtifactId: comparison.artifactId,
  })
  mergeArtifactMetadata(referencePng, {
    ...worker.payload,
    previewRole: 'radar_reference_image',
    baseImageArtifactId: referencePng.artifactId,
    overlayImageArtifactId: comparison.artifactId,
  })
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'radar_mosaic_comparison',
    label: `${targetTime} 雷达拼图对比统计`,
    value: {
      ...worker.payload,
      comparisonArtifactId: comparison.artifactId,
      referenceArtifactId: referencePng.artifactId,
    },
  }
  return result('compare_radar_mosaic_reference', worker.message, worker.payload, [ref], [comparison, referencePng], {
    thirdPartySource: 'radar_mosaic_agent',
    inputRefs: { mosaicRef: args.radar_mosaic_result_ref, datasetRef: args.dataset_ref },
  })
}

async function inspectDataset(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const file = datasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_file']))
  const worker = await callWorker('inspect_meteorological_dataset', { file_relative_path: file.relativePath })
  const variables = Array.isArray(worker.payload.variables) ? worker.payload.variables.filter(isRecord) : []
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: 'meteorological_dataset', label: file.name,
    value: { ...file, metadata: worker.payload },
  }]
  for (const variable of variables) {
    refs.push({
      refId: makeId('ref'), kind: 'meteorological_variable',
      label: `${file.name} / ${String(variable.name ?? '')}`,
      value: { name: String(variable.name ?? ''), datasetRelativePath: file.relativePath, metadata: variable },
    })
  }
  if (Array.isArray(worker.payload.bounds)) {
    refs.push({ refId: makeId('ref'), kind: 'bbox', label: `${file.name} 数据范围`, value: worker.payload.bounds })
  }
  const times = Array.isArray(worker.payload.times) ? worker.payload.times : []
  times.forEach((time, index) => {
    refs.push({ refId: makeId('ref'), kind: 'meteorological_time_index', label: `${file.name} / ${String(time)}`, value: index })
  })
  const levels = Array.isArray(worker.payload.levels) ? worker.payload.levels : []
  levels.forEach((level, index) => {
    refs.push({ refId: makeId('ref'), kind: 'meteorological_level_index', label: `${file.name} / ${String(level)}`, value: index })
  })
  return result('inspect_meteorological_dataset', worker.message, worker.payload, refs)
}

async function interpretDataset(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const datasetRef = requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset'])
  const dataset = datasetValue(ctx, datasetRef)
  const source = refObject(datasetRef.value)
  const structured = await ctx.invokeStructuredModel(
    `仅根据以下气象数据 metadata 生成 JSON 对象，必须包含 reportText、summary、keyFindings、riskSignals、methodNotes、recommendedNextSteps：\n${JSON.stringify(source.metadata ?? {})}`,
  )
  const text = typeof structured.reportText === 'string' ? structured.reportText.trim() : ''
  if (text.length < 20) throw new Error('模型气象解读正文过短')
  const ref: ValueRef = {
    refId: makeId('ref'), kind: 'meteorological_interpretation', label: `${dataset.name} 模型解读`,
    value: { datasetRelativePath: dataset.relativePath, text, structured },
  }
  return result('interpret_meteorological_dataset', '模型气象解读已通过校验', structured, [ref])
}

async function generateReport(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const dataset = datasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset']))
  assertSuffix(dataset.name, NETCDF_SUFFIXES, '降雨风险图数据')
  const interpretation = refObject(requiredRefKind(ctx, args, 'interpretation_ref', ['meteorological_interpretation']).value)
  const text = typeof interpretation.text === 'string' ? interpretation.text : ''
  if (!text) throw new Error('interpretation_ref 不包含模型解读正文')
  const artifact = artifactTarget(ctx, 'docx', `${dataset.name} 气象分析报告`)
  const worker = await callWorker('generate_meteorological_report', {
    file_relative_path: dataset.relativePath,
    interpretation_text: text,
    output_relative_path: artifact.relativePath,
  })
  return result('generate_meteorological_report', worker.message, worker.payload, [], [artifact])
}

async function defineRainfallRiskThresholds(args: Record<string, unknown>): Promise<ToolResult> {
  const thresholds = normalizeThresholds(args.thresholds)
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'rainfall_risk_thresholds',
    label: '降雨风险阈值调色板',
    value: { thresholds },
  }
  return result('define_rainfall_risk_thresholds', `已定义 ${thresholds.length} 个降雨风险等级`, { thresholds }, [ref])
}

async function renderRainfallRiskMap(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const dataset = datasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset']))
  const variable = refObject(requiredRefKind(ctx, args, 'variable_ref', ['meteorological_variable']).value)
  const variableName = typeof variable.name === 'string' ? variable.name : ''
  if (!variableName) throw new Error('variable_ref 不包含变量名')
  const thresholds = refObject(requiredRefKind(ctx, args, 'thresholds_ref', ['rainfall_risk_thresholds']).value)
  const boundaryRelativePath = await boundaryInputRelativePath(ctx, args, 'boundary_ref')
  const artifact = artifactTarget(ctx, 'png', `${dataset.name} 降雨风险区划图`)
  const worker = await callWorker('render_rainfall_risk_map', {
    file_relative_path: dataset.relativePath,
    variable: variableName,
    boundary_relative_path: boundaryRelativePath,
    thresholds: thresholds.thresholds,
    map_mode: typeof args.map_mode === 'string' ? args.map_mode : 'regional',
    aggregation: typeof args.aggregation === 'string' ? args.aggregation : 'mean',
    label_field: typeof args.label_field === 'string' ? args.label_field : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    output_relative_path: artifact.relativePath,
  })
  mergeArtifactMetadata(artifact, {
    ...worker.payload,
    previewRole: 'rainfall_risk_map',
    miniApp: { type: 'rainfall_risk_map_console' },
  })
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'rainfall_risk_map_result',
    label: `${dataset.name} 风险区划图结果`,
    value: { ...worker.payload, artifactId: artifact.artifactId },
  }
  return result('render_rainfall_risk_map', worker.message, worker.payload, [ref], [artifact], {
    thirdPartySource: 'rainfall_risk_map',
    inputRefs: { datasetRef: args.dataset_ref, variableRef: args.variable_ref, boundaryRef: args.boundary_ref, thresholdsRef: args.thresholds_ref },
  })
}

async function generateAreaRainfallTable(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const collectionRef = requiredRefKind(ctx, args, 'file_collection_ref', ['meteorological_file_collection', 'nowcast_sequence'])
  const files = collectionRef.kind === 'nowcast_sequence'
    ? sequenceFiles(refObject(collectionRef.value))
    : collectionFiles(refObject(collectionRef.value), 'file_collection_ref')
  if (!files.length) throw new Error('面雨量表格需要至少一个 NC 文件')
  assertFileObjectsSuffix(files, NETCDF_SUFFIXES, '面雨量表格')
  const boundaryRelativePath = await boundaryInputRelativePath(ctx, args, 'boundary_ref')
  const xlsx = artifactTarget(ctx, 'xlsx', '面雨量排行表格')
  const png = artifactTarget(ctx, 'png', '面雨量排行预览')
  const worker = await callWorker('generate_area_rainfall_table', {
    files,
    boundary_relative_path: boundaryRelativePath,
    top_n: typeof args.top_n === 'number' ? args.top_n : 10,
    label_field: typeof args.label_field === 'string' ? args.label_field : undefined,
    style: isRecord(args.style) ? args.style : undefined,
    output_xlsx_relative_path: xlsx.relativePath,
    output_png_relative_path: png.relativePath,
  })
  mergeArtifactMetadata(xlsx, { ...worker.payload, downloadRole: 'area_rainfall_table_xlsx' })
  mergeArtifactMetadata(png, {
    ...worker.payload,
    previewRole: 'area_rainfall_table_png',
    miniApp: { type: 'area_rainfall_table_console' },
  })
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'area_rainfall_table_result',
    label: '面雨量表格结果',
    value: { ...worker.payload, xlsxArtifactId: xlsx.artifactId, pngArtifactId: png.artifactId },
  }
  return result('generate_area_rainfall_table', worker.message, worker.payload, [ref], [xlsx, png], {
    thirdPartySource: 'short_term_forecast',
    inputRefs: { fileCollectionRef: args.file_collection_ref, boundaryRef: args.boundary_ref },
  })
}

async function createNowcastSequence(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'file_collection_ref', ['meteorological_file_collection']).value)
  if (!Array.isArray(collection.files) || collection.files.length < 2) throw new Error('短临序列至少需要两个气象文件')
  const variable = optionalRefValue(ctx, args, 'variable_ref', 'name')
  const worker = await callWorker('create_nowcast_sequence', { files: collection.files, variable })
  const ref: ValueRef = {
    refId: makeId('ref'), kind: 'nowcast_sequence', label: '短临气象序列',
    value: worker.payload,
  }
  return result('create_nowcast_sequence', worker.message, worker.payload, [ref])
}

async function inspectNowcastSequence(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const sequence = refObject(requiredRefKind(ctx, args, 'sequence_ref', ['nowcast_sequence']).value)
  const worker = await callWorker('inspect_nowcast_sequence', { sequence })
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_sequence_inspection', label: '短临序列检查', value: worker.payload }
  return result('inspect_nowcast_sequence', worker.message, worker.payload, [ref])
}

async function prepareHangzhouNowcastScope(args: Record<string, unknown>): Promise<ToolResult> {
  const question = requiredText(args, 'question')
  const requestedDistrict = HANGZHOU_DISTRICTS.find(name => question.includes(name))
  const locationHint = stripNowcastQuestion(question)
  const isCitywide = !requestedDistrict && (!locationHint || ['杭州', '杭州市', '全市', '杭州全市'].includes(locationHint))

  if (requestedDistrict || isCitywide) {
    const response = await fetch(HANGZHOU_BOUNDARY_URL, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`杭州区划边界获取失败：HTTP ${response.status}`)
    const boundary: unknown = await response.json()
    if (!isRecord(boundary) || boundary.type !== 'FeatureCollection' || !Array.isArray(boundary.features)) {
      throw new Error('杭州区划边界返回了无效 GeoJSON')
    }
    const features = requestedDistrict
      ? boundary.features.filter(feature => isRecord(feature) && isRecord(feature.properties) && feature.properties.name === requestedDistrict)
      : boundary.features
    if (!features.length) throw new Error(`杭州区划边界中未找到 ${requestedDistrict}`)
    const collection = { type: 'FeatureCollection', features }
    const ref: ValueRef = {
      refId: makeId('ref'),
      kind: 'nowcast_area',
      label: requestedDistrict ?? '杭州市区县边界',
      value: collection,
      metadata: { source: HANGZHOU_BOUNDARY_URL, districtNameField: 'name' },
    }
    const boundaryRef: ValueRef = {
      refId: makeId('ref'),
      kind: 'feature_collection',
      label: requestedDistrict ? `${requestedDistrict}区划边界` : '杭州市区县边界',
      value: collection,
      metadata: { source: HANGZHOU_BOUNDARY_URL, districtNameField: 'name', purpose: 'nowcast_scope' },
    }
    return result('prepare_hangzhou_nowcast_scope', `已准备 ${features.length} 个杭州区划范围`, {
      scopeType: 'area', label: ref.label, featureCount: features.length,
    }, [ref, boundaryRef])
  }

  const location = extractLocationQuery(question)
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=jsonv2&limit=1&accept-language=zh-CN`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'geo-agent-platform/0.1' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`杭州地点解析失败：HTTP ${response.status}`)
  const candidates: unknown = await response.json()
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : null
  const lat = candidate ? Number(candidate.lat) : Number.NaN
  const lng = candidate ? Number(candidate.lon) : Number.NaN
  if (!candidate || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`未能在杭州解析地点：${location}`)
  const label = typeof candidate.display_name === 'string' ? candidate.display_name.split(',')[0] : location
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'nowcast_coordinate',
    label,
    value: { lat, lng, label },
    metadata: { source: 'nominatim' },
  }
  return result('prepare_hangzhou_nowcast_scope', `已准备杭州地点范围：${label}`, {
    scopeType: 'coordinate', label,
  }, [ref])
}

async function analyzeNowcast(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const sequence = refObject(requiredRefKind(ctx, args, 'sequence_ref', ['nowcast_sequence']).value)
  const scope = optionalScope(ctx, args)
  const worker = await callWorker('analyze_nowcast_precipitation', {
    sequence,
    variable: optionalRefValue(ctx, args, 'variable_ref', 'name') ?? sequence.variable,
    ...scope,
  })
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: 'nowcast_analysis', label: '短临降水分析', value: worker.payload,
  }]
  const candidates = Array.isArray(worker.payload.mapCandidates) ? worker.payload.mapCandidates.filter(isRecord) : []
  for (const item of candidates) {
    refs.push({
      refId: makeId('ref'), kind: 'nowcast_map_candidate', label: String(item.label ?? item.filename ?? '短临地图候选'),
      value: item,
    })
  }
  return result('analyze_nowcast_precipitation', worker.message, worker.payload, refs)
}

function extractLocationQuery(question: string): string {
  const location = stripNowcastQuestion(question)
  if (!location) throw new Error('地点短临问题中没有可解析的杭州地点')
  return location.includes('杭州') ? location : `杭州市${location}`
}

function stripNowcastQuestion(question: string): string {
  return question
    .replace(/[？?。]/gu, '')
    .replace(/未来三小时|未来3小时|接下来|短临|降水|降雨|天气怎么样|天气如何|会不会下雨|会下雨吗|下雨吗/gu, '')
    .trim()
}

function optionalScope(ctx: ToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const refId = args.scope_ref
  if (typeof refId !== 'string' || !refId.trim()) return {}
  const ref = ctx.resolveValueRef(refId)
  if (ref.kind === 'nowcast_area' || ref.kind === 'feature_collection') {
    return {
      area: ref.value,
      district_name_field: typeof ref.metadata?.districtNameField === 'string' ? ref.metadata.districtNameField : undefined,
    }
  }
  if (ref.kind === 'nowcast_coordinate' || ref.kind === 'place_candidate') {
    const value = refObject(ref.value)
    return {
      coordinate: {
        lat: Number(value.lat),
        lng: Number(value.lng ?? value.lon),
        label: typeof value.label === 'string' ? value.label : ref.label,
      },
      point_buffer_meters: 1000,
    }
  }
  if (ref.kind === 'bbox') return { bbox: ref.value }
  throw new Error(`scope_ref 必须引用杭州区划、地点坐标或 bbox，实际为 ${ref.kind}`)
}

async function answerNowcast(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const analysis = refObject(requiredRefKind(ctx, args, 'nowcast_analysis_ref', ['nowcast_analysis']).value)
  const worker = await callWorker('answer_nowcast_question', { analysis, question: requiredText(args, 'question') })
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_answer', label: '短临问题回答事实', value: worker.payload }
  const candidate = selectNowcastMapCandidate(analysis)
  const artifact = artifactTarget(ctx, 'png', `${String(candidate.label ?? '代表时次')} 短临降水`)
  const raster = await callWorker('render_nowcast_raster', {
    file_relative_path: requiredCandidateText(candidate, 'relativePath'),
    variable: requiredCandidateText(candidate, 'variable'),
    bbox: nowcastRenderBbox(analysis),
    output_relative_path: artifact.relativePath,
  })
  mergeArtifactMetadata(artifact, {
    ...raster.payload,
    nowcastCandidate: candidate,
    nowcastMapReason: candidate.reason ?? null,
    nowcastLeadMinutes: candidate.leadMinutes ?? null,
  })
  return result('answer_nowcast_question', worker.message, {
    ...worker.payload,
    map: {
      artifactId: artifact.artifactId,
      label: artifact.name,
      reason: candidate.reason ?? null,
      leadMinutes: candidate.leadMinutes ?? null,
    },
  }, [ref], [artifact])
}

async function generateNowcastText(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const analysis = requiredRefKind(ctx, args, 'nowcast_analysis_ref', ['nowcast_analysis']).value
  const facts = await callWorker('generate_nowcast_forecast_text', { analysis })
  const draft = typeof facts.payload.answer === 'string' ? facts.payload.answer.trim() : ''
  if (!draft) throw new Error('短临领域服务未生成可用预报事实文本')
  const structured = await ctx.invokeStructuredModel(
    `返回 JSON 对象 {"forecastText":"..."}；forecastText 必须逐字等于 draft.answer，不得补充、删除或改写任何事实：\n${JSON.stringify({ facts: analysis, draft: facts.payload })}`,
  )
  const text = typeof structured.forecastText === 'string' ? structured.forecastText.trim() : ''
  if (text !== draft) throw new Error('模型短临预报文本偏离确定性事实草稿')
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_forecast_text', label: '短临预报文本', value: { text, structured, facts: facts.payload } }
  return result('generate_nowcast_forecast_text', '模型短临预报文本已通过校验', structured, [ref])
}

async function renderNowcastRaster(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const candidate = refObject(requiredRefKind(ctx, args, 'nowcast_map_candidate_ref', ['nowcast_map_candidate']).value)
  const artifact = artifactTarget(ctx, 'png', '短临降水栅格')
  const worker = await callWorker('render_nowcast_raster', {
    file_relative_path: candidate.relativePath,
    variable: candidate.variable,
    output_relative_path: artifact.relativePath,
  })
  mergeArtifactMetadata(artifact, worker.payload)
  return result('render_nowcast_raster', worker.message, worker.payload, resultRefs('render_nowcast_raster', '短临栅格', worker.payload), [artifact])
}

async function callWorker(name: string, args: Record<string, unknown>) {
  const url = getEnv().WORKER_URL
  if (!url) throw new Error('WORKER_URL 未配置')
  const response = await fetch(`${url.replace(/\/$/u, '')}/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(workerErrorDetail(detail) || `Worker HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  if (!isRecord(body) || !isRecord(body.payload) || typeof body.message !== 'string') {
    throw new Error(`Worker 工具 "${name}" 返回无效 payload`)
  }
  return { message: body.message, payload: body.payload }
}

function workerErrorDetail(raw: string): string {
  if (!raw.trim()) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch {
    // 非 JSON 错误正文原样上浮，避免隐藏 Worker 的真实失败。
  }
  return raw.trim()
}

function result(
  name: string,
  message: string,
  payload: Record<string, unknown>,
  valueRefs: ValueRef[],
  artifacts: ReturnType<typeof artifactTarget>[] = [],
  provenance: Record<string, unknown> = {},
): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: `gis_weather.${name}`,
    valueRefs,
    artifacts,
    provenance: { backend: 'gis_weather', ...provenance },
  }
}

function resultRefs(name: string, label: string, payload: Record<string, unknown>): ValueRef[] {
  const refs: ValueRef[] = [{ refId: makeId('ref'), kind: `${name}_result`, label, value: payload }]
  if (name === 'meteorological_stats') {
    for (const key of ['min', 'mean', 'median', 'p50', 'p90', 'max']) {
      const value = payload[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      refs.push({ refId: makeId('ref'), kind: 'meteorological_threshold', label: `${label} / ${key}`, value, unit: typeof payload.unit === 'string' ? payload.unit : null })
    }
    const levels = ['min', 'p50', 'p90', 'max']
      .map(key => payload[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (levels.length >= 2) refs.push({ refId: makeId('ref'), kind: 'meteorological_contour_levels', label: `${label} / 等值线层级`, value: [...new Set(levels)] })
  }
  return refs
}

function requiredRef(ctx: ToolContext, args: Record<string, unknown>, key: string): ValueRef {
  const refId = args[key]
  if (typeof refId !== 'string' || !refId.trim()) throw new Error(`${key} 不能为空`)
  return ctx.resolveValueRef(refId)
}

function requiredRefKind(ctx: ToolContext, args: Record<string, unknown>, key: string, kinds: string[]): ValueRef {
  const ref = requiredRef(ctx, args, key)
  if (!kinds.includes(ref.kind)) throw new Error(`${key} 必须引用 ${kinds.join(' 或 ')}，实际为 ${ref.kind}`)
  return ref
}

function optionalRefValue(ctx: ToolContext, args: Record<string, unknown>, key: string, field?: string): unknown {
  const refId = args[key]
  if (typeof refId !== 'string' || !refId.trim()) return undefined
  const value = ctx.resolveValueRef(refId).value
  if (!field) return value
  const record = refObject(value)
  return record[field]
}

function datasetValue(ctx: ToolContext, ref: ValueRef): { name: string; relativePath: string } {
  const value = refObject(ref.value)
  const relativePath = typeof value.relativePath === 'string'
    ? value.relativePath
    : typeof value.datasetRelativePath === 'string' ? value.datasetRelativePath : ''
  if (!relativePath) throw new Error(`引用 "${ref.refId}" 不包含数据文件路径`)
  return { name: typeof value.name === 'string' ? value.name : ref.label, relativePath }
}

type WeatherArtifactExt = 'png' | 'geojson' | 'docx' | 'xlsx' | 'npz'

function artifactTarget(ctx: ToolContext, artifactType: WeatherArtifactExt, name: string) {
  const artifactId = makeId('artifact')
  const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.${artifactType}`)
  return {
    artifactId, artifactType: artifactKind(artifactType), name,
    uri: `/api/v1/results/${artifactId}/${artifactType === 'geojson' ? 'geojson' : 'file'}`,
    relativePath,
    metadata: { relativePath },
  }
}

function artifactKind(ext: WeatherArtifactExt): string {
  if (ext === 'png') return 'raster_png'
  return ext
}

function mergeArtifactMetadata(
  artifact: ReturnType<typeof artifactTarget>,
  payload: Record<string, unknown>,
): void {
  artifact.metadata = { ...payload, relativePath: artifact.relativePath }
}

async function writeJsonArtifact(relativePath: string, payload: Record<string, unknown>): Promise<void> {
  await writeRuntimeJson(relativePath, payload)
}

async function writeRuntimeJson(relativePath: string, payload: unknown): Promise<void> {
  const root = path.resolve(getEnv().RUNTIME_ROOT)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(payload), 'utf8')
}

function refParameter(title: string, kinds: string[] = []) {
  return {
    type: 'string',
    title,
    description: '必须使用当前 run 中已存在的 valueRef ID',
    'x-source': 'value_ref',
    ...(kinds.length ? { 'x-value-ref-kinds': kinds } : {}),
  }
}

function textParameter(title: string) {
  return { type: 'string', title, 'x-source': 'text' }
}

function numberParameter(title: string) {
  return { type: 'number', title, 'x-source': 'number' }
}

function selectParameter(title: string, values: string[]) {
  return { type: 'string', title, enum: values, 'x-source': 'text' }
}

function jsonParameter(title: string, schema: Record<string, unknown>) {
  return { ...schema, title, 'x-source': 'json' }
}

function inputKind(name: string): 'dataset' | 'radar' | 'boundary' {
  const lower = name.toLowerCase()
  if (RADAR_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'radar'
  if (BOUNDARY_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'boundary'
  return 'dataset'
}

function collectionFiles(collection: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const files = collection.files
  if (!Array.isArray(files) || !files.length || !files.every(isRecord)) {
    throw new Error(`${key} 不包含文件集合`)
  }
  return files
}

function sequenceFiles(sequence: Record<string, unknown>): Record<string, unknown>[] {
  const datasets = sequence.datasets
  if (!Array.isArray(datasets) || !datasets.length || !datasets.every(isRecord)) {
    throw new Error('nowcast_sequence 不包含 datasets')
  }
  return datasets.map((item, index) => {
    const relativePath = typeof item.relativePath === 'string' ? item.relativePath : ''
    if (!relativePath) throw new Error(`nowcast_sequence.datasets[${index}] 缺少 relativePath`)
    return {
      fileId: typeof item.datasetId === 'string' ? item.datasetId : `dataset_${index + 1}`,
      name: typeof item.filename === 'string' ? item.filename : path.posix.basename(relativePath),
      relativePath,
    }
  })
}

function assertSuffix(filename: string, suffixes: string[], label: string): void {
  const lower = filename.toLowerCase()
  if (!suffixes.some(suffix => lower.endsWith(suffix))) {
    throw new Error(`${label} 文件类型不受支持: ${filename}`)
  }
}

function assertFileObjectsSuffix(files: Record<string, unknown>[], suffixes: string[], label: string): void {
  for (const [index, file] of files.entries()) {
    const name = typeof file.name === 'string' ? file.name : typeof file.filename === 'string' ? file.filename : ''
    if (!name) throw new Error(`${label} 文件集合第 ${index + 1} 项缺少 name`)
    assertSuffix(name, suffixes, label)
  }
}

async function boundaryInputRelativePath(ctx: ToolContext, args: Record<string, unknown>, key: string): Promise<string> {
  const ref = requiredRefKind(ctx, args, key, ['meteorological_file', 'feature_collection', 'nowcast_area'])
  if (ref.kind === 'meteorological_file') {
    const file = datasetValue(ctx, ref)
    assertSuffix(file.name, BOUNDARY_SUFFIXES, '边界')
    return file.relativePath
  }
  const payload = ref.value
  if (!isRecord(payload) || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
    throw new Error(`${key} 必须是 FeatureCollection 或边界文件引用`)
  }
  const relativePath = path.posix.join('artifacts', ctx.runId, `${makeId('boundary')}.geojson`)
  await writeRuntimeJson(relativePath, payload)
  return relativePath
}

function normalizeThresholds(value: unknown): Array<{ label: string; min: number; max: number; color: string }> {
  const raw = value === undefined || value === null ? defaultRainfallThresholds() : value
  const parsed = typeof raw === 'string' ? parseJson(raw, 'thresholds') : raw
  const array = isRecord(parsed) && Array.isArray(parsed.thresholds) ? parsed.thresholds : parsed
  if (!Array.isArray(array)) throw new Error('thresholds 必须是数组或包含 thresholds 数组的对象')
  const thresholds = array.map((item, index) => {
    if (!isRecord(item)) throw new Error(`thresholds[${index}] 必须是对象`)
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const min = Number(item.min)
    const max = Number(item.max)
    const color = typeof item.color === 'string' ? item.color.trim() : ''
    if (!label || !Number.isFinite(min) || !Number.isFinite(max) || max <= min || !/^#[0-9a-f]{6}$/iu.test(color)) {
      throw new Error(`thresholds[${index}] 必须包含 label、递增 min/max 和 #RRGGBB color`)
    }
    return { label, min, max, color }
  }).sort((a, b) => a.min - b.min)
  if (!thresholds.length) throw new Error('thresholds 不能为空')
  return thresholds
}

function defaultRainfallThresholds() {
  return [
    { label: '无雨/小雨', min: 0, max: 1.5, color: '#f0f0f0' },
    { label: '短时大雨', min: 1.5, max: 3, color: '#a6d96a' },
    { label: '短时暴雨', min: 3, max: 5, color: '#1a9850' },
    { label: '短时大暴雨', min: 5, max: 8, color: '#fdae61' },
    { label: '短时大暴雨~特大暴雨', min: 8, max: 12, color: '#d73027' },
    { label: '短时特大暴雨', min: 12, max: 999, color: '#7a0177' },
  ]
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON`)
  }
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`)
  return value.trim()
}

function selectNowcastMapCandidate(analysis: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(analysis.mapCandidates) ? analysis.mapCandidates.filter(isRecord) : []
  if (!candidates.length) throw new Error('短临分析没有可渲染的地图候选时次')
  return candidates.find(candidate => candidate.reason === '降雨峰值时次') ?? candidates[0]
}

function requiredCandidateText(candidate: Record<string, unknown>, key: string): string {
  const value = candidate[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`短临地图候选缺少 ${key}`)
  return value.trim()
}

function nowcastRenderBbox(analysis: Record<string, unknown>): unknown {
  const scope = isRecord(analysis.scope) ? analysis.scope : null
  return scope && Array.isArray(scope.renderBbox) ? scope.renderBbox : undefined
}

function refObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('valueRef 的值必须是对象')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
