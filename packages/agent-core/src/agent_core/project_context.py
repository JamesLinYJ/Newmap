# +-------------------------------------------------------------------------
#
#   地理智能平台 - 项目上下文自动发现
#
#   文件:       project_context.py
#
#   日期:       2026年06月01日
#   作者:       Agent SDK
# --------------------------------------------------------------------------

# 模块职责
#
# 启动时扫描项目根目录的 .geoagent/ 和用户主目录的 ~/.geoagent/ 下的上下文文件，
# 自动注入到 supervisor system prompt 中，使 Agent 能感知项目特定的说明和约定。

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# 上下文文件扫描优先级（从高到低）
_CONTEXT_FILE_CANDIDATES: list[str] = [
    "CLAUDE.md",
    "CONTEXT.md",
    "AGENTS.md",
    ".georules",
]

# 最大注入字符数（10K）
_MAX_CONTEXT_CHARS: int = 10_000


def discover_context_files(project_root: Optional[Path] = None) -> list[str]:
    """扫描 .geoagent/ 和 ~/.geoagent/ 下的上下文文件。

    扫描路径（按优先级从高到低）：
      1. <project_root>/.geoagent/CLAUDE.md
      2. <project_root>/.geoagent/CONTEXT.md
      3. <project_root>/.geoagent/AGENTS.md
      4. <project_root>/.geoagent/.georules
      5. ~/.geoagent/CLAUDE.md
      6. ~/.geoagent/CONTEXT.md
      7. ~/.geoagent/AGENTS.md

    优先级规则：项目级 > 用户级，文件名靠前者优先。
    同一路径只返回第一个找到的文件，不合并。

    Args:
        project_root: 项目根目录。为 None 时使用 Path.cwd()。

    Returns:
        按优先级排序的已找到上下文文件路径列表。
    """
    found: list[str] = []

    scan_dirs: list[Path] = []
    if project_root is not None:
        scan_dirs.append(project_root / ".geoagent")
    else:
        scan_dirs.append(Path.cwd() / ".geoagent")

    user_geoagent_dir = Path.home() / ".geoagent"
    if user_geoagent_dir != scan_dirs[0]:
        scan_dirs.append(user_geoagent_dir)

    for directory in scan_dirs:
        if not directory.is_dir():
            logger.debug("上下文目录不存在: %s", directory)
            continue
        for filename in _CONTEXT_FILE_CANDIDATES:
            filepath = directory / filename
            if filepath.is_file():
                found.append(str(filepath.resolve()))
                break  # 每个目录只取优先级最高的一个

    return found


def load_context_prompt(project_root: Optional[Path] = None) -> str:
    """加载所有上下文文件内容，组装为 prompt 片段。

    扫描 discover_context_files 找到的所有上下文文件，读取内容后按优先级拼接。
    总长度限制 10K 字符，超出部分截断。

    Args:
        project_root: 项目根目录。为 None 时使用 Path.cwd()。

    Returns:
        格式化后的上下文 prompt 字符串。未找到任何文件时返回空字符串。
    """
    found_files = discover_context_files(project_root)
    if not found_files:
        logger.debug("未找到项目上下文文件。")
        return ""

    sections: list[str] = []
    total_chars = 0

    for filepath_str in found_files:
        filepath = Path(filepath_str)
        try:
            content = filepath.read_text(encoding="utf-8").strip()
            if not content:
                continue

            # 计算本次追加后的总长度
            section_header = f"### 来自 {filepath.name}（{filepath.parent.name}/）\n"
            section_text = f"\n{section_header}\n{content}\n"

            # 如果加上当前 section 会超出限制，截断整个 prompt 并退出
            if total_chars + len(section_text) > _MAX_CONTEXT_CHARS:
                remaining = _MAX_CONTEXT_CHARS - total_chars
                if remaining > 200:
                    # section_header 大约 50 字符，留出足够的正文空间
                    truncated_content = content[:remaining - len(section_header) - 50]
                    sections.append(f"\n{section_header}\n{truncated_content}\n[... 上下文已截断，超过 {_MAX_CONTEXT_CHARS} 字符限制 ...]")
                else:
                    sections.append("\n[... 上下文已截断，超过 10K 字符限制 ...]")
                break

            sections.append(section_text)
            total_chars += len(section_text)

        except (OSError, UnicodeDecodeError) as exc:
            logger.warning("读取上下文文件失败 %s: %s", filepath, exc)
            continue

    if not sections:
        return ""

    return (
        "\n"
        "## 项目上下文\n"
        "\n"
        "以下内容来自项目配置文件，请在回答时参考这些规则和约定："
        + "".join(sections)
        + "\n"
    )
