# +-------------------------------------------------------------------------
#
#   地理智能平台 - 外部 Agent 工具源码快照
#
#   文件:       README.md
#
#   日期:       2026年06月25日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# Source-Code Agent Tools Snapshot

这个目录保存从 `C:\Users\James\Desktop\source-code` 复制过来的工具源码快照，作为后续迁移 GeoForge 计划模式、文件工具、搜索工具、任务工具和 Agent 工具的参考来源。

## 边界

- `src/tools/`、`src/Tool.ts`、`src/tools.ts` 是原始工具接口和工具实现快照。
- 这里的文件不参与 GeoForge `server` 或 `apps/web` 编译。
- 后续运行态必须通过 GeoForge 自己的 `ToolProvider`、`ToolRegistry`、Agents SDK bridge、approval、artifact 和 valueRef 链路适配。
- 可以基于这些文件改写迁移版，但不要把此目录当作运行时入口。

## 迁移顺序

1. 计划模式：`EnterPlanModeTool`、`ExitPlanModeTool`
2. 只读文件工具：`FileReadTool`、`GlobTool`、`GrepTool`
3. 任务/待办工具：`TodoWriteTool`、`Task*`
4. 写入/执行工具：`FileEditTool`、`FileWriteTool`、`BashTool`、`PowerShellTool`
5. 子 Agent / Skill / ToolSearch
