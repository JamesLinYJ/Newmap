# +-------------------------------------------------------------------------
#
#   地理智能平台 - TypeScript ToolProvider Demo
#
#   文件:       README.md
#
#   日期:       2026年06月17日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# ToolProvider Demo

这个目录是新增平台工具的可复制模板。它不会默认进入生产工具列表，目的是给开发者展示一个完整 TypeScript Provider 应该如何声明 manifest、校验 schema、输出 `valueRef`、写入 artifact，并通过契约测试。

## 目录结构

```text
demo/tool-provider-demo/
  AGENTS.md
  README.md
  package.json
  tsconfig.json
  src/
    demoManifest.ts
    demoProvider.ts
    demoService.ts
    index.ts
  tests/
    provider.test.ts
```

## Demo 提供的工具

| 工具 | 作用 | 输出 |
| --- | --- | --- |
| `demo_collect_observation` | 接收一个观测点、数值和单位，生成结构化观测引用 | `demo_observation` valueRef |
| `demo_write_observation_report` | 消费观测引用，生成 JSON 报告 artifact | `json` artifact、`demo_report` valueRef |
| `demo_render_observation_badge` | 消费观测引用，调用 worker 生成 PNG 预览 | `raster_png` artifact |

后两个工具故意只接收 `observation_ref`，不让模型复制观测值。这是平台工具链的核心规范：工具派生值必须通过 `valueRef` 流转。

## Worker-backed 工具示例

需要调用 Python/外部科学计算 worker 时，Provider 仍然负责解析 valueRef、准备 artifact 目标和保存 provenance。worker 只接受 runtime 相对路径。`demo_render_observation_badge` 是一个完整示例：

```ts
const worker = await callWorker('demo_render_observation_badge', {
  observation: observationRef.value,
  output_relative_path: artifact.relativePath,
})
```

如果 `WORKER_URL` 未配置、worker `/health` 缺依赖、worker 返回非 2xx 或 payload 结构不合法，Provider 必须失败，并在 DebugPage 显示不可用原因。

## Mini-App Metadata 示例

小工具页面不要 iframe 原系统，也不要开新端口。把 UI 类型作为 schema metadata 暴露给前端，运行仍走统一 `tool:run`：

```json
{
  "x-mini-app": {
    "type": "demo_observation_badge_console"
  }
}
```

artifact metadata 可声明预览角色和下载角色：

```json
{
  "previewRole": "rainfall_risk_map",
  "downloadRole": "area_rainfall_table_xlsx",
  "baseImageArtifactId": "artifact_base",
  "overlayImageArtifactId": "artifact_overlay"
}
```

## 复制成真实工具

1. 复制目录到正式工具位置，例如：

```text
server/src/tools/my_domain/
```

2. 修改 Provider ID、名称、工具名和领域服务：

```ts
// demoProvider.ts
export const demoProvider: ToolProvider = {
  manifest,
  tools: () => [collectObservationTool, writeObservationReportTool],
}
```

3. 在 `server/src/framework/loader.ts` 的内置 provider map 中显式加入新 Provider。

4. 在 `.env` 或启动脚本中加入 allowlist：

```env
ENABLED_TOOL_PROVIDERS=weather,spatial,my_domain
```

5. 启动服务后进入主页面顶部“工具”，检查 Provider 状态、工具详情、参数 schema 和试运行入口。

## 运行 Demo 测试

在仓库根目录执行：

```bash
npx vitest run demo/tool-provider-demo/tests/provider.test.ts
```

或进入 demo 目录后执行：

```bash
npm install
npm test
```

正式工具合并前至少还要运行：

```bash
npm run test --workspace server
npm run lint:web
npm run build:web
```

## 接入检查

- manifest 与 runtime `ToolDef` 完全一致。
- `jsonSchema.type` 必须是 `object`。
- 参数必须有 `title`、`description` 和合适的 `x-source`。
- `value_ref` 参数必须声明 `x-value-ref-kinds`。
- handler 遇到未知 `valueRef`、坏参数、文件写入失败必须抛错。
- artifact 必须写入 runtime 根目录内真实文件。
- provenance 必须说明 provider、工具、输入引用和算法版本。
- 第三方源码快照应放在工具目录的 `source/original/`，运行包装放在旁路 adapter/service 中。
- 工具管理页能看到 Provider 元数据和风险标识。

更多规则见 `docs/tool-integration-standard.md`。
