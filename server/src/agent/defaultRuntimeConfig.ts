import type { AgentRuntimeConfig } from '../schemas/types.js'

export function defaultRuntimeConfig(): AgentRuntimeConfig {
  return {
    loopTraceLimit: 80,
    maxTurns: 50,
    supervisor: {
      name: 'geo_agent_supervisor',
      systemPrompt: '',
      approvalInterruptTools: ['import_managed_layer', 'export_collection', 'create_weather_report'],
      permissionRules: [],
    },
    subAgents: [
      {
        agentId: 'spatial_analyst',
        name: '空间分析助手',
        role: 'spatial_analyst',
        summary: '负责地理空间分析和图层查询',
        systemPrompt: '你是一个空间分析专家，可以使用 GIS 工具分析地理数据。',
        tools: ['geocode_place', 'query_layer', 'spatial_analysis', 'create_chart'],
      },
    ],
    ui: { transcriptMaxEntries: 40, showInternalReasoningLabels: true, eventGroupingWindowMs: 1500 },
    catalog: { allowEmptyCatalog: true, adminEnabled: true },
    planning: { maxPlanRepairRounds: 2, allowTextOnlyDelivery: true, externalSourcePriority: ['catalog', 'external_poi', 'geosearch'] },
    context: {
      memoryFilePaths: ['/AGENTS.md', '/THREAD_CONTEXT.md'],
      historyRunLimit: 4, eventWindow: 24, toolCallWindow: 8,
      artifactWindow: 6, warningWindow: 6, promptMaxChars: 12000,
      contextEntryWindow: 18, memoryFileCharLimit: 4000,
      memoryEnabled: true, memoryBaseDir: '.geoagent/memory',
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
