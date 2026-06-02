# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具注册表包导出
#
#   文件:       __init__.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 统一导出工具注册表、运行时上下文和工具定义抽象。

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore
from .providers import (
    ToolManifest,
    ToolProvider,
    ToolProviderContractError,
    build_registry_with_providers,
    load_enabled_tool_providers,
    register_provider_tools,
    validate_provider,
    validate_tool_definition,
)
from .registry import ToolDefinition, ToolMetadata, ToolRegistry, build_default_registry, build_default_tool_definitions
from .value_refs import ToolValueStore, make_value_ref_id, resolve_value_ref

# 暴露 plan_tools 和 task_tools 模块，供测试直接导入 handler
from . import plan_tools as plan_tools_module
from . import task_tools as task_tools_module

__all__ = [
    "ToolArgsModel",
    "ToolDefinition",
    "ToolExecutionResult",
    "ToolMetadata",
    "ToolManifest",
    "ToolProvider",
    "ToolProviderContractError",
    "ToolRegistry",
    "ToolRuntime",
    "ToolRuntimeContext",
    "ToolRuntimeState",
    "ToolRuntimeStore",
    "ToolValueStore",
    "build_default_registry",
    "build_default_tool_definitions",
    "build_registry_with_providers",
    "load_enabled_tool_providers",
    "make_value_ref_id",
    "plan_tools_module",
    "register_provider_tools",
    "resolve_value_ref",
    "task_tools_module",
    "validate_provider",
    "validate_tool_definition",
]
