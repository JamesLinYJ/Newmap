# 地理智能平台 (NewMap) 全面审查报告

**日期**: 2026-05-27 | **分支**: main @ 1f46373 | **73 测试通过**

---

## 一、总览

| 维度 | 数据 |
|------|------|
| Python 源文件 | 41 个，~15,200 行 |
| TypeScript 源文件 | 12 个组件 + 3 hooks + api.ts + runTranscript.ts，~10,000 行 |
| Python 包 | 7 个 (agent-core, gis-common, gis-postgis, gis-weather, model-adapters, shared-types, tool-registry) |
| 前端 App | React 19 + Vite 8 + MapLibre GL 5 + Tailwind 4 |
| 数据库 | PostgreSQL + PostGIS (Docker) |
| 会话存储 | JSONL 文件 (按 thread 分区) |
| 测试 | 73 Python 通过 / 前端仅 2 个 |

---

## 二、架构评分

### 2.1 依赖图 (A 级)

```
shared-types        ── 叶子包，无依赖
gis-common          ── 叶子包，无依赖
model-adapters      ─→ shared-types
gis-postgis         ─→ gis-common, shared-types
gis-weather         ─→ 仅内部模块
tool-registry       ─→ gis-common, gis-weather, shared-types
agent-core          ─→ 以上全部
```

**无循环依赖**。依赖是有向无环图 (DAG)，这是良好的架构属性。

### 2.2 数据流 (B+ 级)

```
用户输入 → intent_parser → execution_plan → Agent SDK Runner
                                                    ↓
  ← final_response ← guardrail_validate ← tool_execution ←
                                                    ↓
                                            JSONL events + PostgreSQL artifacts
                                                    ↓
                                          SSE stream → 前端 transcript → UI
```

关键设计决策：
- **工具间数据传递**: `ToolValueRef` 黑板模式 (value_refs.py)，坐标/统计/bbox 通过 ref_id 传递
- **空间引用解析**: `_resolve_collection_ref` 统一处理集合别名、坐标 valueRef、图层 key
- **会话与运行分离**: runs/events 存 JSONL，artifacts 存 PostgreSQL

### 2.3 CamelModel 桥接 (A 级)

`shared_types/schemas.py` 中的 `CamelModel` 自动将 Python `snake_case` 序列化为前端 `camelCase`，消除手动转换层。

---

## 三、大文件清单 (按严重程度)

| 文件 | 行数 | 严重度 | 问题 |
|------|------|--------|------|
| **registry.py** | 2,309 | 高 | 内联 30+ Args 模型、20+ 工具 handler、与 weather_tools.py 的 Args 模型重复 |
| **DebugPage.tsx** | 2,323 | 高 | 10+ 内联子组件、30+ 辅助函数 |
| **App.tsx** | 2,070 | 高 | 30+ useState、40+ props 传递、单组件编排器 |
| **graph.py** | 2,029 | 中 | GeoAgentRuntime 混合编排/状态/事件/guardrail/JSON 解析 |
| **App.css** | 1,796 | 中 | 玻璃样式重复 3 次 |
| **service.py** (gis-weather) | 1,431 | 中 | 与 readers.py 大量重复 |
| **platform_store.py** | 1,262 | 中 | 40+ 方法单体 facade |
| **MapCanvas.tsx** | 1,253 | 中 | MapLibre 集成，自定义状态机 |
| **DetailPanel.tsx** | 1,138 | 中 | 8 种面板模式、50+ props |
| **runTranscript.ts** | 1,053 | 中 | 纯函数，可测试性高但无测试覆盖 |
| **postgis_catalog.py** | 845 | 低 | PostGIS SQL 映射 |
| **ChatPanel.tsx** | 850 | 低 | 时间线渲染 |

---

## 四、重复代码

### 4.1 gis-weather: service.py vs readers.py

| 重复内容 | service.py | readers.py |
|----------|-----------|-----------|
| GeoTIFF 检查 | `_inspect_raster` (第 587-650 行，~65 行) | `RasterMapReader.inspect` (第 211-246 行，~35 行) |
| NetCDF 变量检查 | `_inspect_xarray` (第 375-441 行，~65 行) | `XarrayScientificReader.inspect` (第 104-157 行，~53 行) |
| 网格切片 | `_read_xarray_grid` (第 444-491 行，~47 行) | `XarrayScientificReader.read_slice` (第 161-204 行，~43 行) |
| 孪生数据类 | `WeatherGrid` | `GridSlice` (基本相同的字段) |

**根因**: `WeatherDataService` 绕过 `WeatherReaderFacade` 直接实现读取逻辑。

### 4.2 tool-registry: Args 模型重复

以下模型在 `registry.py` 和 `weather_tools.py` 中**同时定义**：
- `InspectMeteorologicalDatasetArgs`
- `RenderMeteorologicalRasterArgs`
- `MeteorologicalStatsArgs`
- `MeteorologicalThresholdArgs`
- `MeteorologicalContoursArgs`
- `GenerateMeteorologicalReportArgs`

### 4.3 gis-postgis: HTTP 客户端重复

`poi_search.py` 和 `place_search.py` 中的 `_make_client`、`_request_with_retry`、故障转移 URL 模式几乎相同。

### 4.4 前端常量重复

| 常量 | 位置 1 | 位置 2 |
|------|--------|--------|
| `DEFAULT_BASEMAP` | App.tsx:2060 | MapCanvas.tsx:609 |
| `SAMPLES` | ChatPanel.tsx:71 | `SAMPLE_QUERIES` (App.tsx:131) |
| `DataReferenceSummary` | App.tsx:110 | ChatPanel.tsx:60 |

---

## 五、安全风险

### 5.1 API 密钥硬编码 (高危)

`.env` 文件中包含明文密钥：

```
OPENAI_API_KEY=sk-9bd1a3104054492a98861ae762c06970
GEMINI_API_KEY=AIzaSyDXfBHlyAReHS9Oh8zHbZ3L_fM85wf4PiA
TIANDITU_API_KEY=2e29f5db87614e6b7af22a033d1a8f55
```

`apps/api/.env` 中存在另一个不同的 DeepSeek 密钥。

**建议**: 立即从版本控制移除；轮换已暴露的密钥；使用 Docker secrets 或环境变量注入。

### 5.2 Docker 以 root 运行 (中危)

`api/Dockerfile` 和 `worker/Dockerfile` 均无 `USER` 指令。应切换到非 root 用户。

### 5.3 生产 Compose 无健康检查 (中危)

4 个服务 (api, worker, postgis, web) 均无 `healthcheck` 定义。无 CPU/内存限制。

### 5.4 数据库密码硬编码 (低危)

两个 compose 文件中 `geo_agent:geo_agent` 凭据硬编码。

---

## 六、测试覆盖

### 6.1 Python (73 通过, 1 跳过)

| 测试文件 | 覆盖范围 |
|----------|----------|
| test_nowcast_tools.py (3 测试) | 短临工具链：create→inspect→analyze→answer→render |
| test_nowcast_service.py | 短临领域服务 |
| test_meteorological_interpretation.py (5 测试) | LLM 气象解读 |
| test_weather_service.py | 天气数据服务 |
| test_weather_tool_registration.py | 工具注册契约 |
| test_weather_reader_abstraction.py | Reader 协议 |
| test_tool_value_refs.py | ValueRef 黑板系统 |
| test_tool_provider_contract.py | Provider 校验 |
| test_tool_descriptor_contract.py | 工具描述符契约 |
| test_spatial_service_boundaries.py | 空间分析边界 |
| test_agent_context_manager.py | 上下文管理器 |
| test_agent_session_log_store.py | JSONL 会话日志 |
| test_agent_sdk_boundaries.py | SDK 边界 |
| test_charting.py | 图表渲染 |
| test_vector_import.py | 矢量导入 |
| test_intent_parser.py | 意图解析 |
| test_layer_descriptor_contracts.py | 图层描述符 |
| test_sse_event_boundaries.py | SSE 事件边界 |

**缺失测试的模块**:
- `agent-core/graph.py` (2,029 行) — 无测试
- `model-adapters/` — 无测试
- `apps/api/` 路由 — 无测试
- `runTranscript.ts` (1,053 行) — 无测试

### 6.2 前端 (仅 2 个测试)

`apps/web/src/__tests__/api.test.ts` — 只测试了 `deriveApiBaseUrl` 函数。

**零覆盖**:
- 0 个组件测试 (ChatPanel, DetailPanel, MapCanvas, LayerPanel, DebugPage)
- 0 个 hook 测试 (useRunState, useLayerManager)
- 0 个 runTranscript 测试

---

## 七、前端状态管理

### 7.1 现状: Props Drilling

App.tsx 单组件管理所有状态 (30+ useState)，通过 props 层层传递：

```
App (30 useState)
├── ChatPanel (35+ props)
├── DetailPanel (40+ props → LayerPanel 18 props)
├── MapCanvas (13 props)
└── TopBar
```

无 Context API、无 Zustand、无 Redux。DetailPanel 接收 50+ 解构 props，其中 18 个透传给 LayerPanel。

### 7.2 建议

引入 3 个 Context 或使用 Zustand：
- `SessionContext` — session, layers, weatherDatasets, basemaps
- `RunContext` — run, events, artifacts, transcriptEntries
- `MapContext` — mapLayers, selectedArtifactId, mapLayerPreferences

---

## 八、设计系统一致性

| 文件 | 设计风格 | 颜色系统 |
|------|----------|----------|
| App.css (1,796 行) | Liquid Glass (毛玻璃) | CSS 变量 |
| LayerPanel.css (535 行) | 扁平 QGIS 风格 | 硬编码十六进制 (#fafafa, #d4d4d4, #4a90d9) |
| index.css (93 行) | Tailwind v4 基础 | Tailwind tokens |

三种不同的视觉语言在同一应用中并存。LayerPanel 应该迁移到 Tailwind 或与玻璃设计系统的颜色变量对齐。

---

## 九、亮点

1. **依赖图是 DAG** — 无循环导入，清晰的层级
2. **CamelModel 桥接** — Python snake_case ↔ JS camelCase 自动转换
3. **ToolValueRef 黑板模式** — 工具间数据传递的类型安全方案
4. **Provider 契约系统** — `tool-registry/providers.py` 支持外部工具注册
5. **流式 delta 合并** — `runTranscript.ts` 的 `message.delta`/`thinking.delta` 增量合并
6. **空间引用统一** — `_resolve_collection_ref` 一端处理三种引用形式
7. **SSE 重连** — `useRunState` 指数退避 (1.5s-30s, 最多 10 次)
8. **依赖版本** — 全部最新 (React 19.2, Vite 8, TypeScript 6, MapLibre 5)
9. **API 客户端** — 统一超时、中文错误消息、SSE 封装
10. **JSONL 会话存储** — 线程安全 (RLock)、分区、自描述模式
11. **短临流水线** — nowcast_tools.py + nowcast.py 完整分析/问答/渲染链路
12. **Nowcast 子智能体** — hangzhou_nowcast_analyst 配置完善，10 工具

---

## 十、改进优先级

| 优先级 | 任务 | 预估工时 |
|--------|------|----------|
| **P0** | 轮换 .env 中暴露的 API 密钥，从 git 移除 | 0.5h |
| **P0** | 为 runTranscript.ts 添加测试 (最高 ROI) | 4h |
| **P0** | 为 agent-core/graph.py 添加测试 | 8h |
| **P1** | 引入 Context/Zustand 消除 App.tsx props drilling | 8h |
| **P1** | 消除 gis-weather service.py ↔ readers.py 重复 | 6h |
| **P1** | 消除 registry.py ↔ weather_tools.py Args 模型重复 | 4h |
| **P1** | Docker 添加 USER 指令、健康检查 | 2h |
| **P2** | 拆分 registry.py (>500 行→多模块) | 8h |
| **P2** | 拆分 DebugPage.tsx (内联子组件→独立文件) | 6h |
| **P2** | LayerPanel.css 迁移到 Tailwind | 4h |
| **P2** | App.css 玻璃样式提取 CSS 变量 | 2h |
| **P3** | 提取 gis-postgis HTTP 客户端公共基类 | 3h |
| **P3** | 消除前端常量重复 (DEFAULT_BASEMAP, SAMPLES) | 1h |
| **P3** | 统一 FastAPI 异常处理模式 | 2h |
