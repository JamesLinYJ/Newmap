# +-------------------------------------------------------------------------
#
#   地理智能平台 - 技能解析器 (Skill Parser)
#
#   文件:       skills.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 支持 SKILL.md（Markdown + YAML frontmatter）格式的技能文件发现、加载、
# 路径模式匹配和 prompt 注入。
#
# 核心数据流:
#   文件系统 SKILL.md → parse_skill_frontmatter_fields() → create_skill_command()
#   → Command(含 get_prompt) → supervisor instructions 注入
#
# 条件触发:
#   技能可声明 paths: ["*.nc","data/*"]。当 Agent 操作匹配文件路径时，
#   SkillManager.match_skills_by_paths() 返回激活的技能列表，
#   其 prompt 被注入到 supervisor instructions 中。

from __future__ import annotations

import logging
import time
from wcmatch import glob

import yaml
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------

SKILL_FILENAME: str = "SKILL.md"
"""技能文件名 — 每个技能目录下必须有此文件（大小写敏感）。"""

# Frontmatter 分隔符与解析限制
_FM_DELIMITER: str = "---"
_MAX_FM_LINES: int = 200
"""解析 frontmatter 的最大行数，防恶意文件消耗资源。"""

# Frontmatter 已知字段（用于类型安全解析）
_NO_FRONTMATTER_KEYS: frozenset[str] = frozenset({
    "name",
    "description",
    "allowed-tools",
    "model",
    "context",          # "inline" | "fork"
    "paths",            # gitignore 风格路径模式列表
    "argument-hint",
    "arguments",
    "when_to_use",
    "version",
    "user-invocable",
    "disable-model-invocation",
    "agent",
    "effort",
    "hooks",
    "shell",
})

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------

_LOADED_FROM_SKILLS: str = "skills"
_LOADED_FROM_COMMANDS_DEPRECATED: str = "commands_DEPRECATED"
_LOADED_FROM_PLUGIN: str = "plugin"
_LOADED_FROM_MANAGED: str = "managed"
_LOADED_FROM_BUNDLED: str = "bundled"
_LOADED_FROM_MCP: str = "mcp"


# ===================================================================
# ===================================================================

@dataclass
class SkillFrontmatter:
    """SKILL.md 的完整 YAML frontmatter 解析结果。

    字段精确对应 Agent SDK loadSkillsDir.ts parseSkillFrontmatterFields() 的
    返回值 (lines 190-207)。

    Attributes:
        name: 技能名称，从 frontmatter.name 读取。
              如果 frontmatter 中未定义，调用方应根据目录名解析。
        display_name: 用户可见的显示名称（可空，回退到 name）。
        description: 技能描述文本。
                     优先取 frontmatter.description；如果缺失，从 markdown 正文
                     首段提取。
        has_user_specified_description: description 是否由用户显式定义。
        allowed_tools: 此技能允许调用的工具白名单（工具名列表）。
                      空列表表示无限制。
        argument_hint: 参数提示文本（如 "<数据集名称或路径>"）。
        argument_names: 从 arguments 字段解析的命名参数列表。
        when_to_use: 此技能应该在什么场景下使用（供模型判断）。
        version: 技能版本号。
        model: 推荐使用的模型名称，None 表示使用默认模型。
        disable_model_invocation: 是否禁用模型调用（纯脚本技能）。
        user_invocable: 用户是否可通过 /skill-name 手动调用。
        hooks: 此技能绑定的事件钩子配置（dict 格式）。
        execution_context: "fork" 表示在独立子 Agent 中运行，None 表示 inline。
        agent: 指定执行的 Agent 类型标识。
        effort: 推理努力度等级（low/medium/high 或 None=默认）。
        shell: shell 执行配置（用于 !`...` 内联命令）。
        paths: 条件触发路径模式列表（gitignore 风格）。
               例如 ["*.nc", "data/*.grib2"]。
               为 None 时表示无条件技能（始终可激活）。
    """
    name: str
    display_name: str | None = None
    description: str = ""
    has_user_specified_description: bool = False
    allowed_tools: list[str] = field(default_factory=list)
    argument_hint: str | None = None
    argument_names: list[str] = field(default_factory=list)
    when_to_use: str | None = None
    version: str | None = None
    model: str | None = None
    disable_model_invocation: bool = False
    user_invocable: bool = True
    hooks: dict[str, Any] | None = None
    execution_context: str | None = None          # "fork" or None (=inline)
    agent: str | None = None
    effort: str | None = None                     # "low" | "medium" | "high"
    shell: dict[str, Any] | None = None
    paths: list[str] | None = None


# ===================================================================
# 2. 技能命令 — 对应 Agent SDK Command 类型
# ===================================================================

@dataclass
class SkillCommand:
    """从 SKILL.md 构建的运行时技能命令。

    对应 Agent SDK createSkillCommand() 的返回值 (Command type, lines 317-399)。

    Methods:
        get_prompt(args, tool_context): 返回技能 prompt 的正文内容。
            如果声明了 base_dir，会前置 "Base directory for this skill: ..."。
            支持 ${ARG_NAME} 参数替换。
    """
    name: str
    """技能唯一名称（snake_case）。"""
    description: str
    """人类可读描述。"""
    allowed_tools: list[str] = field(default_factory=list)
    """此技能允许使用的工具白名单。"""
    argument_hint: str | None = None
    """参数提示文本。"""
    when_to_use: str | None = None
    """模型判断是否激活此技能的依据。"""
    content: str = ""
    """SKILL.md 的正文内容（不含 frontmatter）。"""
    base_dir: str | None = None
    """技能文件所在的目录路径。在 prompt 中前置 "Base directory for this skill: <dir>"。"""
    model: str | None = None
    """推荐模型。"""
    disable_model_invocation: bool = False
    """是否禁用模型调用。"""
    user_invocable: bool = True
    """是否可通过 / 命令调用。"""
    execution_context: str | None = None
    """执行上下文：'fork'=独立子Agent，None=inline。"""
    agent: str | None = None
    """指定执行的 Agent 类型。"""
    paths: list[str] | None = None
    """条件触发路径模式。"""
    version: str | None = None
    """版本号。"""
    source: str = "skills"
    """来源标识（skills / commands_DEPRECATED / plugin / managed / bundled / mcp）。"""

    def get_prompt(self, args: str = "", tool_context: dict[str, Any] | None = None) -> str:
        """生成注入到 supervisor instructions 的 prompt 文本。

        Args:
            args: 传递给技能的参数字符串。
            tool_context: 工具执行上下文（预留，当前未使用）。

        Returns:
            格式化的技能 prompt 文本。
        """
        content = self.content

        # ---- 前置 base_dir 声明 ----
        # "Base directory for this skill: <dir>" 提示模型可通过 Read/Grep
        # 按需访问技能目录中的引用文件。
        if self.base_dir:
            content = f"Base directory for this skill: {self.base_dir}\n\n{content}"

        # ---- 参数替换 —— ${ARG_NAME} → 实际值 ----
        if args and self.argument_names:
            content = _substitute_arguments(content, args, self.argument_names)

        return content


# ===================================================================
# ===================================================================

def parse_frontmatter_yaml(raw_text: str) -> dict[str, Any]:
    """从 SKILL.md 原始文本中解析 YAML frontmatter。使用 PyYAML。

    Args:
        raw_text: SKILL.md 文件的完整原始文本内容。

    Returns:
        解析出的 frontmatter 键值对字典。无效或缺失 frontmatter 时返回空字典。
    """
    # WHY: 先定位 --- 分隔符提取 YAML 块，再委托 PyYAML 安全解析。
    #       不信任 frontmatter 内容，所以必须用 safe_load 而非全功能 load。
    lines = raw_text.splitlines()
    if not lines or lines[0].strip() != _FM_DELIMITER:
        return {}

    end = 1
    while end < len(lines) and end < _MAX_FM_LINES and lines[end].strip() != _FM_DELIMITER:
        end += 1
    if end >= len(lines):
        return {}

    fm_text = '\n'.join(lines[1:end])
    try:
        result = yaml.safe_load(fm_text) or {}
        return result if isinstance(result, dict) else {}
    except yaml.YAMLError:
        return {}


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------

def parse_skill_frontmatter_fields(
    frontmatter: dict[str, Any],
    markdown_content: str,
    resolved_name: str,
    description_fallback_label: str = "Skill",
) -> SkillFrontmatter:
    """解析技能 frontmatter 的所有共享字段。


    Args:
        frontmatter: parse_frontmatter_yaml() 的解析结果。
        markdown_content: SKILL.md 的正文内容（不含 frontmatter）。
        resolved_name: 技能的唯一名称（通常从目录名解析）。
        description_fallback_label: 当 description 缺失时，用于从 markdown 提取
                                    摘要的标签名（默认 "Skill"）。

    Returns:
        SkillFrontmatter 实例，所有字段已解析并验证。
    """
    # ---- description ----
    # 优先取 frontmatter.description；缺失时从 markdown 正文提取首段
    raw_desc = frontmatter.get("description", "")
    if raw_desc and isinstance(raw_desc, str) and raw_desc.strip():
        description = raw_desc.strip()
        has_user_specified = True
    else:
        description = _extract_description_from_markdown(
            markdown_content, description_fallback_label
        )
        has_user_specified = False

    # ---- user-invocable ----
    # 默认为 True；显式 "false" 时隐藏
    user_invocable_raw = frontmatter.get("user-invocable", True)
    if isinstance(user_invocable_raw, bool):
        user_invocable = user_invocable_raw
    elif isinstance(user_invocable_raw, str):
        user_invocable = user_invocable_raw.lower() != "false"
    else:
        user_invocable = True

    # ---- model ----
    # "inherit" → None（继承主模型）；其他字符串 → 模型名
    model_raw = frontmatter.get("model")
    if model_raw is None or model_raw == "inherit":
        model = None
    elif isinstance(model_raw, str):
        model = model_raw
    else:
        model = None

    # ---- allowed-tools ----
    allowed_raw = frontmatter.get("allowed-tools", [])
    if isinstance(allowed_raw, list):
        allowed_tools = [str(t) for t in allowed_raw if t]
    elif isinstance(allowed_raw, str):
        allowed_tools = [t.strip() for t in allowed_raw.split(",") if t.strip()]
    else:
        allowed_tools = []

    # ---- paths ----
    # 逐行 split，移除 /** 后缀，过滤纯 **
    paths_raw = frontmatter.get("paths")
    if isinstance(paths_raw, list):
        paths = _normalize_skill_paths([str(p) for p in paths_raw])
    elif isinstance(paths_raw, str):
        paths = _normalize_skill_paths(
            [p.strip() for p in paths_raw.splitlines() if p.strip()]
        )
    else:
        paths = None

    # ---- context ----
    # "fork" → execution_context="fork"；否则 None(=inline)
    ctx_raw = frontmatter.get("context", "inline")
    execution_context = "fork" if str(ctx_raw) == "fork" else None

    # ---- effort ----
    effort_raw = frontmatter.get("effort")
    effort = str(effort_raw) if effort_raw is not None and effort_raw != "" else None

    # ---- disable-model-invocation ----
    dmi_raw = frontmatter.get("disable-model-invocation", False)
    disable_model = _coerce_bool(dmi_raw)

    return SkillFrontmatter(
        name=resolved_name,
        display_name=str(frontmatter.get("name", "")) or None,
        description=description,
        has_user_specified_description=has_user_specified,
        allowed_tools=allowed_tools,
        argument_hint=str(frontmatter["argument-hint"]).strip() or None
            if frontmatter.get("argument-hint") else None,
        argument_names=_parse_argument_names(
            frontmatter.get("arguments")
        ),
        when_to_use=str(frontmatter["when_to_use"]).strip() or None
            if frontmatter.get("when_to_use") else None,
        version=str(frontmatter["version"]).strip() or None
            if frontmatter.get("version") else None,
        model=model,
        disable_model_invocation=disable_model,
        user_invocable=user_invocable,
        hooks=frontmatter.get("hooks"),
        execution_context=execution_context,
        agent=str(frontmatter["agent"]).strip() or None
            if frontmatter.get("agent") else None,
        effort=effort,
        shell=frontmatter.get("shell"),
        paths=paths,
    )


# ===================================================================
# ===================================================================

def create_skill_command(
    *,
    skill_name: str,
    display_name: str | None,
    description: str,
    has_user_specified_description: bool,
    markdown_content: str,
    allowed_tools: list[str],
    argument_hint: str | None,
    argument_names: list[str],
    when_to_use: str | None,
    version: str | None,
    model: str | None,
    disable_model_invocation: bool,
    user_invocable: bool,
    source: str,
    base_dir: str | None,
    loaded_from: str,
    hooks: dict[str, Any] | None,
    execution_context: str | None,
    agent: str | None,
    paths: list[str] | None,
    effort: str | None,
    shell: dict[str, Any] | None = None,
) -> SkillCommand:
    """从已解析的技能数据创建 SkillCommand 实例。


    Returns:
        一个 SkillCommand 实例，name 为 skill_name。
    """
    return SkillCommand(
        name=skill_name,
        description=description,
        allowed_tools=allowed_tools,
        argument_hint=argument_hint,
        when_to_use=when_to_use,
        content=markdown_content,
        base_dir=base_dir,
        model=model,
        disable_model_invocation=disable_model_invocation,
        user_invocable=user_invocable,
        execution_context=execution_context,
        agent=agent,
        paths=paths,
        version=version,
        source=source,
    )


# ===================================================================
# 5. 路径模式匹配 — 使用 wcmatch.globmatch (GLOBSTAR)
# ===================================================================

def _normalize_skill_paths(raw_patterns: list[str]) -> list[str] | None:
    """规范化技能路径模式列表。

    - 移除末尾的 /** 后缀
    - 过滤空字符串和纯 **（match-all）
    - 如果所有模式都是 match-all，返回 None
    """
    patterns: list[str] = []
    for p in raw_patterns:
        p = p.strip()
        if p.endswith("/**"):
            p = p[:-3]
        if p and p != "**":
            patterns.append(p)

    if not patterns:
        return None
    return patterns


def match_gitignore_pattern(pattern: str, file_path: str) -> bool:
    """gitignore 风格的路径模式匹配。使用 wcmatch。

    支持的模式:
    - `*.nc`        → 匹配根层的 .nc 文件
    - `**/*.nc`     → 匹配任意深度的 .nc 文件
    - `data/*.h5`   → 匹配 data/ 目录下的 .h5 文件
    - `**/weather/` → 匹配任意深度的 weather/ 目录


    # WHY: 替换手写的 fnmatch + path split 逻辑为 wcmatch.globmatch。
    #       GLOBSTAR 标志启用 ** 跨目录匹配，与 gitignore 语义一致。

    Args:
        pattern: gitignore 风格的模式字符串。
        file_path: 被匹配的文件路径（相对路径或绝对路径）。

    Returns:
        是否匹配。
    """
    return glob.globmatch(file_path, pattern, flags=glob.GLOBSTAR)


def match_skills_by_paths(
    skills: list[SkillCommand],
    file_paths: list[str],
) -> list[SkillCommand]:
    """根据文件路径匹配可激活的条件技能。

    Args:
        skills: 所有已加载的技能列表。
        file_paths: 被 Agent 操作过的文件路径列表。

    Returns:
        匹配到的技能列表（按名称去重，保持首次匹配顺序）。
    """
    matched: list[SkillCommand] = []
    seen: set[str] = set()

    for fp in file_paths:
        for skill in skills:
            if not skill.paths:
                continue
            if skill.name in seen:
                continue
            for pattern in skill.paths:
                if match_gitignore_pattern(pattern, fp):
                    matched.append(skill)
                    seen.add(skill.name)
                    break

    return matched


# ===================================================================
# 6. SkillManager — 技能发现、加载与缓存
# ===================================================================

class SkillManager:
    """技能管理器 — 从多个目录发现和加载 SKILL.md。

    支持:
    - 多目录递归扫描
    - 条件技能（带 paths frontmatter）的路径匹配激活
    - 同名技能去重（后发现的覆盖先发现的）
    - 内存缓存 + 热重载

    使用示例:
        manager = SkillManager([
            Path(".geoagent/skills"),
            Path.home() / ".geoagent/skills",
        ])
        skills = manager.list_all()
        # 按文件路径匹配
        active = manager.match_skills_by_paths(["test.nc", "output.png"])
    """

    def __init__(self, skill_dirs: list[Path]):
        """初始化技能管理器。

        Args:
            skill_dirs: 要扫描的技能目录列表。目录不存在不会报错（静默跳过）。
        """
        self._skill_dirs: list[Path] = [d.resolve() for d in skill_dirs]
        self._skills: dict[str, SkillCommand] = {}
        """按 name 索引的技能缓存。"""
        self._frontmatter_cache: dict[str, SkillFrontmatter] = {}
        """按 name 索引的 frontmatter 缓存。"""
        self._last_scan_time: float = 0.0
        """上次扫描的时间戳，用于热重载判断。"""

    # ------------------------------------------------------------------
    # 公共 API
    # ------------------------------------------------------------------

    def discover_skills(self) -> list[SkillCommand]:
        """递归扫描所有 skill_dirs，发现并加载 SKILL.md 文件。


        扫描策略:
        1. 遍历每个 skill_dir
        2. 对每个子目录递归查找 SKILL.md
        3. 解析 frontmatter → 构建 SkillCommand
        4. 同名技能以后发现的覆盖先发现的（深层目录覆盖浅层）
        5. 结果缓存在内存中

        Returns:
            所有已发现的技能（SkillCommand 列表），按名称排序。
        """
        now = time.time()
        # ---- 简单时间戳缓存（热重载） ----
        if self._skills and (now - self._last_scan_time) < 30:
            return sorted(self._skills.values(), key=lambda s: s.name)

        self._skills.clear()
        self._frontmatter_cache.clear()

        for directory in self._skill_dirs:
            if not directory.exists() or not directory.is_dir():
                continue
            self._scan_directory(directory, directory)

        self._last_scan_time = now
        return sorted(self._skills.values(), key=lambda s: s.name)

    def list_all(self) -> list[SkillCommand]:
        """返回所有已加载的技能（调用 discover_skills() 的内部缓存结果）。"""
        return self.discover_skills()

    def reload(self) -> int:
        """强制重新扫描所有目录。返回加载的技能总数。"""
        self._skills.clear()
        self._frontmatter_cache.clear()
        self._last_scan_time = 0.0
        return len(self.discover_skills())

    def get_skill(self, name: str) -> SkillCommand | None:
        """按名称查找技能。

        Args:
            name: 技能名称（SKILL.md 所在目录的目录名或 frontmatter 声明的 name）。

        Returns:
            SkillCommand 或 None。
        """
        self.discover_skills()
        return self._skills.get(name)

    def get_skill_prompt(self, name: str, args: str = "") -> str | None:
        """按名称获取技能的 prompt 正文。

        Args:
            name: 技能名称。
            args: 参数（可选）。

        Returns:
            prompt 文本或 None。
        """
        skill = self.get_skill(name)
        if skill is None:
            return None
        return skill.get_prompt(args)

    def match_skills_by_paths(self, file_paths: list[str]) -> list[SkillCommand]:
        """根据文件路径匹配条件触发技能。

        Args:
            file_paths: 被操作的文件路径列表。

        Returns:
            匹配到的技能列表。
        """
        all_skills = self.list_all()
        return match_skills_by_paths(all_skills, file_paths)

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    def _scan_directory(self, directory: Path, skill_root: Path) -> None:
        """递归扫描一个目录，寻找 SKILL.md 文件。

        Args:
            directory: 当前扫描的目录。
            skill_root: 技能根目录（用于确定 base_dir）。
        """
        try:
            for item in sorted(directory.iterdir()):
                if not item.is_dir():
                    continue
                skill_file = item / SKILL_FILENAME
                if skill_file.exists() and skill_file.is_file():
                    self._load_skill_file(skill_file, skill_file.parent)
                else:
                    # 递归扫描子目录
                    self._scan_directory(item, skill_root)
        except (OSError, PermissionError) as exc:
            logger.warning("无法扫描技能目录 %s: %s", directory, exc)

    def _load_skill_file(self, file_path: Path, base_dir: Path) -> None:
        """加载单个 SKILL.md 文件。

        解析 frontmatter → 构建 SkillCommand → 存入缓存。
        如果有同名技能已存在，会被覆盖（深层目录优先）。

        Args:
            file_path: SKILL.md 文件的完整路径。
            base_dir: 技能文件所在的目录路径（用作 base_dir）。
        """
        try:
            raw = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            logger.warning("无法读取技能文件 %s: %s", file_path, exc)
            return

        # ---- 提取正文（去 frontmatter） ----
        body = _strip_frontmatter(raw)
        frontmatter = parse_frontmatter_yaml(raw)

        # ---- 解析技能名称 ----
        name = frontmatter.get("name", "")
        if not isinstance(name, str) or not name.strip():
            name = base_dir.name
        name = str(name).strip()

        # ---- 解析所有字段 ----
        fm = parse_skill_frontmatter_fields(frontmatter, body, name)

        # ---- 构建 SkillCommand ----
        cmd = create_skill_command(
            skill_name=name,
            display_name=fm.display_name,
            description=fm.description,
            has_user_specified_description=fm.has_user_specified_description,
            markdown_content=body,
            allowed_tools=fm.allowed_tools,
            argument_hint=fm.argument_hint,
            argument_names=fm.argument_names,
            when_to_use=fm.when_to_use,
            version=fm.version,
            model=fm.model,
            disable_model_invocation=fm.disable_model_invocation,
            user_invocable=fm.user_invocable,
            source="skills",
            base_dir=str(base_dir.resolve()),
            loaded_from=_LOADED_FROM_SKILLS,
            hooks=fm.hooks,
            execution_context=fm.execution_context,
            agent=fm.agent,
            paths=fm.paths,
            effort=fm.effort,
            shell=fm.shell,
        )

        self._skills[name] = cmd
        self._frontmatter_cache[name] = fm

        logger.debug(
            "已加载技能: name=%s description=%s base_dir=%s paths=%s",
            name,
            fm.description[:60] if fm.description else "(无描述)",
            base_dir,
            fm.paths,
        )


# ===================================================================
# 辅助函数
# ===================================================================

def _strip_frontmatter(raw: str) -> str:
    """从 SKILL.md 原始文本中移除 YAML frontmatter，返回正文。

    Args:
        raw: 完整的文件内容。

    Returns:
        去除 frontmatter (--- ... ---) 后的正文文本。
    """
    lines = raw.splitlines()
    if not lines or lines[0].strip() != _FM_DELIMITER:
        return raw

    for i in range(1, min(len(lines), _MAX_FM_LINES)):
        if lines[i].strip() == _FM_DELIMITER:
            return "\n".join(lines[i + 1:]).strip()

    return raw


def _extract_description_from_markdown(content: str, label: str = "Skill") -> str:
    """从 Markdown 正文中提取首段作为描述。

    当 frontmatter 中未显式定义 description 时使用的回退策略。


    Args:
        content: Markdown 正文文本。
        label: 用于生成默认描述的标签名。

    Returns:
        提取的描述文本（≤200 字符）。
    """
    if not content.strip():
        return f"A {label.lower()} command"

    for line in content.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:200]

    return f"A {label.lower()} command"


def _coerce_bool(value: Any) -> bool:
    """将任意值安全转换为布尔类型。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() != "false"
    return bool(value)


def _parse_argument_names(raw: Any) -> list[str]:
    """解析 arguments 字段为参数名列表。

    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(a).strip() for a in raw if a]
    if isinstance(raw, str):
        return [a.strip() for a in raw.split(",") if a.strip()]
    return []


def _substitute_arguments(
    content: str, args: str, arg_names: list[str],
) -> str:
    """将 prompt 中的 ${ARG_NAME} 占位符替换为实际参数值。


    策略: 如果 args 非空，将第一个参数赋给 arg_names[0]。
    剩余的 ${ARG_NAME} 占位符保留原样（模型会自行理解）。
    """
    if not args or not arg_names:
        return content

    # 简单策略: ${arg_name} → 用户输入的 args
    for name in arg_names:
        content = content.replace(f"${{{name}}}", args)

    return content
