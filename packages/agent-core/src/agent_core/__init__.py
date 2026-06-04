# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 核心包导出
#
#   文件:       __init__.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------

# 模块职责
#
# 统一导出 agent core 的运行时与解析能力，作为上层依赖入口。

from .agent_definitions import AgentDef, load_agent_definitions, merge_with_static_agents
from .graph import GeoAgentRuntime, RuntimeStats
from .hooks import AgentHookManager, AgentHooks, HookHandler, HookResult, load_hooks_from_config
from .mcp_parser import (
    McpMergeResult, McpOAuthConfig, McpResourceDescriptor,
    merge_mcp_configs, expand_env_vars, expand_env_vars_in_config,
    build_sdk_mcp_params,
)
from .memory import MemoryManager, MemoryHeader
from .permissions import PermissionRule, evaluate_permission_chain
from .project_context import discover_context_files, load_context_prompt
from .prompt_builder import (
    PromptType,
    SystemPromptParts,
    ToolUseSummaryResult,
    as_system_prompt,
    build_memory_mechanics_prompt,
    build_system_context,
    build_user_context,
    create_tool_use_summary,
    fetch_system_prompt_parts,
)
from .skills import SkillManager, SkillFrontmatter, SkillCommand, parse_skill_frontmatter_fields
from .token_budget import BudgetTracker, BudgetStatus, TokenBudget
from .turn_runtime import MessageLedgerSink, RunEventSink, SdkToolAdapter, TurnFinalizer, TurnRunner

__all__ = [
    "GeoAgentRuntime", "RuntimeStats",
    "McpMergeResult", "McpOAuthConfig", "McpResourceDescriptor",
    "merge_mcp_configs", "expand_env_vars", "expand_env_vars_in_config",
    "build_sdk_mcp_params",
    "MemoryManager", "MemoryHeader",
    "AgentHookManager", "AgentHooks", "HookHandler", "HookResult", "load_hooks_from_config",
    "PermissionRule", "evaluate_permission_chain",
    "PromptType", "SystemPromptParts", "ToolUseSummaryResult",
    "as_system_prompt", "build_memory_mechanics_prompt", "build_system_context",
    "build_user_context", "create_tool_use_summary", "fetch_system_prompt_parts",
    "discover_context_files", "load_context_prompt",
    "SkillManager", "SkillFrontmatter", "SkillCommand", "parse_skill_frontmatter_fields",
    "BudgetTracker", "BudgetStatus", "TokenBudget",
    "MessageLedgerSink", "RunEventSink", "SdkToolAdapter", "TurnFinalizer", "TurnRunner",
    "AgentDef", "load_agent_definitions", "merge_with_static_agents",
]
