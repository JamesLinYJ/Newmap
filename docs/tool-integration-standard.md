# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具接入规范
#
#   文件:       tool-integration-standard.md
#
#   日期:       2026年06月23日
#   作者:       Codex
# --------------------------------------------------------------------------

# Tool Integration Standard

本文档规定 GeoForge 工具接入的公开契约、运行边界和测试要求。工具可以由不同团队开发，但进入平台后必须表现为同一套 `ToolProvider → valueRef → artifact → UI` 链路。

## 基本原则

- 新工具必须以显式 in-repo `ToolProvider` 暴露，并通过 `ENABLED_TOOL_PROVIDERS` allowlist 加载。
- `manifest` 与运行时 `ToolDef` 必须完全一致，暴露前通过 `validateToolDefinition()` 和 Provider 契约测试。
- 工具 handler 应该是薄适配层。业务算法放在领域包、service 或 worker adapter，不写在 Agent prompt 里。
- 未知 valueRef、坏参数、缺依赖、worker 错误、模型结构化失败必须直接失败，不返回伪成功文本。
- 工具派生出的变量、时次、阈值、bbox、统计值和文件路径必须通过 `valueRef` 传递；后续工具自己解析引用。

## 第三方工具接入

第三方源码必须先作为只读快照复制到每个工具目录的 `source/original/` 子目录，例如：

```text
packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/source/original/
```

不能为了接入平台去修改 `source/original/` 内原文件。可复用的纯算法文件可以复制到 `source/` 顶层作为运行快照，但平台运行时只能调用旁路 `adapter.py`。无法直接接入的 Flask 路由、bat 启动、本机目录浏览、浏览器截图、本地 session cache 或 key 输入页面，必须在旁路 adapter 中重写包装。

推荐结构：

```text
third_party/<tool_name>/
  source/original/ # 原始源码快照，只读，保留 UI、README、启动脚本等审计材料
  source/*.py      # 可选的纯算法运行快照，不承载 Flask/bat/session/cache
  adapter.py       # GeoForge 运行边界，只接 valueRef 解析后的 runtime 相对路径
  __init__.py
```

adapter 必须只接受 worker 已解析的 runtime 根目录内文件，不允许任意绝对路径，不允许扫描用户本机目录。

## 参数 Schema

每个参数必须提供：

- `type`
- `title`
- `description`
- `x-source`
- valueRef 参数必须声明 `x-value-ref-kinds`

示例：

```json
{
  "dataset_ref": {
    "type": "string",
    "title": "数据集引用",
    "description": "由 inspect_meteorological_dataset 返回的 meteorological_dataset valueRef。",
    "x-source": "value_ref",
    "x-value-ref-kinds": ["meteorological_dataset"]
  }
}
```

## ToolExecutionResult

工具结果必须包含：

- `message`
- `payload`
- `resultId`
- `source`
- `valueRefs`
- `artifacts`
- `provenance`

artifact 必须写入 runtime 根目录内真实文件，metadata 至少包含 `relativePath`。多文件工具应分别声明预览和下载 artifact，例如 PNG 预览、XLSX 下载、NPZ 数据。

artifact metadata 可以声明展示面，前端只按该契约决定结果进入地图、mini-app 还是下载区：

```json
{
  "displaySurfaces": ["mini_app", "download"],
  "primarySurface": "mini_app"
}
```

支持的展示面只有 `map`、`mini_app`、`download`。第三方小工具的轴图、对比图和表格预览应使用 `mini_app`；可叠加地图的透明栅格或 GeoJSON 使用 `map`；XLSX、DOCX、NPZ 等文件使用 `download`。不要在前端按工具名、文件名或临时字段猜测展示位置。

provenance 至少说明：

- provider/tool 名称
- 第三方算法来源或版本，例如 `sourceSnapshot` 与 wrapper version
- 输入 valueRef
- 输出 artifact

## Worker-backed 工具

Worker 只承载科学计算，不保存平台业务状态。Node Provider 负责：

- 解析 valueRef
- 准备 artifact 目标路径
- 传入 runtime 相对路径
- 持久化 artifact、valueRef 和 provenance
- 把 worker 错误原样上浮

Python worker 必须：

- 拒绝绝对路径
- 拒绝 runtime 根目录外路径
- 对缺依赖在 `/health` 明确报错
- 不保存业务 session
- 不返回 catch-all fallback 成功文本

## Mini-App Metadata

需要还原小工具页面体验时，在工具 schema 或 artifact metadata 中声明 mini-app 类型：

```json
{
  "miniApp": { "type": "rainfall_risk_map_console" }
}
```

前端 mini-app 只负责展示流程、参数摘要、预览和下载按钮。运行仍调用统一 `tool:run`，不得 iframe 原页面、开新端口或绕过工具 ledger。

## 测试要求

合并前至少覆盖：

- Provider manifest/runtime parity
- schema 校验和 descriptor 展示
- 未知 valueRef 硬失败
- worker 不可用和坏参数错误透传
- artifact/valueRef 持久化
- 前端工具表单、mini-app 展示和下载按钮

推荐最终命令：

```bash
npm test
npm run lint:web
npm run build
pytest -q
npm run test:e2e
```
