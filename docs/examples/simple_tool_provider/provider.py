# +-------------------------------------------------------------------------
#
#   地理智能平台 - 简单工具 Provider 示例
#
#   文件:       provider.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 展示一个仓库内工具模块如何声明 manifest、参数、handler 和 ToolDefinition。
# 这个示例不访问外部服务，方便开发者本地运行契约校验。

from __future__ import annotations

from typing import Any

from pydantic import Field

from tool_registry import ToolArgsModel, ToolDefinition, ToolExecutionResult, ToolManifest, ToolMetadata, ToolValueStore, resolve_value_ref


class InspectDemoStatusArgs(ToolArgsModel):
    query: str = Field(
        ...,
        title="查询内容",
        description="需要演示工具检查的对象名称。",
        json_schema_extra={"x-ui-source": "text", "placeholder": "例如：demo"},
    )


class CalculateDemoScoreArgs(ToolArgsModel):
    status_ref: str = Field(
        ...,
        title="状态引用",
        description="inspect_demo_status 产出的 status valueRef。",
        json_schema_extra={"x-ui-source": "text", "placeholder": "value:status:..."},
    )


async def inspect_demo_status(args: dict[str, Any], runtime) -> ToolExecutionResult:
    values = ToolValueStore(runtime, source_tool="inspect_demo_status")
    ref = values.put(
        kind="status",
        label=f"{args['query']} 状态",
        value={"query": args["query"], "status": "ok"},
        metadata={"demo": True},
    )
    return ToolExecutionResult(
        message="已完成示例状态检查。",
        payload={"query": args["query"], "statusRef": ref.ref_id},
        source="demo_provider",
        provenance={"operation": "inspect_demo_status"},
        value_refs=[ref],
    )


async def calculate_demo_score(args: dict[str, Any], runtime) -> ToolExecutionResult:
    status = resolve_value_ref(runtime, args["status_ref"], expected_kinds={"status"})
    return ToolExecutionResult(
        message="已计算示例评分。",
        payload={"score": 100, "statusLabel": status.label},
        source="demo_provider",
        provenance={"operation": "calculate_demo_score", "statusRef": args["status_ref"]},
        feature_count=1,
    )


class DemoToolProvider:
    @property
    def manifest(self) -> ToolManifest:
        return ToolManifest(
            provider_id="docs.simple_demo",
            name="简单工具 Provider 示例",
            version="0.1.0",
            owner="Geo Agent Platform",
            description="文档中的仓库内工具模块示例。",
            permissions=[],
        )

    def list_definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                "inspect_demo_status",
                inspect_demo_status,
                ToolMetadata(
                    "检查示例状态",
                    "输入一个演示对象名称，返回结构化状态并登记 status valueRef；用于展示工具模块标准接入方式和失败边界。",
                    "analysis",
                    ["demo", "provider"],
                ),
                InspectDemoStatusArgs,
            ),
            ToolDefinition(
                "calculate_demo_score",
                calculate_demo_score,
                ToolMetadata(
                    "计算示例评分",
                    "消费 inspect_demo_status 产出的 status_ref，返回一个结构化评分；用于展示工具之间通过 valueRef 串联。",
                    "analysis",
                    ["demo", "provider", "valueRef"],
                ),
                CalculateDemoScoreArgs,
            ),
        ]


provider = DemoToolProvider()
