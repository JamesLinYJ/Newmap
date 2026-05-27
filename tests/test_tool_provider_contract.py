# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具 Provider 契约测试
#
#   文件:       test_tool_provider_contract.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定仓库内工具模块的 Provider 接入标准，确保不同团队
# 合并工具代码前能被同一套契约校验拦住明显不合规实现。

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pydantic import Field

from tool_registry import ToolArgsModel, ToolDefinition, ToolExecutionResult, ToolManifest, ToolMetadata, build_default_registry
from tool_registry.providers import ToolProviderContractError, build_registry_with_providers, validate_provider
from tool_registry.validate_provider import main as validate_provider_main


class _GoodArgs(ToolArgsModel):
    query: str = Field(
        ...,
        title="查询内容",
        description="需要测试工具处理的查询文本。",
        json_schema_extra={"x-ui-source": "text"},
    )


async def _good_handler(args: dict[str, Any], runtime) -> ToolExecutionResult:
    return ToolExecutionResult(
        message="测试工具已完成。",
        payload={"query": args["query"]},
        source="test_provider",
        provenance={"operation": "test"},
    )


class _GoodProvider:
    @property
    def manifest(self) -> ToolManifest:
        return ToolManifest(
            provider_id="tests.good_provider",
            name="测试工具 Provider",
            version="0.1.0",
            owner="tests",
            permissions=[],
        )

    def list_definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                "inspect_test_status",
                _good_handler,
                ToolMetadata(
                    "检查测试状态",
                    "输入测试查询文本并返回结构化结果；用于验证仓库内工具模块的标准接入契约。",
                    "analysis",
                    ["test", "provider"],
                ),
                _GoodArgs,
            )
        ]


def test_provider_contract_accepts_well_formed_module_provider() -> None:
    # 正向契约。
    #
    # 合规 provider 应该能通过校验，并在注册表中以普通 registry 工具形态出现。
    provider = _GoodProvider()

    validate_provider(provider)
    registry = build_registry_with_providers([f"{__name__}:_GoodProvider"])

    assert registry.has("inspect_test_status")


def test_provider_contract_rejects_bad_tool_name() -> None:
    class BadProvider(_GoodProvider):
        def list_definitions(self) -> list[ToolDefinition]:
            return [
                ToolDefinition(
                    "weatherTool",
                    _good_handler,
                    ToolMetadata(
                        "坏工具名",
                        "这个工具故意使用不合规名称，用来验证契约校验会拒绝非 snake_case 工具名。",
                        "analysis",
                        ["test"],
                    ),
                    _GoodArgs,
                )
            ]

    with pytest.raises(ToolProviderContractError, match="snake_case"):
        validate_provider(BadProvider())


def test_provider_contract_rejects_missing_parameter_ui_source() -> None:
    class BadArgs(ToolArgsModel):
        query: str = Field(..., title="查询内容", description="缺少 x-ui-source 的参数。")

    class BadProvider(_GoodProvider):
        def list_definitions(self) -> list[ToolDefinition]:
            return [
                ToolDefinition(
                    "inspect_bad_status",
                    _good_handler,
                    ToolMetadata(
                        "检查坏状态",
                        "这个工具故意缺少参数 UI 来源，用来验证 DebugPage 描述契约。",
                        "analysis",
                        ["test"],
                    ),
                    BadArgs,
                )
            ]

    with pytest.raises(ToolProviderContractError, match="x-ui-source"):
        validate_provider(BadProvider())


def test_sensitive_provider_must_mark_tool_approval_required() -> None:
    class SensitiveProvider(_GoodProvider):
        @property
        def manifest(self) -> ToolManifest:
            return ToolManifest(
                provider_id="tests.sensitive_provider",
                name="敏感测试工具 Provider",
                version="0.1.0",
                owner="tests",
                permissions=["filesystem_write"],
            )

    with pytest.raises(ToolProviderContractError, match="approvalRequired"):
        validate_provider(SensitiveProvider())


def test_validate_provider_cli_accepts_documented_example(capsys) -> None:
    # 文档示例也参加契约测试。
    #
    # 这样标准文档里的示例不会随着真实接口演进而悄悄失效。
    code = validate_provider_main(["docs.examples.simple_tool_provider.provider:provider", "--json"])
    output = capsys.readouterr().out

    assert code == 0
    assert "docs.simple_demo" in output


def test_builtin_nowcast_tools_are_provider_marked_and_not_embedded_in_registry() -> None:
    # 架构防劣化。
    #
    # 短临工具作为模块 Provider 接入，descriptor 里必须带 providerId；
    # registry.py 只聚合 provider，不能重新塞一套短临工具定义。
    registry = build_default_registry()
    definition = registry.get_definition("analyze_nowcast_precipitation")
    registry_source = Path("packages/tool-registry/src/tool_registry/registry.py").read_text(encoding="utf-8")
    nowcast_source = Path("packages/tool-registry/src/tool_registry/nowcast_tools.py").read_text(encoding="utf-8")

    assert definition.metadata.meta["providerId"] == "builtin.nowcast"
    assert "ToolDefinition(\"analyze_nowcast_precipitation\"" not in registry_source
    assert "xarray.open_dataset" not in nowcast_source
    assert "xr.open_dataset" not in nowcast_source
