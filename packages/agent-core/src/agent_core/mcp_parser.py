# +-------------------------------------------------------------------------
#
#   地理智能平台 - MCP 配置管理（基于 OpenAI Agents SDK）
#
#   文件:       mcp_parser.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# MCP 配置管理薄层，补充 OpenAI Agents SDK 原生 MCP 能力的缺口：
#   - settings.json → MCPServerStdioParams / MCPServerSseParams 映射
#   - ${ENV_VAR} 递归展开（SDK 不做）
#   - 多源配置优先级合并（SDK 不做）
#   - OAuth 配置持久化（SDK 无）
#
# SDK 原生负责的（本文件不再重复）：
#   - 传输层连接与生命周期 → MCPServerStdio / MCPServerSse / MCPServerStreamableHttp
#   - 连接池管理 → MCPServerManager
#   - 工具列表与过滤 → MCPServer.list_tools() + create_static_tool_filter()
#   - 工具名规范化 → SDK 内部自动处理
#   - 工具调用 → MCPServer.call_tool()

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ===================================================================
# 环境变量展开 — SDK 不提供，参考实现有 (envExpansion.ts)
# ===================================================================

_ENV_VAR_REGEX: re.Pattern = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def expand_env_vars(value: str, extra_env: dict[str, str] | None = None) -> str:
    """展开字符串中的 ${ENV_VAR} 环境变量引用。

    安全约束: 未定义的变量保留原样（不展开为空白），避免静默吞掉配置。

    Args:
        value: 包含 ${ENV_VAR} 占位符的原始字符串。
        extra_env: 额外环境变量字典（覆盖 os.environ）。

    Returns:
        展开后的字符串。
    """
    combined = dict(os.environ)
    if extra_env:
        combined.update(extra_env)

    def _replace(match: re.Match) -> str:
        var_name = match.group(1)
        return combined.get(var_name, match.group(0))

    return _ENV_VAR_REGEX.sub(_replace, value)


def expand_env_vars_in_config(
    config: dict[str, Any],
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """递归展开 MCP 配置中的所有 ${ENV_VAR} 引用。

    只处理 str 类型的值；其他类型原样保留。

    Args:
        config: 原始 MCP 服务器配置字典。
        extra_env: 额外环境变量。

    Returns:
        展开后的配置字典。
    """
    result: dict[str, Any] = {}
    for k, v in config.items():
        if isinstance(v, str):
            result[k] = expand_env_vars(v, extra_env)
        elif isinstance(v, dict):
            result[k] = expand_env_vars_in_config(v, extra_env)
        elif isinstance(v, list):
            result[k] = [
                expand_env_vars(item, extra_env) if isinstance(item, str) else item
                for item in v
            ]
        else:
            result[k] = v
    return result


# ===================================================================
# 配置优先级合并 — SDK 不提供多源合并，参考实现有 (config.ts)
# ===================================================================

# 配置来源（优先级从低到高）
_SCOPE_ENTERPRISE: str = "enterprise"
_SCOPE_USER: str = "user"
_SCOPE_PROJECT: str = "project"
_SCOPE_LOCAL: str = "local"
_SCOPE_DYNAMIC: str = "dynamic"

_SCOPE_PRIORITY: dict[str, int] = {
    _SCOPE_ENTERPRISE: 1,
    _SCOPE_USER: 3,
    _SCOPE_PROJECT: 5,
    _SCOPE_DYNAMIC: 6,
    _SCOPE_LOCAL: 7,
}


@dataclass
class McpMergeResult:
    """多源 MCP 配置合并结果。"""
    servers: dict[str, dict[str, Any]] = field(default_factory=dict)
    conflicts: list[str] = field(default_factory=list)


def merge_mcp_configs(
    *sources: tuple[str, dict[str, dict[str, Any]]],
) -> McpMergeResult:
    """合并多个优先级的 MCP 配置。

    - 按 scope 优先级从低到高合并
    - 同名服务器，高优先级覆盖低优先级
    - disabled=True 的服务器从合并结果中排除

    Args:
        *sources: (scope_name, {server_name: config_dict}) 元组序列。

    Returns:
        McpMergeResult，含合并后配置和冲突日志。
    """
    result: dict[str, tuple[dict[str, Any], int]] = {}
    conflicts: list[str] = []

    for scope_name, servers in sources:
        priority = _SCOPE_PRIORITY.get(scope_name, 0)
        for name, config in servers.items():
            if not isinstance(config, dict):
                continue
            existing = result.get(name)
            if existing:
                if priority > existing[1]:
                    conflicts.append(
                        f"MCP '{name}': scope={scope_name}(p={priority}) "
                        f"覆盖 scope={existing[1]}"
                    )
                    result[name] = (config, priority)
            else:
                result[name] = (config, priority)

    merged = {
        name: cfg
        for name, (cfg, _) in result.items()
        if not cfg.get("disabled", False)
    }
    return McpMergeResult(servers=merged, conflicts=conflicts)


# ===================================================================
# OAuth 配置 — SDK 未暴露独立 OAuth 配置类型
# ===================================================================

@dataclass
class McpOAuthConfig:
    """MCP OAuth 客户端配置。

    用于 SSE/HTTP 传输类型的 OAuth 2.0 认证。
    SDK 内部已处理 OAuth 流程，此类型仅用于配置持久化。
    """
    client_id: str | None = None
    callback_port: int | None = None
    auth_server_metadata_url: str | None = None


# ===================================================================
# MCP 资源 — SDK 对资源发现支持有限
# ===================================================================

@dataclass
class McpResourceDescriptor:
    """MCP 资源描述符。

    SDK 的 MCPServer.read_resource() 可读取单个资源，
    但 listResources() 的返回格式平台可能需自行解析。
    """
    uri: str
    name: str
    description: str = ""
    mime_type: str | None = None


# ===================================================================
# SDK-ToolRegistry 桥接 — settings.json → SDK 原生配置类
# ===================================================================

def build_sdk_mcp_params(
    server_name: str,
    config_dict: dict[str, Any],
) -> dict[str, Any]:
    """将 settings.json 中的 MCP 配置字典映射为 SDK 原生参数。

    返回的 dict 可直接解包传递给 SDK 的 MCPServerStdio/Sse/StreamableHttp:
        from agents.mcp import MCPServerStdio, MCPServerSse, MCPServerStreamableHttp

        server = MCPServerStdio(
            params=MCPServerStdioParams(command=..., args=...),
            name="my_server",
        )

    Args:
        server_name: MCP 服务器名称。
        config_dict: 已展开环境变量的配置字典。

    Returns:
        {"transport": "stdio"|"sse"|"http"|"ws", "params": {...}}
        可直接用于构建 SDK MCPServer 实例。
    """
    transport_type = config_dict.get("type", "stdio")
    params = expand_env_vars_in_config(dict(config_dict))

    # 移除 type 字段（SDK 通过类名区分）
    params.pop("type", None)

    return {
        "transport": transport_type,
        "params": params,
        "name": server_name,
    }
