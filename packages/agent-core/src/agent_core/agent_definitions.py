# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 自定义定义加载
#
#   文件:       agent_definitions.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------

# 模块职责
#
# 从 .geoagent/agents/ 目录加载自定义 Agent 定义 (YAML)。
# 支持在项目层面定义新的子智能体，无需修改代码。
#
# 文件格式: .geoagent/agents/weather_expert.yml
#   name: weather_expert
#   description: 气象数据分析专家
#   system_prompt: |
#     你是气象分析专家...
#   tools:
#     - list_meteorological_datasets
#     - inspect_meteorological_dataset
#   model: default

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

AGENTS_DIR: str = ".geoagent/agents"
"""自定义 Agent 定义文件存放目录（相对项目根目录）。"""

ALLOWED_AGENT_FILE_EXTENSIONS: frozenset[str] = frozenset({".yml", ".yaml"})
"""允许的 Agent 定义文件扩展名。"""


# ===================================================================
# AgentDef — 自定义 Agent 定义数据类
# ===================================================================

@dataclass
class AgentDef:
    """自定义 Agent 定义。

    从 YAML 文件解析，描述一个独立的子智能体。

    Attributes:
        name: Agent 唯一名称（也是 agent_id）。
        description: Agent 功能描述（用于 handoff 决策）。
        system_prompt: Agent 系统提示词。
        tools: Agent 可用的工具名称列表。
        model: Agent 使用的模型名称。"default" 表示使用主模型。
    """
    name: str
    description: str = ""
    system_prompt: str = ""
    tools: list[str] = field(default_factory=list)
    model: str = "default"


# ===================================================================
# 加载函数
# ===================================================================

def find_agent_files(agents_dir: Path) -> list[Path]:
    """扫描目录，查找所有合法的 Agent 定义 YAML 文件。

    Args:
        agents_dir: 存放 Agent 定义文件的目录路径。

    Returns:
        按文件名排序的 YAML 文件路径列表。
    """
    if not agents_dir.exists() or not agents_dir.is_dir():
        return []

    files: list[Path] = []
    for ext in ALLOWED_AGENT_FILE_EXTENSIONS:
        files.extend(agents_dir.glob(f"*{ext}"))

    return sorted(files)


def parse_agent_yaml(file_path: Path) -> AgentDef | None:
    """解析单个 Agent 定义 YAML 文件。

    YAML 格式:
        name: agent_name
        description: 描述文字
        system_prompt: |
            多行提示词...
        tools:
          - tool_name_1
          - tool_name_2
        model: default

    Args:
        file_path: YAML 文件的路径。

    Returns:
        解析成功的 AgentDef 实例。解析失败时返回 None。
    """
    if not file_path.exists() or file_path.stat().st_size == 0:
        logger.warning("Agent 定义文件不存在或为空: %s", file_path)
        return None

    try:
        raw = file_path.read_text(encoding="utf-8")
        data: dict[str, Any] = yaml.safe_load(raw) or {}
    except (yaml.YAMLError, OSError, UnicodeDecodeError) as exc:
        logger.warning("解析 Agent 定义 YAML 失败: %s — %s", file_path, exc)
        return None

    if not isinstance(data, dict):
        logger.warning("Agent 定义 YAML 不是对象: %s", file_path)
        return None

    name = data.get("name")
    if not name or not isinstance(name, str) or not name.strip():
        logger.warning("Agent 定义缺少有效的 name 字段: %s", file_path)
        return None

    name = name.strip()
    description = str(data.get("description", "")).strip()
    system_prompt = str(data.get("system_prompt", "")).strip()
    raw_tools = data.get("tools", [])
    tools: list[str] = []
    if isinstance(raw_tools, list):
        for t in raw_tools:
            if isinstance(t, str) and t.strip():
                tools.append(t.strip())
    model = str(data.get("model", "default")).strip() or "default"

    return AgentDef(
        name=name,
        description=description,
        system_prompt=system_prompt,
        tools=tools,
        model=model,
    )


def load_agent_definitions(project_root: Path) -> list[AgentDef]:
    """从项目根目录的 .geoagent/agents/ 加载所有自定义 Agent 定义。

    扫描 .geoagent/agents/*.{yml,yaml}，逐个解析。

    Args:
        project_root: 项目根目录路径。

    Returns:
        成功解析的 AgentDef 列表。按名称字母序排列。
    """
    agents_dir = project_root.resolve() / AGENTS_DIR
    agent_files = find_agent_files(agents_dir)

    definitions: list[AgentDef] = []
    for file_path in agent_files:
        parsed = parse_agent_yaml(file_path)
        if parsed is not None:
            definitions.append(parsed)
            logger.info(
                "已加载自定义 Agent 定义: %s (来自 %s)",
                parsed.name, file_path,
            )

    # 按名称排序
    definitions.sort(key=lambda d: d.name)
    return definitions


def merge_with_static_agents(
    static_agents: list[Any],
    project_root: Path | None = None,
    custom_definitions: list[AgentDef] | None = None,
) -> list[Any]:
    """合并静态配置和动态加载的自定义 Agent 定义。

    自定义 Agent 会附加到静态 Agent 列表末尾。
    如果自定义 Agent 的名称与静态 Agent 的 agent_id 冲突，自定义的会覆盖静态的。

    Args:
        static_agents: 静态配置中的 Agent 列表（如 RuntimeSubAgentConfig 列表）。
        project_root: 项目根目录路径（用于加载自定义定义）。
        custom_definitions: 直接传入的自定义定义列表（优先级高于 project_root 加载的）。

    Returns:
        合并后的 Agent 列表（静态 + 自定义）。
    """
    merged = list(static_agents)

    # 收集自定义定义
    customs: list[AgentDef] = []
    if custom_definitions is not None:
        customs.extend(custom_definitions)
    elif project_root is not None:
        customs.extend(load_agent_definitions(project_root))

    if not customs:
        return merged

    # 构建静态 agent_id 到索引的映射
    static_ids: dict[str, int] = {}
    for i, agent in enumerate(merged):
        agent_id = (
            getattr(agent, "agent_id", None)
            or getattr(agent, "name", None)
            or ""
        )
        if agent_id:
            static_ids[agent_id] = i

    # 合并或追加自定义 Agent
    for custom in customs:
        if custom.name in static_ids:
            # 覆盖静态条目
            idx = static_ids[custom.name]
            merged[idx] = _custom_to_config(custom)
            logger.info("自定义 Agent '%s' 覆盖了静态配置", custom.name)
        else:
            # 追加到末尾
            merged.append(_custom_to_config(custom))
            logger.info("自定义 Agent '%s' 已追加到配置", custom.name)

    return merged


def _custom_to_config(custom: AgentDef) -> Any:
    """将 AgentDef 转换为 RuntimeSubAgentConfig 兼容的字典。

    返回 dict 而非具体类型以保持灵活性。

    Args:
        custom: 自定义 Agent 定义。

    Returns:
        兼容 RuntimeSubAgentConfig 的字典。
    """
    return {
        "agentId": custom.name,
        "name": custom.name,
        "role": custom.description,
        "summary": custom.description,
        "system_prompt": custom.system_prompt or custom.description,
        "tools": list(custom.tools),
    }
