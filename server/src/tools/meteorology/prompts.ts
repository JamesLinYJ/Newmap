// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象工具提示词
//
//   文件:       prompts.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 气象工具 prompt 是 Agent 可见的工具级契约。每个工具单独写明使用时机、
// 输入来源、禁止事项和下游 valueRef 流向，避免把业务链路藏进系统 prompt。

export const METEOROLOGY_TOOL_PROMPTS: Record<string, string> = {
  list_meteorological_files: `用于列出当前线程可用的气象相关上传文件，并生成数据集、雷达和边界文件集合引用。

使用规则：
- 气象数据、天气雷达组网产品、短时临近预报、风险区划图或面雨量表任务都应先调用本工具。
- 本工具只读取当前线程文件索引，不访问外部数据源。
- 返回的 meteorological_file_collection、radar_file_collection 和 meteorological_boundary_collection 是后续工具的规范入口。
- 没有找到所需文件时，说明缺少上传数据并请求用户补充，不要编造文件名或路径。`,

  inspect_radar_station_collection: `用于检查雷达 bz2 文件集合中的站点、产品和候选时次。

使用规则：
- 只接受 list_meteorological_files 返回的 radar_file_collection 引用。
- 在 render_radar_mosaic 前必须先调用本工具确认可用站点和目标时次。
- 不要把普通 NC 文件集合传给本工具。
- 后续工具应使用本工具返回的 radar_station_collection 和 radar_target_time valueRef。`,

  recommend_radar_mosaic_strategy: `用于根据业务目标推荐天气雷达组网拼图算法策略。

使用规则：
- 在用户没有明确指定拼图策略时使用。
- goal_mode 表达业务目标，time_strategy 表达时间匹配策略；不要用自然语言随意填入未枚举值。
- 本工具只推荐策略，不生成图像。
- render_radar_mosaic 应使用返回的 radar_mosaic_strategy valueRef。`,

  render_radar_mosaic: `用于基于已检查的雷达站集合、目标时次和策略生成天气雷达组网拼图。

使用规则：
- 必须使用 inspect_radar_station_collection 返回的 radar_station_collection 和 radar_target_time。
- strategy_ref 必须来自 recommend_radar_mosaic_strategy 或用户明确选择的等价策略引用。
- product、level_index、tolerance_sec、grid_res_km、min_dbz 应来自用户需求或前序检查结果；不确定时先澄清。
- 本工具生成 PNG/NPZ 结果，后续对比 NC 参考时传 radar_mosaic_result valueRef。`,

  compare_radar_mosaic_reference: `用于把天气雷达组网拼图结果与 NC 参考数据做差异对比。

使用规则：
- radar_mosaic_result_ref 必须来自 render_radar_mosaic。
- dataset_ref 必须是可作为参考的 meteorological_dataset 或 meteorological_file。
- target_time_ref 应与拼图目标时次一致。
- 不要用本工具生成新的拼图；它只做对比图和滑块素材。`,

  meteorological_inspect: `用于检查单个气象数据文件的变量、维度、时次、层级、单位和制图能力。

使用规则：
- 用户说“刚上传的 NetCDF/NC 文件/气象数据”时，优先直接调用本工具；未提供 dataset_ref 时会解析当前 thread 最新上传的数据集。
- dataset_ref 可以来自 list_meteorological_files 返回的 meteorological_file，也可以传 latest_upload 表示当前 thread 最新上传。
- 在渲染栅格、统计、阈值区域、等值线、风险区划图或报告前，必须先检查数据集。
- 后续工具应使用本工具返回的 meteorological_dataset、meteorological_variable、time_index、level_index 等 valueRef。
- 不要凭文件名猜测变量名、单位、时次或层级。`,

  interpret_meteorological_dataset: `用于保存经过结构化校验的模型气象解读。

使用规则：
- 只在用户需要气象解读文本、报告解读段落或后续 DOCX 报告时使用。
- dataset_ref 应来自 meteorological_inspect 的数据集引用。
- 本工具保存模型解读引用，不替代确定性统计、制图或阈值分析。
- 模型解读必须基于已检查元数据和工具结果；不要编造未计算的结论。`,

  meteorological_render: `用于把气象变量在指定时次、层级和范围内渲染为地图 PNG。

使用规则：
- dataset_ref 和 variable_ref 必须来自 meteorological_inspect。
- time_index_ref、level_index_ref、bbox_ref 有明确需求或前序引用时再传入。
- 不要用本工具做统计或区域排行；统计用 meteorological_stats，区域表用 generate_area_rainfall_table。
- 输出地图是 artifact；总结时只描述已知变量、时次、范围和渲染结果。`,

  meteorological_stats: `用于计算气象变量的确定性统计值。

使用规则：
- dataset_ref 和 variable_ref 必须来自 meteorological_inspect。
- 需要特定时次、层级或范围时，使用对应 valueRef，不要手写未验证索引。
- 统计结果可作为解释、阈值判断或图表输入；不要把统计工具当作地图渲染工具。
- 如果变量不可分析或数据缺失，应失败或请求澄清，不要返回伪统计。`,

  meteorological_threshold: `用于计算气象变量超过阈值的区域 GeoJSON。

使用规则：
- dataset_ref、variable_ref 和 threshold_ref 必须来自前序工具的 valueRef。
- operator 必须表达明确比较关系，例如大于、 小于或大于等于对应的实现值。
- 用于阈值区域提取，不用于行政区聚合风险图；行政区风险图使用 render_rainfall_risk_map。
- 返回 GeoJSON valueRef 后，后续导出或建图层应传 ref，不要复制几何。`,

  meteorological_contour: `用于生成气象变量等值线 GeoJSON。

使用规则：
- dataset_ref 和 variable_ref 必须来自 meteorological_inspect。
- levels_ref 应来自明确的等值线层级配置；没有层级需求时先澄清或使用业务默认前说明。
- 本工具生成等值线几何，不生成栅格 PNG；栅格图使用 meteorological_render。
- 不要把等值线当作行政边界或风险等级区划。`,

  meteorological_report: `用于使用显式模型解读引用生成 DOCX 气象报告。

使用规则：
- dataset_ref 必须来自已检查数据集，interpretation_ref 必须来自 interpret_meteorological_dataset。
- 不能用元数据摘要或手写长文本替代 interpretation_ref。
- 这是报告生成动作，应按审批敏感工具处理。
- 报告事实必须来自数据集检查、统计、渲染和模型解读引用，不要补写未验证结论。`,

  define_rainfall_risk_thresholds: `用于保存短时强降水风险区划图使用的阈值和调色板。

使用规则：
- 在 render_rainfall_risk_map 前调用，生成 rainfall_risk_thresholds valueRef。
- 阈值必须符合用户标准、业务标准或平台默认标准；不要临时发明无法解释的等级。
- 本工具只定义阈值，不读取数据、不做制图。
- 后续风险区划图必须传 thresholds_ref，而不是复制阈值 JSON。`,

  render_rainfall_risk_map: `用于使用单个 NC 数据集、变量、行政边界和阈值生成短时强降水风险区划图。

使用规则：
- dataset_ref 必须来自 meteorological_inspect 的 meteorological_dataset，不能传 nowcast_sequence。
- variable_ref 必须来自同一次或匹配数据集检查返回的 meteorological_variable。
- boundary_ref 必须来自 query_layer、上传边界或已存在边界 valueRef；不要用 geocode_place 的 bbox 造边界。
- thresholds_ref 必须来自 define_rainfall_risk_thresholds。
- 面雨量排行表不是本工具职责；需要排行或 Excel/PNG 表格时用 generate_area_rainfall_table。`,

  generate_area_rainfall_table: `用于基于 NC 文件集合或短时临近预报序列生成区域累计面雨量排行 Excel 和 PNG 表格。

使用规则：
- file_collection_ref 可以是 meteorological_file_collection 或 nowcast_sequence，表示时段累加面雨量。
- boundary_ref 必须是真实边界引用，优先来自 query_layer 或上传边界文件。
- top_n、label_field 和 style 应来自用户要求或业务默认；不要猜测行政区名称字段，必要时先检查或澄清。
- 本工具产出排行表，不等同于风险区划图。`,

  create_nowcast_sequence: `用于从当前线程气象文件集合创建短时临近预报序列引用。

使用规则：
- 仅用于短时临近预报问答、连续时次趋势分析和区域累计面雨量排行表。
- 不要把 nowcast_sequence 作为 render_rainfall_risk_map 的 dataset_ref。
- file_collection_ref 应来自 list_meteorological_files。
- variable_ref 只有用户或检查结果明确变量时才传入；不明确时先 inspect_nowcast_sequence 或澄清。`,

  inspect_nowcast_sequence: `用于检查短时临近预报序列中每个时次的数据集状态。

使用规则：
- sequence_ref 必须来自 create_nowcast_sequence。
- 在分析连续时次趋势、选择代表时次或定位缺失数据前使用。
- 本工具只检查序列，不回答天气问题、不生成地图。
- 后续分析必须继续传 nowcast_sequence 或本工具返回的相关 valueRef。`,

  prepare_hangzhou_nowcast_scope: `用于根据杭州短时临近预报问题准备区划或地点范围。

使用规则：
- question 必须是用户的短时临近预报问题或其忠实改写。
- 区划问题应传真实杭州区县边界 feature_collection/layer/nowcast_area；地点问题可传 place_candidate 或 nowcast_coordinate。
- district_name_field 不明确时，优先根据边界属性判断；仍不明确时请求澄清。
- 不要用地理编码 bbox 代替杭州区县边界。`,

  meteorological_precipitation_nowcast: `用于按时次和杭州区划或地点范围计算短时临近预报降水事实。

使用规则：
- sequence_ref 必须来自 create_nowcast_sequence。
- variable_ref 应来自数据集检查或序列检查中的降水变量引用。
- scope_ref 必须来自 prepare_hangzhou_nowcast_scope。
- 本工具产出确定性分析事实；不要在调用前后编造趋势、峰值、区域排行或结论。`,

  answer_nowcast_question: `用于根据短时临近预报分析事实回答用户问题，并生成代表时次地图。

使用规则：
- nowcast_analysis_ref 必须来自 meteorological_precipitation_nowcast。
- question 必须保留用户原始问题的核心意图。
- 本工具是短时临近预报问答的最终交付边界；调用后不要再自行追加标题、表格、emoji、数据源说明或改写预报事实。
- 如果分析事实不足以回答问题，应失败或请求澄清，不要编造天气预报。`,

  generate_nowcast_forecast_text: `用于保存基于短时临近预报分析事实生成并校验的模型文本。

使用规则：
- nowcast_analysis_ref 必须来自 meteorological_precipitation_nowcast。
- 本工具用于需要可复用 forecast_text_ref 的工作流，不替代 answer_nowcast_question 的最终问答交付。
- 文本必须严格基于分析事实，不得增加未计算的降水等级、影响区域或时间段。
- 后续报告或展示应传 forecast_text_ref，而不是复制长文本。`,

  render_nowcast_raster: `用于把短时临近预报候选时次渲染为地图 PNG。

使用规则：
- nowcast_map_candidate_ref 必须来自 answer_nowcast_question 或相关短临分析流程。
- 本工具只渲染候选时次地图，不选择预报结论。
- 不要把本工具用于普通 NC 单时次栅格渲染；普通数据集用 meteorological_render。
- 输出 artifact 后，回复只描述已渲染的时次、变量和范围。`,
}

export function meteorologyToolPrompt(name: string): string {
  const prompt = METEOROLOGY_TOOL_PROMPTS[name]
  if (!prompt) throw new Error(`气象工具 "${name}" 缺少 prompt`)
  return prompt
}
