# AGENTS.md

## Purpose

本目录用于开发和审查 TypeScript ToolProvider。任何 agent 在这里新增或修改工具时，都必须优先保证工具契约、运行可追溯性和失败可见性。

## Tool Development Rules

- 工具必须导出明确的 `ToolProvider`，不得依赖导入副作用注册。
- Provider 必须声明完整 `ToolManifest`，并通过 `validateToolProvider()`。
- manifest 与 `ToolDef` 的 `label`、`description`、`group`、`tags`、`jsonSchema`、`isReadOnly`、`isDestructive` 必须一致。
- handler 只做薄适配；领域算法放在 service 文件。
- 不允许返回伪成功 payload。
- 不允许吞掉模型、worker、文件、schema 或引用错误。
- 不允许扫描历史 run/event 作为隐藏上下文。
- 不允许让模型手抄工具派生值；后续工具必须消费 `valueRef`。
- 生成 artifact 时必须写入 runtime 根目录内真实文件，并返回相对路径。
- 破坏性工具必须标记 `isDestructive=true` 并在文档中说明审批边界。

## Required Tests

每个工具包至少包含：

- Provider contract test。
- manifest/runtime parity test。
- 成功调用测试。
- 参数错误测试。
- 未知 `valueRef` 失败测试。
- artifact 或 `valueRef` 持久化相关测试。

## Review Checklist

- 工具是否只通过 explicit allowlist 启用。
- schema 是否禁止未知参数或明确允许扩展。
- provenance 是否足够复查结果来源。
- artifact 文件是否真实存在。
- 错误文案是否说明具体失败点。
- 工具管理页是否能展示 Provider、schema、风险和试运行结果。
