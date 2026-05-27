# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具接入详细标准
#
#   文件:       tool-integration-standard.md
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 工具接入详细标准

本文是团队内外开发工具模块时必须遵守的标准。工具可以由不同人员独立开发，最终通过代码合并进入仓库；平台不会自动加载未知工具，也不会用 fallback 掩盖工具错误。

## 1. 接入模型

工具必须以模块 Provider 接入：

- 每个工具模块导出一个 `ToolProvider` 对象或类。
- Provider 声明 `ToolManifest`，并返回 `list[ToolDefinition]`。
- API 启动时只加载 `ENABLED_TOOL_PROVIDERS` 中显式列出的 `module:object`。
- 未通过契约校验的 provider 不能进入 registry，也不会出现在 DebugPage。

示例配置：

```bash
ENABLED_TOOL_PROVIDERS='["my_tools.hydrology.provider:provider"]'
```

## 2. 目录建议

仓库内新增工具建议使用独立模块目录：

```text
packages/tool-registry/src/tool_registry/my_domain_tools/
  __init__.py
  provider.py
  args.py
  service.py
  tests or repo tests
```

职责边界：

- `args.py`：只放 `ToolArgsModel`。
- `service.py`：放领域计算、文件解析、外部 SDK 调用等业务逻辑。
- `provider.py`：只把 handler、metadata、args_model 组装成 `ToolDefinition`。
- handler 是薄适配层，只做参数解析、调用 service、登记 artifact/valueRef。

## 3. Manifest 标准

Provider 必须声明：

```python
ToolManifest(
    provider_id="domain.short_name",
    name="中文工具模块名称",
    version="0.1.0",
    owner="团队或负责人",
    tool_api_version="1",
    permissions=[],
)
```

权限枚举：

- `network`
- `filesystem_read`
- `filesystem_write`
- `execute_code`
- `paid_api`
- `publish`
- `private_network`

声明敏感权限的工具必须在 `ToolMetadata.meta` 中写 `approvalRequired=True`，并进入运行时审批配置。

## 4. 命名标准

工具名必须：

- 使用 `snake_case`。
- 以明确动词开头。
- 第三方或业务模块建议加领域前缀。

推荐：

- `inspect_nowcast_sequence`
- `analyze_nowcast_precipitation`
- `render_nowcast_raster`
- `hydrology_analyze_flow`

禁止：

- `weatherTool`
- `do_it`
- `rain`
- `tool1`

## 5. 参数标准

所有参数模型必须继承 `ToolArgsModel`。

每个字段必须有：

- `title`
- `description`
- `json_schema_extra={"x-ui-source": "..."}`
- 必要时加 `ge/le/min_length/max_length` 等范围限制。

示例：

```python
class InspectDemoArgs(ToolArgsModel):
    query: str = Field(
        ...,
        title="查询内容",
        description="需要查询的对象名称。",
        json_schema_extra={"x-ui-source": "text"},
    )
```

引用规则：

- 上游工具产出的坐标、bbox、变量名、时间片、统计值、阈值必须走 `valueRef`。
- 大几何用 `collectionRef` 或 `area_ref`。
- 文件用 `artifactId`。
- 图层用 `layerKey`。
- 未知引用必须直接失败，不能让模型复制旧值或猜值。

## 6. 返回标准

handler 必须是 async，并返回 `ToolExecutionResult`。

返回字段约定：

- `message`：短中文结果说明。
- `payload`：结构化事实，不塞不可追踪大文件内容。
- `provenance`：数据来源、关键参数、算法版本、外部 provider。
- `value_refs`：后续工具可复用的小值。
- `artifact`：可下载、可地图展示或报告输出。
- `warnings`：非阻塞风险提示。

工具不得返回“看起来成功但没有真实结果”的 synthetic payload。

## 7. 状态与上下文标准

工具只能使用平台传入的 `ToolRuntime`：

- 当前 run 临时值写入 `ToolRuntimeState.value_map`。
- 集合别名写入 `ToolRuntimeState.alias_map`。
- 历史复用必须通过 JSONL context index。
- 工具不得扫描旧 run/event 自己拼上下文。
- 工具不得写隐藏全局变量保存业务状态。

## 8. 错误标准

以下情况必须明确失败：

- 参数缺失。
- 未知 `valueRef` / `collectionRef` / `artifactId`。
- 引用类型不匹配。
- 输入文件格式不支持。
- CRS 缺失或不可解析。
- 外部 SDK/API 失败。
- LLM 输出 schema 校验失败。

错误文案要说明具体失败点和可操作修复方式。禁止 fallback 伪装成功。

## 9. LLM 工具标准

使用大模型的工具必须：

- 先构造结构化 facts。
- prompt 明确只能使用 facts。
- 输出使用 schema 校验。
- 校验失败直接失败。
- 长文本后续传递必须用 `valueRef`，例如 `interpretation_ref` 或 `forecast_text_ref`。

## 10. 测试标准

每个工具模块至少提供：

- Provider contract test。
- descriptor 生成测试。
- 成功调用测试。
- 参数错误测试。
- 未知引用失败测试。
- artifact 或 valueRef 注册测试。

合并前必须运行：

```bash
python -m tool_registry.validate_provider your.module:provider
pytest -q
```

## 11. Code Review Checklist

审查工具模块时必须确认：

- Provider 显式声明 manifest。
- 工具名、metadata、参数字段通过契约校验。
- handler 只做薄适配，业务逻辑在 service。
- 没有隐式 fallback。
- 没有隐藏全局状态。
- 没有让模型手抄工具派生值。
- 敏感权限已声明并接入审批。
- 大文件、大栅格、大 GeoJSON 有上限保护。
