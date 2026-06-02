# +-------------------------------------------------------------------------
#
#   地理智能平台 - 系统提示构建系统 (System Prompt Builder)
#
#   文件:       prompt_builder.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------
# 模块职责
#
# 记忆系统 prompt 文本，
# 统一管理 supervisor prompt 的各个组成部分：默认系统 prompt、记忆系统说明
# （memory mechanics）、用户环境上下文、系统上下文（日期/平台）、
# 工具使用摘要等。
#
# 核心入口 fetch_system_prompt_parts() 返回 SystemPromptParts 数据类，
# 供 graph.py 的 _build_live_supervisor_prompt() 和 _build_oai_supervisor()
# 在运行时组装完整的 instructions。

from __future__ import annotations

import logging
import os
import platform as _platform
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from jinja2 import Template

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 记忆索引限制常量
#   这些常量必须与 memory.py 中的保持一致。
#   MAX_ENTRYPOINT_LINES: MEMORY.md 读取时截断的最大行数
#   MAX_ENTRYPOINT_BYTES: MEMORY.md 读取时截断的最大字节数 (25KB)
# ---------------------------------------------------------------------------
ENTRYPOINT_NAME: str = "MEMORY.md"
MAX_ENTRYPOINT_LINES: int = 200
MAX_ENTRYPOINT_BYTES: int = 25_000

_MEMORY_INDEX_MAX_LINES: int = MAX_ENTRYPOINT_LINES       # 向后兼容别名
_MEMORY_INDEX_MAX_BYTES: int = MAX_ENTRYPOINT_BYTES       # 向后兼容别名

# ======================================================================
# Prompt 文本常量
# ======================================================================

DIR_EXISTS_GUIDANCE: str = (
    "This directory already exists — write to it directly with the Write tool "
    "(do not run mkdir or check for its existence)."
)

DIRS_EXIST_GUIDANCE: str = (
    "Both directories already exist — write to them directly with the Write tool "
    "(do not run mkdir or check for their existence)."
)

# -- ## Types of memory — TYPES_SECTION_INDIVIDUAL (memoryTypes.ts:113-177)

TYPES_SECTION: list[str] = [
    "## Types of memory",
    "",
    "There are several discrete types of memory that you can store in your memory system:",
    "",
    "<types>",
    "<type>",
    "    <name>user</name>",
    "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
    "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
    "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
    "    <examples>",
    "    user: I'm a data scientist investigating what logging we have in place",
    "    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]",
    "",
    "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
    "    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
    "    </examples>",
    "</type>",
    "<type>",
    "    <name>feedback</name>",
    "    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>",
    "    <when_to_save>Any time the user corrects your approach (\"no not that\", \"don't\", \"stop doing X\") OR confirms a non-obvious approach worked (\"yes exactly\", \"perfect, keep doing that\", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>",
    "    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>",
    "    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>",
    "    <examples>",
    "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
    "    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]",
    "",
    "    user: stop summarizing what you just did at the end of every response, I can read the diff",
    "    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]",
    "",
    "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
    "    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]",
    "    </examples>",
    "</type>",
    "<type>",
    "    <name>project</name>",
    "    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>",
    "    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., \"Thursday\" → \"2026-03-05\"), so the memory remains interpretable after time passes.</when_to_save>",
    "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
    "    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>",
    "    <examples>",
    "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
    "    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]",
    "",
    "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
    "    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]",
    "    </examples>",
    "</type>",
    "<type>",
    "    <name>reference</name>",
    "    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>",
    "    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>",
    "    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>",
    "    <examples>",
    '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
    '    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
    "",
    "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
    '    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]',
    "    </examples>",
    "</type>",
    "</types>",
    "",
]

# -- ## What NOT to save in memory — WHAT_NOT_TO_SAVE_SECTION (memoryTypes.ts:183-194)

WHAT_NOT_TO_SAVE_SECTION: list[str] = [
    "## What NOT to save in memory",
    "",
    "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
    "- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
    "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
    "- Anything already documented in CLAUDE.md files.",
    "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
    "",
    "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
]

# -- ## When to access memories — WHEN_TO_ACCESS_SECTION (memoryTypes.ts:216-222)

MEMORY_DRIFT_CAVEAT: str = (
    "- Memory records can become stale over time. Use memory as context for what was true "
    "at a given point in time. Before answering the user or building assumptions based "
    "solely on information in memory records, verify that the memory is still correct and "
    "up-to-date by reading the current state of the files or resources. If a recalled "
    "memory conflicts with current information, trust what you observe now — and update "
    "or remove the stale memory rather than acting on it."
)

WHEN_TO_ACCESS_SECTION: list[str] = [
    "## When to access memories",
    "- When memories seem relevant, or the user references prior-conversation work.",
    "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
    "- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
    MEMORY_DRIFT_CAVEAT,
]

# -- ## Before recommending from memory — TRUSTING_RECALL_SECTION (memoryTypes.ts:240-256)

TRUSTING_RECALL_SECTION: list[str] = [
    "## Before recommending from memory",
    "",
    "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
    "",
    "- If the memory names a file path: check the file exists.",
    "- If the memory names a function or flag: grep for it.",
    "- If the user is about to act on your recommendation (not just asking about history), verify first.",
    "",
    '"The memory says X exists" is not the same as "X exists now."',
    "",
    "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
]

# -- Frontmatter 格式示例 — MEMORY_FRONTMATTER_EXAMPLE (memoryTypes.ts:261-271)

MEMORY_FRONTMATTER_EXAMPLE: list[str] = [
    '```markdown',
    '---',
    'name: {{short-kebab-case-slug}}',
    'description: {{one-line summary — used to decide relevance in future conversations, so be specific}}',
    'type: user',
    '---',
    '',
    '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
    '```',
]


# ======================================================================
# 1. build_memory_lines — 基于 memdir 模式的 buildMemoryLines
# ======================================================================

def build_memory_lines(
    display_name: str,
    memory_dir: str,
    extra_guidelines: list[str] | None = None,
    skip_index: bool = False,
) -> list[str]:
    """Build the typed-memory behavioral instructions (without MEMORY.md content).

    逐行memdir.ts buildMemoryLines() (lines 199-266)。

    Args:
        display_name: Section heading name (e.g. "auto memory").
        memory_dir: Absolute path to the memory directory.
        extra_guidelines: Optional additional guideline lines to append.
        skip_index: If True, omit Step 2 / MEMORY.md pointer instructions.

    Returns:
        List of lines forming the memory system prompt.
    """
    if skip_index:
        how_to_save: list[str] = [
            "## How to save memories",
            "",
            "Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
            "",
            *MEMORY_FRONTMATTER_EXAMPLE,
            "",
            "- Keep the name, description, and type fields in memory files up-to-date with the content",
            "- Organize memory semantically by topic, not chronologically",
            "- Update or remove memories that turn out to be wrong or outdated",
            "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
        ]
    else:
        how_to_save = [
            "## How to save memories",
            "",
            "Saving a memory is a two-step process:",
            "",
            "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
            "",
            *MEMORY_FRONTMATTER_EXAMPLE,
            "",
            f"**Step 2** — add a pointer to that file in `{ENTRYPOINT_NAME}`. `{ENTRYPOINT_NAME}` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `{ENTRYPOINT_NAME}`.",
            "",
            f"- `{ENTRYPOINT_NAME}` is always loaded into your conversation context — lines after {MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise",
            "- Keep the name, description, and type fields in memory files up-to-date with the content",
            "- Organize memory semantically by topic, not chronologically",
            "- Update or remove memories that turn out to be wrong or outdated",
            "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
        ]

    lines: list[str] = [
        f"# {display_name}",
        "",
        f"You have a persistent, file-based memory system at `{memory_dir}`. {DIR_EXISTS_GUIDANCE}",
        "",
        "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
        "",
        "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
        "",
        *TYPES_SECTION,
        *WHAT_NOT_TO_SAVE_SECTION,
        "",
        *how_to_save,
        "",
        *WHEN_TO_ACCESS_SECTION,
        "",
        *TRUSTING_RECALL_SECTION,
        "",
        "## Memory and other forms of persistence",
        "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
        "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
        "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
        "",
        *(extra_guidelines or []),
        "",
    ]

    lines.extend(build_searching_past_context_section(memory_dir))

    return lines


# ======================================================================
# 2. build_searching_past_context_section — 基于 memdir 模式
# ======================================================================

def build_searching_past_context_section(memory_dir: str) -> list[str]:
    """Build the "Searching past context" section.

    memdir.ts buildSearchingPastContextSection() (lines 375-407)。
    使用通用的 Grep tool 命令。
    """
    mem_search = f'Grep tool with pattern="<search term>" path="{memory_dir}" glob="*.md"'
    return [
        "## Searching past context",
        "",
        "When looking for past context:",
        "1. Search topic files in your memory directory:",
        "```",
        mem_search,
        "```",
        "2. Session transcript logs (last resort — large files, slow):",
        "```",
        f'Grep tool with pattern="<search term>" path="<project_root>/" glob="*.jsonl"',
        "```",
        "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
        "",
    ]


# ======================================================================
# 3. build_memory_mechanics_prompt — 记忆系统机械学说明
# ======================================================================

# Jinja2 模板：记忆系统 prompt 末尾的 MEMORY.md 区块
# 静态文本（TYPES_SECTION、WHAT_NOT_TO_SAVE 等）保持原样，只将参数化拼接部分模板化。
_MEMORY_MECHANICS_TEMPLATE = Template("""\
{{ base_content }}

## {{ entrypoint_name }}

{%- if memory_index_content.strip() %}
{{ memory_index_content }}
{%- else %}
Your {{ entrypoint_name }} is currently empty. When you save new memories, they will appear here.
{%- endif %}""")


def build_memory_mechanics_prompt(memory_index_content: str = "") -> str:
    """构建完整的记忆系统说明 prompt 片段。

    基于 build_memory_lines() 构建基础 prompt，并在末尾追加 MEMORY.md
    索引内容（如果 memory_index_content 非空）。

    Args:
        memory_index_content: 已截断的 MEMORY.md 内容。如果非空，追加
                              "## MEMORY.md" 区块。

    Returns:
        格式化的记忆系统说明文本。始终以 "# auto memory" 开头。
    """
    lines = build_memory_lines(
        display_name="auto memory",
        memory_dir=".geoagent/memory/",
    )

    return _MEMORY_MECHANICS_TEMPLATE.render(
        base_content="\n".join(lines),
        entrypoint_name=ENTRYPOINT_NAME,
        memory_index_content=memory_index_content,
    )


# ======================================================================
# 4. build_user_context — 用户环境上下文
# ======================================================================

async def build_user_context(
    workdir: str = "",
    platform: str = "linux",
    date_str: str = "",
    user_name: str = "",
) -> str:
    """构建用户上下文消息。

    生成一个 <user-context> XML 标签块，包含工作目录、操作系统、
    当前日期和用户名称等环境信息。

    Args:
        workdir: 当前工作目录路径。为空时自动从 os.getcwd() 获取。
        platform: 操作系统标识。默认 "linux"。
        date_str: 当前日期字符串（如 "2026-06-01"）。
        user_name: 用户名（可选）。

    Returns:
        格式化的 <user-context> 字符串。
    """
    resolved_workdir = workdir or os.getcwd()
    resolved_date = date_str or ""

    parts: list[str] = ["<user-context>"]
    parts.append(f"Working directory: {resolved_workdir}")
    parts.append(f"Operating system: {platform}")
    if resolved_date:
        parts.append(f"Current date: {resolved_date}")
    if user_name:
        parts.append(f"User: {user_name}")
    parts.append("</user-context>")

    return "\n".join(parts)


# ======================================================================
# 5. build_system_context — 系统上下文
# ======================================================================

def build_system_context(date_str: str = "") -> str:
    """构建系统上下文字符串，追加到系统 prompt 尾部。

    Args:
        date_str: 当前日期字符串（如 "2026-06-01"）。

    Returns:
        追加到系统 prompt 尾部的上下文字符串。
        如果 date_str 为空，返回空字符串。
    """
    if not date_str:
        return ""
    return f"\n\n[Current Date]\n{date_str}"


# ======================================================================
# 6. fetch_system_prompt_parts — 统一入口
# ======================================================================

@dataclass
class SystemPromptParts:
    """系统 prompt 的组成部分。

    由 fetch_system_prompt_parts() 统一组装，供 supervisor 构建 instructions 时使用。

    Attributes:
        default_system_prompt: 从 supervisor_config 读取的默认系统 prompt。
        memory_mechanics: 记忆系统说明文本（build_memory_mechanics_prompt 的输出）。
        memory_index: MEMORY.md 索引内容（截断版，不超过 200 行 / 25KB）。
        user_context: 用户环境上下文（<user-context> 块）。
        system_context: 系统上下文（日期/平台等，追加到 prompt 尾部）。
        tool_descriptions: 工具描述文本（可在后续步骤拼接，初始为空）。
    """
    default_system_prompt: str = ""
    memory_mechanics: str = ""
    memory_index: str = ""
    user_context: str = ""
    system_context: str = ""
    tool_descriptions: str = ""


async def fetch_system_prompt_parts(
    supervisor_config: Any,
    memory_base_dir: Path | None = None,
    project_root: Path | None = None,
    workdir: str = "",
) -> SystemPromptParts:
    """统一组装系统 prompt 的所有组成部分。

    这是 prompt_builder 的核心入口。

    Args:
        supervisor_config: supervisor 运行时配置对象。
        memory_base_dir: 记忆存储基础目录的 Path 对象。
        project_root: 项目根目录路径。
        workdir: 当前工作目录路径。

    Returns:
        包含所有 prompt 组成部分的 SystemPromptParts 实例。
    """
    # ---- 第 1 步：读取默认系统 prompt ----
    default_prompt: str = ""
    if supervisor_config is not None:
        if hasattr(supervisor_config, "system_prompt"):
            default_prompt = getattr(supervisor_config, "system_prompt", "")
        elif isinstance(supervisor_config, dict):
            default_prompt = supervisor_config.get("system_prompt", "")

    # ---- 第 2 步：构建记忆系统相关部分 ----
    memory_mechanics: str = ""
    memory_index_content: str = ""
    memory_loaded: bool = False

    if memory_base_dir is not None and memory_base_dir.exists():
        index_path = memory_base_dir / "MEMORY.md"
        if index_path.exists():
            try:
                content = index_path.read_text(encoding="utf-8")
                # 先按行截断
                lines = content.splitlines()
                if len(lines) > _MEMORY_INDEX_MAX_LINES:
                    lines = lines[:_MEMORY_INDEX_MAX_LINES]
                    lines.append(
                        f"\n[... 索引已截断，仅显示前 {_MEMORY_INDEX_MAX_LINES} 行 ...]"
                    )
                truncated = "\n".join(lines)
                # 再按字节截断
                if len(truncated.encode("utf-8")) > _MEMORY_INDEX_MAX_BYTES:
                    truncated = truncated[:_MEMORY_INDEX_MAX_BYTES] + (
                        "\n\n[... 索引内容超过 25KB，已截断 ...]"
                    )
                memory_index_content = truncated
                memory_loaded = True
            except (OSError, UnicodeDecodeError) as exc:
                logger.warning("读取 MEMORY.md 失败: %s", exc)

    memory_mechanics = build_memory_mechanics_prompt(
        memory_index_content=memory_index_content
    )

    if not memory_loaded:
        memory_mechanics += (
            "\n\n## 记忆系统状态\n\n"
            "- 当前会话没有加载任何持久记忆。\n"
            "- 如果用户提供了新的信息，你可以按照上述步骤创建新的记忆文件。\n"
        )

    # ---- 第 3 步：构建用户上下文和系统上下文 ----
    os_platform: str = _platform.system().lower() or "linux"
    date_str: str = ""

    user_context: str = await build_user_context(
        workdir=workdir or str(project_root or Path.cwd()),
        platform=os_platform,
        date_str=date_str,
    )

    system_context: str = build_system_context(date_str=date_str)

    # ---- 第 4 步：组装并返回 ----
    return SystemPromptParts(
        default_system_prompt=default_prompt,
        memory_mechanics=memory_mechanics,
        memory_index=memory_index_content,
        user_context=user_context,
        system_context=system_context,
        tool_descriptions="",
    )


# ======================================================================
# 7. create_tool_use_summary — 工具使用摘要
# ======================================================================

@dataclass
class ToolUseSummaryResult:
    """工具使用摘要统计结果。

    Attributes:
        summary_text: 人类可读的工具使用摘要。
        tool_usage: 每种工具的调用次数映射。
        total_calls: 所有工具的总调用次数。
        total_tokens_approx: 基于工具调用次数和平均 token 消耗的估算总 token 数。
    """
    summary_text: str = ""
    tool_usage: dict[str, int] = field(default_factory=dict)
    total_calls: int = 0
    total_tokens_approx: int = 0


_AVG_TOKENS_PER_TOOL_CALL: int = 300


def create_tool_use_summary(
    tool_results: list | None = None,
    budget_tracker: Any | None = None,
) -> ToolUseSummaryResult:
    """从 run 的工具结果列表生成使用摘要。

    Args:
        tool_results: run 的工具执行结果列表。
        budget_tracker: Token 预算追踪器（可选）。

    Returns:
        ToolUseSummaryResult 实例。
    """
    if not tool_results:
        return ToolUseSummaryResult(
            summary_text="本轮未执行任何工具调用。",
            tool_usage={},
            total_calls=0,
            total_tokens_approx=0,
        )

    usage: dict[str, int] = {}
    for item in tool_results:
        if hasattr(item, "tool"):
            tool_name = str(getattr(item, "tool", "unknown_tool"))
        elif isinstance(item, dict):
            tool_name = str(item.get("tool", "unknown_tool"))
        else:
            tool_name = "unknown_tool"
        usage[tool_name] = usage.get(tool_name, 0) + 1

    total = sum(usage.values())
    tool_parts: list[str] = []
    sorted_tools = sorted(usage.items(), key=lambda x: -x[1])
    for name, count in sorted_tools:
        tool_parts.append(f"{name}（{count}次）")

    summary = f"工具调用统计：{'，'.join(tool_parts)}"

    token_approx: int = 0
    if budget_tracker is not None and hasattr(budget_tracker, "total_token_used"):
        try:
            token_approx = int(getattr(budget_tracker, "total_token_used", 0))
        except (ValueError, TypeError):
            token_approx = total * _AVG_TOKENS_PER_TOOL_CALL
    else:
        token_approx = total * _AVG_TOKENS_PER_TOOL_CALL

    return ToolUseSummaryResult(
        summary_text=summary,
        tool_usage=usage,
        total_calls=total,
        total_tokens_approx=token_approx,
    )


# ======================================================================
# 8. PromptType + as_system_prompt — 类型标记
# ======================================================================

class PromptType(Enum):
    """系统提示类型标记。

    Attributes:
        SYSTEM: 标准的系统提示（角色定义、约束规则）。
        USER: 用户上下文信息（环境、平台、日期）。
        MEMORY: 记忆系统相关提示（记忆机械学说明、索引内容）。
        TOOL_DESCRIPTION: 工具描述文本。
    """
    SYSTEM = "system"
    USER = "user"
    MEMORY = "memory"
    TOOL_DESCRIPTION = "tool_description"


def as_system_prompt(
    text: str,
    prompt_type: PromptType = PromptType.SYSTEM,
) -> str:
    """包装文本为系统提示格式。

    Args:
        text: 提示文本内容。
        prompt_type: 提示类型枚举值，用于语义标记。

    Returns:
        包装后的提示文本（当前为纯文本）。
    """
    if not text:
        return ""

    logger.debug(
        "as_system_prompt: type=%s, length=%d chars",
        prompt_type.value,
        len(text),
    )

    return text
