# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具描述契约测试
#
#   文件:       test_tool_descriptor_contract.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证模块 Provider 接入后仍然通过统一 ToolDescriptor 暴露给
# API、DebugPage 和 Agent，不让前端区分“内建工具”和“合并进来的模块工具”。

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from api_app.tool_catalog import build_registry_tool_descriptors
from tool_registry import ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore
from tool_registry.providers import build_registry_with_providers


def test_module_provider_tools_are_rendered_as_standard_descriptors() -> None:
    # 描述符契约。
    #
    # Provider 元数据进入 meta，但工具本体仍是 registry ToolDescriptor，
    # 前端工具工作台不需要为模块工具写分支。
    registry = build_registry_with_providers(["docs.examples.simple_tool_provider.provider:provider"])
    descriptors = build_registry_tool_descriptors(registry, {"tools": {}})
    descriptor = next(item for item in descriptors if item.name == "inspect_demo_status")

    assert descriptor.tool_kind == "registry"
    assert descriptor.group == "analysis"
    assert descriptor.meta["providerId"] == "docs.simple_demo"
    assert descriptor.meta["toolApiVersion"] == "1"
    assert {item.key for item in descriptor.parameters} == {"query"}
    assert descriptor.parameters[0].source == "text"


@pytest.mark.asyncio
async def test_documented_module_provider_executes_through_standard_registry(tmp_path: Path) -> None:
    # 执行契约。
    #
    # 示例 provider 的两个工具通过标准 registry 串联，第二个工具只消费
    # 第一个工具产出的 valueRef，不复制真实值。
    registry = build_registry_with_providers(["docs.examples.simple_tool_provider.provider:provider"])
    runtime = ToolRuntime(
        context=ToolRuntimeContext(
            run_id="run_test",
            thread_id="thread_test",
            session_id="session_test",
            latest_uploaded_layer_key=None,
        ),
        state=ToolRuntimeState(),
        store=ToolRuntimeStore(
            platform_store=SimpleNamespace(),
            layer_repository=SimpleNamespace(),
            artifact_export_store=SimpleNamespace(),
            spatial_service=SimpleNamespace(),
            runtime_root=tmp_path,
        ),
    )

    inspect_result = await registry.execute("inspect_demo_status", {"query": "demo"}, runtime)
    status_ref = inspect_result.value_refs[0].ref_id
    score_result = await registry.execute("calculate_demo_score", {"status_ref": status_ref}, runtime)

    assert status_ref in runtime.state.value_map
    assert score_result.payload["score"] == 100
    with pytest.raises(ValueError, match="工具值引用不存在"):
        await registry.execute("calculate_demo_score", {"status_ref": "value:missing"}, runtime)
