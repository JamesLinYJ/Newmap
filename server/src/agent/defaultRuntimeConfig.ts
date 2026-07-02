import type { AgentRuntimeConfig, RuntimeSandboxConfig } from '../schemas/types.js'

interface DefaultRuntimeConfigOptions {
  sandbox?: Partial<RuntimeSandboxConfig>
}

const DEFAULT_SANDBOX_CONFIG: RuntimeSandboxConfig = {
  backend: 'docker',
  dockerImage: 'node:22-bookworm-slim',
}

export function defaultRuntimeConfig(options: DefaultRuntimeConfigOptions = {}): AgentRuntimeConfig {
  const sandbox: RuntimeSandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...options.sandbox,
  }
  return {
    loopTraceLimit: 80,
    maxTurns: 50,
    sandbox,
    supervisor: {
      name: 'geo_agent_supervisor',
      systemPrompt: '',
      approvalInterruptTools: ['exit_plan_mode', 'write_file', 'edit_file', 'import_managed_layer', 'export_collection', 'meteorological_report'],
      permissionRules: [],
    },
    subAgents: [
      {
        agentId: 'spatial_analyst',
        name: '空间分析助手',
        role: 'spatial_analyst',
        summary: '负责地理空间分析和图层查询',
        systemPrompt: `你是 GeoForge 的空间分析子 Agent，负责平台图层检索、真实要素查询和确定性 GIS 几何分析。

工作规则：
- 需要行政边界、区县范围或区域统计时，先用 list_layers 检索平台已有图层，再用 query_layer 读取真实要素。
- 不要使用 geocode_place 的 bbox、手写坐标或临时矩形伪造行政区划。
- 下游工具接受 valueRef 时传 refId，不要复制 GeoJSON。
- 工具失败、缺少图层或数据不匹配时，如实说明原因，不要返回 fallback 成功结论。`,
        model: null,
        tools: ['geocode_place', 'list_layers', 'query_layer', 'spatial_analysis', 'create_chart'],
      },
    ],
    ui: { transcriptMaxEntries: 40, showInternalReasoningLabels: true, eventGroupingWindowMs: 1500 },
    catalog: { allowEmptyCatalog: true, adminEnabled: true },
    planning: { maxPlanRepairRounds: 2, externalSourcePriority: ['catalog', 'external_poi', 'geosearch'] },
    context: {
      memoryFilePaths: [],
      historyRunLimit: 4, eventWindow: 24, toolCallWindow: 8,
      artifactWindow: 6, warningWindow: 6, promptMaxChars: 12000,
      contextEntryWindow: 18, memoryFileCharLimit: 4000,
      memoryEnabled: true, memoryBaseDir: process.env.GEOFORGE_MEMORY_BASE_DIR?.trim() || '~/.geoforge/projects',
      privateMemoryDir: null,
      teamMemoryDir: null,
      memoryEntrypointName: 'MEMORY.md',
      instructionEntrypointName: 'AGENTS.md',
      instructionMemoryEnabled: false,
      memoryMaxIndexLines: 200,
      memoryMaxIndexBytes: 25000,
      memoryMaxFiles: 200,
      memoryRelevantLimit: 5,
      memoryAutoExtractEnabled: true,
      memoryAutoDreamEnabled: true,
      memoryAutoDreamMinIntervalMs: 21_600_000,
      memoryAutoDreamMinFiles: 3,
      teamMemoryEnabled: true,
      sessionMemoryEnabled: true,
      sessionMemoryInitTokens: 10000,
      sessionMemoryUpdateTokens: 5000,
      sessionMemoryToolCallThreshold: 3,
      contextWindowTokens: 128000,
      warningRatio: 0.7,
      compactRatio: 0.8,
      hardLimitRatio: 0.9,
      preserveRecentTurns: 6,
      inlineToolResultMaxChars: 12000,
      memoryInitTokens: 12000,
      memoryUpdateTokens: 8000,
      summaryProvider: null,
      summaryModel: null,
    },
    geosearch: {
      provider: 'nominatim',
      enabled: true,
      baseUrl: 'https://nominatim.openstreetmap.org',
      userAgent: 'geo-agent-platform/0.1',
      timeoutMs: 2500,
      maxCandidates: 5,
    },
    externalPoi: {
      provider: 'overpass',
      enabled: true,
      baseUrl: 'https://overpass-api.de/api/interpreter',
      userAgent: 'geo-agent-platform/0.1',
      timeoutMs: 8000,
      maxResults: 200,
    },
    nowcast: {
      defaultCityName: '杭州市',
      forecastHorizonMinutes: 180,
      pointBufferMeters: 1000,
      districtLayerKey: null,
      districtNameField: null,
      rainLevelThresholds: { none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 },
      candidateLimit: 12,
    },
    hookConfigs: [],
  }
}
