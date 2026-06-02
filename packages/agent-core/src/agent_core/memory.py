# +-------------------------------------------------------------------------
#
#
#   文件:       memory.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------

# 模块职责
#
# 管理 .geoagent/memory/ 目录下的用户偏好、反馈、项目上下文和外部引用。
# 包含 truncate_entrypoint_content()、MemoryHeader、MemoryManager 等。
#
# 向后兼容：MemoryManager、MemoryHeader、scan_memories()、write_memory()、
# build_prompt_context() 等公有 API 签名保持不变。

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional

import yaml

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 记忆类型常量
# ---------------------------------------------------------------------------
MEMORY_TYPE_USER: str = "user"
MEMORY_TYPE_FEEDBACK: str = "feedback"
MEMORY_TYPE_PROJECT: str = "project"
MEMORY_TYPE_REFERENCE: str = "reference"

VALID_MEMORY_TYPES: frozenset[str] = frozenset({
    MEMORY_TYPE_USER, MEMORY_TYPE_FEEDBACK, MEMORY_TYPE_PROJECT, MEMORY_TYPE_REFERENCE,
})

# ---------------------------------------------------------------------------
# 索引与存储约束（与 prompt_builder.py 的常量保持一致）
# ---------------------------------------------------------------------------
ENTRYPOINT_NAME: str = "MEMORY.md"
MAX_ENTRYPOINT_LINES: int = 200
MAX_ENTRYPOINT_BYTES: int = 25_000

MEMORY_INDEX_FILENAME: str = ENTRYPOINT_NAME           # 向后兼容别名
MEMORY_INDEX_MAX_LINES: int = MAX_ENTRYPOINT_LINES     # 向后兼容别名
MEMORY_FILE_MAX_BYTES: int = 10240                     # 单条记忆文件最大 10KB
MEMORY_MAX_DESCRIPTION_LENGTH: int = 150               # 索引摘要最大字符数

# 新鲜度标记阈值
MEMORY_FRESH_SECONDS: float = 7 * 24 * 3600       # 7 天 → [较旧]
MEMORY_STALE_SECONDS: float = 90 * 24 * 3600      # 90 天 → [可能已过期]

TEAM_MEMORY_DIR: str = "team"            # 团队记忆子目录名
_MAX_SANITIZED_LENGTH: int = 100         # 消毒路径最大长度
_MODEL_SELECT_LIMIT: int = 5             # LLM 选择记忆最大条数

# 索引条目正则: - [标题](文件名.md) — 摘要
_INDEX_LINE_PATTERN: re.Pattern = re.compile(
    r"^\s*-\s*\[(?P<title>[^\]]+)\]\s*\((?P<filename>[^)]+)\)\s*—\s*(?P<description>.+)$"
)

_FM_DELIMITER: str = "---"  # frontmatter 分界符


# ===================================================================
# 模块级工具函数
# ===================================================================


def format_file_size(bytes_count: int) -> str:
    """格式化文件大小为人类可读字符串。

    """
    if bytes_count >= 1024 * 1024:
        return f"{bytes_count / (1024 * 1024):.1f} MB"
    if bytes_count >= 1024:
        return f"{bytes_count / 1024:.1f} KB"
    return f"{bytes_count} B"


# ===================================================================
# ===================================================================

@dataclass
class EntrypointTruncation:
    """MEMORY.md 截断结果数据类。

    对应 Agent SDK memdir.ts 的 EntrypointTruncation 类型（lines 41-47）。
    """
    content: str
    line_count: int
    byte_count: int
    was_line_truncated: bool
    was_byte_truncated: bool


def truncate_entrypoint_content(raw: str) -> EntrypointTruncation:
    """Truncate MEMORY.md content to the line AND byte caps.

    Line-truncates first (natural boundary), then byte-truncates at the
    last newline before the cap so we don't cut mid-line.

    Args:
        raw: Raw MEMORY.md content.

    Returns:
        EntrypointTruncation with truncated content and metadata.
    """
    trimmed = raw.strip()
    content_lines = trimmed.split("\n")
    line_count = len(content_lines)
    byte_count = len(trimmed)

    was_line_truncated = line_count > MAX_ENTRYPOINT_LINES
    # Check original byte count — long lines are the failure mode the byte cap
    # targets, so post-line-truncation size would understate the warning.
    was_byte_truncated = byte_count > MAX_ENTRYPOINT_BYTES

    if not was_line_truncated and not was_byte_truncated:
        return EntrypointTruncation(
            content=trimmed,
            line_count=line_count,
            byte_count=byte_count,
            was_line_truncated=was_line_truncated,
            was_byte_truncated=was_byte_truncated,
        )

    truncated = (
        "\n".join(content_lines[:MAX_ENTRYPOINT_LINES])
        if was_line_truncated
        else trimmed
    )

    if len(truncated) > MAX_ENTRYPOINT_BYTES:
        cut_at = truncated.rfind("\n", 0, MAX_ENTRYPOINT_BYTES)
        truncated = truncated[:cut_at if cut_at > 0 else MAX_ENTRYPOINT_BYTES]

    if was_byte_truncated and not was_line_truncated:
        reason = (
            f"{format_file_size(byte_count)} "
            f"(limit: {format_file_size(MAX_ENTRYPOINT_BYTES)})"
            " — index entries are too long"
        )
    elif was_line_truncated and not was_byte_truncated:
        reason = f"{line_count} lines (limit: {MAX_ENTRYPOINT_LINES})"
    else:
        reason = f"{line_count} lines and {format_file_size(byte_count)}"

    return EntrypointTruncation(
        content=(
            truncated
            + f"\n\n> WARNING: {ENTRYPOINT_NAME} is {reason}. "
            "Only part of it was loaded. Keep index entries to one line "
            "under ~200 chars; move detail into topic files."
        ),
        line_count=line_count,
        byte_count=byte_count,
        was_line_truncated=was_line_truncated,
        was_byte_truncated=was_byte_truncated,
    )


# ===================================================================
# 记忆文件操作
# ===================================================================


def parse_memory_frontmatter(file_path: Path) -> dict:
    """解析记忆文件的 YAML frontmatter。使用 PyYAML。

    只解析固定字段: name, description, metadata.type（必须为合法记忆类型）。

    # WHY: 替换手写逐行解析器为 PyYAML.safe_load。
    #       PyYAML 原生处理类型转换、多行值和嵌套结构，
    #       只需在其结果上做校验即可。
    """
    if not file_path.exists() or file_path.stat().st_size == 0:
        return {}

    try:
        text = file_path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return {}

    if not text.startswith(_FM_DELIMITER):
        return {}

    end_idx = text.find(_FM_DELIMITER, len(_FM_DELIMITER))
    if end_idx == -1:
        return {}

    yaml_block = text[len(_FM_DELIMITER):end_idx]
    try:
        result = yaml.safe_load(yaml_block) or {}
    except yaml.YAMLError:
        return {}

    if not isinstance(result, dict):
        return {}

    # 校验 metadata.type 合法性
    metadata = result.get("metadata")
    memory_type = metadata.get("type") if isinstance(metadata, dict) else None
    if memory_type is not None and memory_type not in VALID_MEMORY_TYPES:
        logger.warning("metadata.type 不合法: '%s'，文件: %s", memory_type, file_path)
        return {}

    if memory_type:
        result["memory_type"] = memory_type

    return result if ("name" in result or "description" in result or "memory_type" in result) else {}


def _strip_frontmatter(text: str) -> str:
    """移除 frontmatter 块（--- 包裹的区域），只返回正文。"""
    if not text.startswith(_FM_DELIMITER):
        return text.strip()
    end_idx = text.find(_FM_DELIMITER, len(_FM_DELIMITER))
    if end_idx == -1:
        return text.strip()
    return text[end_idx + len(_FM_DELIMITER):].strip().lstrip("\n\r").strip()


def sanitize_git_root(project_root: Path) -> str:
    """消毒项目根路径用于记忆目录名。

    示例: /home/user/my-project → home-user-my-project
    """
    path_str = str(project_root.resolve()).strip("/")
    path_str = path_str.replace("/", "-")
    safe = re.sub(r"[^a-zA-Z0-9\-_\.]", "", path_str)
    return safe[:_MAX_SANITIZED_LENGTH]


def is_auto_mem_path(path: Path, memory_base: Path) -> bool:
    """检查 path 是否在 memory_base 目录内（防止路径遍历攻击）。"""
    try:
        resolved_path = path.resolve()
        resolved_base = memory_base.resolve()
        return resolved_path == resolved_base or resolved_base in resolved_path.parents
    except (OSError, ValueError):
        return False


def write_memory_file(
    name: str,
    content: str,
    memory_type: str,
    description: str,
    memory_root: Path,
) -> Path:
    """Step 1: 写入独立 .md 文件（含 YAML frontmatter）。返回文件路径。"""
    if memory_type not in VALID_MEMORY_TYPES:
        raise ValueError(f"不支持的记忆类型: '{memory_type}'。合法值: {', '.join(sorted(VALID_MEMORY_TYPES))}")
    if not name.strip():
        raise ValueError("记忆名称不能为空。")

    name_clean = name.strip()
    memory_root = memory_root.resolve()
    memory_root.mkdir(parents=True, exist_ok=True)

    frontmatter = (
        f"---\n"
        f"name: {name_clean}\n"
        f"description: {description}\n"
        f"metadata:\n"
        f"  type: {memory_type}\n"
        f"---\n"
    )

    body = content.strip()
    if body.startswith(_FM_DELIMITER):
        body = _strip_frontmatter(body)

    file_path = memory_root / f"{name_clean}.md"
    file_path.write_text(f"{frontmatter}\n{body}\n", encoding="utf-8")
    logger.info("已写入记忆文件: %s (%d 字节, type=%s)", file_path, len(body), memory_type)
    return file_path


def update_memory_index(name: str, description: str, memory_root: Path) -> None:
    """Step 2: 在 MEMORY.md 中插入或更新索引条目。"""
    index_path = (memory_root.resolve()) / ENTRYPOINT_NAME
    lines: list[str] = []
    found = False

    if index_path.exists():
        with index_path.open("r", encoding="utf-8") as f:
            lines = f.readlines()

    new_lines: list[str] = []
    for line in lines:
        parsed = _parse_index_line_strict(line)
        if parsed is not None and parsed["filename"] == f"{name}.md":
            new_lines.append(f"- [{parsed['title']}]({name}.md) — {description}\n")
            found = True
        else:
            new_lines.append(line)

    if not found:
        new_lines.append(f"- [{name}]({name}.md) — {description}\n")

    if len(new_lines) > MAX_ENTRYPOINT_LINES:
        logger.warning("记忆索引超过 %d 行，将淘汰最旧条目", MAX_ENTRYPOINT_LINES)
        new_lines = new_lines[-MAX_ENTRYPOINT_LINES:]

    index_path.write_text("".join(new_lines), encoding="utf-8")
    logger.info("已更新记忆索引: %s (%d 行)", index_path, len(new_lines))


def _parse_index_line_strict(line: str) -> Optional[dict]:
    """纯函数版索引行解析（供模块级函数使用）。"""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    match = _INDEX_LINE_PATTERN.match(stripped)
    if not match:
        return None
    return {
        "title": match.group("title").strip(),
        "filename": match.group("filename").strip(),
        "description": match.group("description").strip()[:MEMORY_MAX_DESCRIPTION_LENGTH],
    }


def load_memory_prompt(memory_base_dir: Path, project_root: Path, include_team: bool = False) -> str:
    """构建记忆系统完整 prompt 片段。

    构建记忆目录路径、读取 MEMORY.md、委托 prompt_builder 生成 Agent SDK 风格 prompt。

    Args:
        memory_base_dir: 记忆基目录。
        project_root: 项目根目录。
        include_team: 是否同时加载团队记忆。

    Returns:
        格式化的 prompt 文本。
    """
    from .prompt_builder import build_memory_mechanics_prompt, build_memory_lines

    sanitized = sanitize_git_root(project_root)
    memory_dir = memory_base_dir / "projects" / sanitized / "memory"
    team_dir = memory_dir / TEAM_MEMORY_DIR

    def _read_index(dir_path: Path) -> str:
        ip = dir_path / ENTRYPOINT_NAME
        if ip.exists():
            try:
                return ip.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                return "（读取索引失败）"
        return ""

    personal_index = _read_index(memory_dir)
    team_index = _read_index(team_dir) if include_team and team_dir.exists() else ""

    # 使用 Agent SDK 风格 prompt
    lines = build_memory_lines(
        display_name="auto memory",
        memory_dir=str(memory_dir),
    )

    # 追加个人记忆索引
    if personal_index.strip():
        t = truncate_entrypoint_content(personal_index)
        lines.append(f"## {ENTRYPOINT_NAME}")
        lines.append("")
        lines.append(t.content)
    else:
        lines.append(f"## {ENTRYPOINT_NAME}")
        lines.append("")
        lines.append(f"Your {ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.")

    # 追加团队记忆索引
    if team_index.strip():
        lines.append("")
        lines.append("## 团队记忆索引")
        lines.append("")
        lines.append(team_index)

    return "\n".join(lines)


def build_combined_memory_prompt(memory_base_dir: Path, project_root: Path) -> str:
    """同时加载个人记忆和团队记忆，构建组合 prompt。

    向后兼容包装器。
    """
    return load_memory_prompt(memory_base_dir, project_root, include_team=True)


async def select_relevant_by_model(
    query: str,
    headers: list[MemoryHeader],
    model_client,
    limit: int = _MODEL_SELECT_LIMIT,
) -> list[MemoryHeader]:
    """使用模型调用选取最相关的记忆。

    传入所有记忆的名称/描述/类型，让模型选择最相关的 ≤limit 条。
    回退策略: API 失败时退回关键词匹配；关键词无结果时返回最新 N 条。

    Args:
        query: 用户查询文本。
        headers: 候选记忆列表。
        model_client: 异步 LLM 客户端（须有 chat.completions.create）。
        limit: 最大返回条数。

    Returns:
        按相关性降序的 MemoryHeader 列表。
    """
    if not query or not headers:
        return []

    candidates = "\n".join(
        f"[{i}] name={h.name} | type={h.memory_type} | desc={h.description}"
        for i, h in enumerate(headers)
    )

    try:
        response = await model_client.chat.completions.create(
            model="claude-sonnet-4-20250514",
            messages=[
                {"role": "system", "content": "你是一个记忆检索系统。选出与用户查询最相关的记忆序号，每行一个。"},
                {"role": "user", "content": f"## 查询\n{query}\n\n## 候选\n{candidates}\n\n选{limit}条，返回序号。"},
            ],
            max_tokens=50,
            temperature=0.0,
        )

        text = response.choices[0].message.content or ""
        selected = []
        seen: set[int] = set()
        for token in text.split():
            token = token.strip("[],()")
            if token.isdigit():
                idx = int(token)
                if 0 <= idx < len(headers) and idx not in seen:
                    seen.add(idx)
                    selected.append(headers[idx])
                    if len(selected) >= limit:
                        break
        if selected:
            return selected
    except Exception as exc:
        logger.warning("LLM 记忆检索失败，回退到关键词匹配: %s", exc)

    # 回退: 关键词匹配
    q_tokens = set(re.findall(r"[a-zA-Z一-鿿]{2,}", query.lower()))
    scored: list[tuple[MemoryHeader, int]] = []
    for h in headers:
        overlap = len(q_tokens & set(re.findall(r"[a-zA-Z一-鿿]{2,}", f"{h.name} {h.description} {h.memory_type}".lower())))
        if overlap > 0:
            scored.append((h, overlap))
    scored.sort(key=lambda x: (-x[1], -x[0].mtime))
    return [h for h, _ in scored[:limit]] if scored else headers[:limit]


# ===================================================================
# MemoryHeader
# ===================================================================


@dataclass
class MemoryHeader:
    """记忆头部信息（扫描时提取）。

    Attributes:
        name: 文件名（不含 .md 后缀）
        path: 文件完整路径
        description: 单行摘要（≤ 150 字符）
        memory_type: user/feedback/project/reference
        mtime: 文件最后修改时间戳
        size_bytes: 文件大小
    """
    name: str
    path: Path
    description: str = ""
    memory_type: str = MEMORY_TYPE_REFERENCE
    mtime: float = 0.0
    size_bytes: int = 0


# ===================================================================
# MemoryManager
# ===================================================================


class MemoryManager:
    """记忆管理器 — 管理 .geoagent/memory/ 目录下的记忆生命周期。

    职责: 扫描/选择/写入/上下文构建/维护。支持团队记忆（team/ 子目录）。
    """

    def __init__(self, memory_root: Path) -> None:
        """初始化。

        Args:
            memory_root: .geoagent/memory/ 的完整路径。
        """
        self.memory_root: Path = memory_root.resolve()
        self._team_root: Path = self.memory_root / TEAM_MEMORY_DIR
        self._ensure_directories()

    # ------------------------------------------------------------------
    # 属性
    # ------------------------------------------------------------------

    @property
    def team_memory_root(self) -> Path:
        """团队记忆目录路径。

        Returns:
            团队记忆（team/ 子目录）的完整路径。
        """
        return self._team_root

    # ------------------------------------------------------------------
    # 内部 helper
    # ------------------------------------------------------------------

    def _ensure_directories(self) -> None:
        """确保记忆目录存在。"""
        self.memory_root.mkdir(parents=True, exist_ok=True)
        self._team_root.mkdir(parents=True, exist_ok=True)

    def _index_path(self) -> Path:
        return self.memory_root / ENTRYPOINT_NAME

    def _team_index_path(self) -> Path:
        return self._team_root / ENTRYPOINT_NAME

    def _parse_index_line(self, line: str, line_number: int) -> Optional[dict]:
        """解析索引行: - [标题](文件名.md) — 摘要"""
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            return None
        match = _INDEX_LINE_PATTERN.match(stripped)
        if not match:
            logger.warning("索引第 %d 行格式无法解析: %s", line_number, stripped[:80])
            return None
        return {
            "title": match.group("title").strip(),
            "filename": match.group("filename").strip(),
            "description": match.group("description").strip()[:MEMORY_MAX_DESCRIPTION_LENGTH],
        }

    # ------------------------------------------------------------------
    # 扫描与加载
    # ------------------------------------------------------------------

    def scan_memories(self) -> List[MemoryHeader]:
        """扫描 memory/ 目录，解析 MEMORY.md 索引和独立记忆文件。

        memory_type 优先从 frontmatter 读取，fallback 到文件名推断。
        """
        index_path = self._index_path()
        if not index_path.exists():
            return []

        headers: List[MemoryHeader] = []
        seen: set[str] = set()

        with index_path.open("r", encoding="utf-8") as f:
            for ln, line in enumerate(f, start=1):
                parsed = self._parse_index_line(line, ln)
                if parsed is None:
                    continue
                filename = parsed["filename"]
                if filename in seen:
                    continue
                seen.add(filename)

                fp = self.memory_root / filename
                if not fp.exists() or fp.stat().st_size == 0:
                    continue

                st = fp.stat()
                fm = parse_memory_frontmatter(fp)
                mtype = fm.get("memory_type") or self._infer_memory_type(parsed["title"], fp.stem)
                name = fm.get("name", fp.stem)

                headers.append(MemoryHeader(
                    name=name, path=fp, description=parsed["description"],
                    memory_type=mtype, mtime=st.st_mtime, size_bytes=st.st_size,
                ))

        headers.sort(key=lambda h: h.mtime, reverse=True)
        return headers

    def scan_team_memories(self) -> List[MemoryHeader]:
        """扫描团队记忆（team/ 子目录）。"""
        if not self._team_root.exists():
            return []

        index_path = self._team_index_path()
        if not index_path.exists():
            return []

        headers: List[MemoryHeader] = []
        seen: set[str] = set()

        with index_path.open("r", encoding="utf-8") as f:
            for ln, line in enumerate(f, start=1):
                parsed = self._parse_index_line(line, ln)
                if parsed is None:
                    continue
                filename = parsed["filename"]
                if filename in seen:
                    continue
                seen.add(filename)

                fp = self._team_root / filename
                if not fp.exists() or fp.stat().st_size == 0:
                    continue

                st = fp.stat()
                fm = parse_memory_frontmatter(fp)
                mtype = fm.get("memory_type") or self._infer_memory_type(parsed["title"], fp.stem)
                name = fm.get("name", fp.stem)

                headers.append(MemoryHeader(
                    name=name, path=fp, description=parsed["description"],
                    memory_type=mtype, mtime=st.st_mtime, size_bytes=st.st_size,
                ))

        headers.sort(key=lambda h: h.mtime, reverse=True)
        return headers

    @staticmethod
    def _infer_memory_type(title: str, filename_stem: str) -> str:
        """文件名/标题 → memory_type 推断。frontmatter 不存在时的 fallback。"""
        stem_lower = filename_stem.lower()
        if stem_lower.startswith("user") or stem_lower.startswith("pref"):
            return MEMORY_TYPE_USER
        if stem_lower.startswith("feedback") or stem_lower.startswith("behavior"):
            return MEMORY_TYPE_FEEDBACK
        if stem_lower.startswith("project") or stem_lower.startswith("context"):
            return MEMORY_TYPE_PROJECT
        if stem_lower.startswith("ref") or stem_lower.startswith("external"):
            return MEMORY_TYPE_REFERENCE

        title_lower = title.lower()
        if any(kw in title_lower for kw in ("偏好", "角色", "技能", "用户", "prefer", "user", "profile")):
            return MEMORY_TYPE_USER
        if any(kw in title_lower for kw in ("反馈", "避免", "保持", "注意", "feedback", "avoid", "note")):
            return MEMORY_TYPE_FEEDBACK
        if any(kw in title_lower for kw in ("项目", "目标", "截止", "上下文", "project", "goal", "context")):
            return MEMORY_TYPE_PROJECT
        if any(kw in title_lower for kw in ("引用", "参考", "外部", "reference", "ref", "external", "link")):
            return MEMORY_TYPE_REFERENCE

        return MEMORY_TYPE_REFERENCE

    def load_memory_content(self, header: MemoryHeader) -> str:
        """加载单条记忆正文（自动移除 frontmatter），限制到 MEMORY_FILE_MAX_BYTES。"""
        if not header.path.exists():
            return ""
        try:
            text = header.path.read_text(encoding="utf-8").strip()
        except (UnicodeDecodeError, OSError) as exc:
            logger.error("读取记忆文件失败: %s — %s", header.path, exc)
            return ""

        text = _strip_frontmatter(text)
        if len(text) > MEMORY_FILE_MAX_BYTES:
            text = text[:MEMORY_FILE_MAX_BYTES] + f"\n\n[... 已截断，超过 {MEMORY_FILE_MAX_BYTES // 1024}KB ...]"
        return text

    # ------------------------------------------------------------------
    # 相关性选择
    # ------------------------------------------------------------------

    def select_relevant(self, query: str, limit: int = 5) -> List[MemoryHeader]:
        """关键词匹配选取相关记忆。完整 LLM 选择见 select_relevant_by_model()。"""
        if not query or not query.strip():
            return []
        all_headers = self.scan_memories()
        if not all_headers:
            return []

        query_tokens = self._extract_keywords(query)
        if not query_tokens:
            return all_headers[:limit]

        scored: list[tuple[MemoryHeader, int]] = []
        for h in all_headers:
            overlap = len(query_tokens & self._extract_keywords(f"{h.description} {h.name} {h.memory_type}"))
            if overlap > 0:
                scored.append((h, overlap))

        scored.sort(key=lambda x: (-x[1], -x[0].mtime))
        return [h for h, _ in scored[:limit]]

    @staticmethod
    def _extract_keywords(text: str) -> set[str]:
        """提取语义关键词（中文 2 字以上 + n-gram，英文 3 字符以上）。"""
        stop_words: frozenset[str] = frozenset({
            "的", "了", "是", "在", "有", "和", "就", "不", "人", "都",
            "一", "个", "上", "也", "很", "到", "说", "要", "去", "你",
            "会", "着", "没有", "看", "好", "自己", "这", "那", "什么",
            "怎么", "如何", "为什么", "这个", "那个", "可以", "能", "吗",
        })
        en_stop: frozenset[str] = frozenset({
            "the", "and", "for", "are", "but", "not", "you", "all", "can",
            "had", "her", "was", "one", "our", "out", "has", "have", "been",
            "some", "them", "than", "what", "when", "who", "will", "your", "how",
        })

        keywords: set[str] = set()
        text_lower = text.lower()

        for word in re.findall(r"[a-zA-Z]{3,}", text_lower):
            if word not in en_stop:
                keywords.add(word)

        for segment in re.findall(r"[一-鿿]{2,}", text):
            if segment not in stop_words:
                keywords.add(segment)
                chars = list(segment)
                for i in range(len(chars) - 1):
                    bigram = chars[i] + chars[i + 1]
                    if bigram not in stop_words:
                        keywords.add(bigram)
                for i in range(len(chars) - 2):
                    trigram = chars[i] + chars[i + 1] + chars[i + 2]
                    if trigram not in stop_words:
                        keywords.add(trigram)

        return keywords

    # ------------------------------------------------------------------
    # 写入与索引维护
    # ------------------------------------------------------------------

    def write_memory(self, name: str, content: str, memory_type: str, description: str) -> None:
        """写入新记忆：write_memory_file() + update_memory_index() 两步完成。"""
        if memory_type not in VALID_MEMORY_TYPES:
            raise ValueError(f"不支持的记忆类型: '{memory_type}'。合法值: {', '.join(sorted(VALID_MEMORY_TYPES))}")
        if not description.strip():
            raise ValueError("记忆摘要不能为空。")

        description = description.strip()[:MEMORY_MAX_DESCRIPTION_LENGTH]
        write_memory_file(name=name.strip(), content=content, memory_type=memory_type,
                          description=description, memory_root=self.memory_root)
        update_memory_index(name=name.strip(), description=description, memory_root=self.memory_root)

    def write_team_memory(self, name: str, content: str, memory_type: str, description: str) -> None:
        """写入团队记忆（team/ 子目录）。"""
        self._team_root.mkdir(parents=True, exist_ok=True)
        description = description.strip()[:MEMORY_MAX_DESCRIPTION_LENGTH]
        write_memory_file(name=name.strip(), content=content, memory_type=memory_type,
                          description=description, memory_root=self._team_root)
        update_memory_index(name=name.strip(), description=description, memory_root=self._team_root)

    # ------------------------------------------------------------------
    # 上下文构建
    # ------------------------------------------------------------------

    def build_prompt_context(self, query: str = "", limit: int = 5) -> str:
        """构建格式化记忆上下文（按类型分组 + 新鲜度标记）。"""
        if query and query.strip():
            headers = self.select_relevant(query=query, limit=limit)
        else:
            headers = self.scan_memories()[:limit]

        if not headers:
            return ""

        grouped: dict[str, list] = {}
        now = time.time()

        for h in headers:
            content = self.load_memory_content(h)
            if not content:
                continue

            age = now - h.mtime
            label = ""
            if age > MEMORY_STALE_SECONDS:
                label = " [可能已过期]"
            elif age > MEMORY_FRESH_SECONDS:
                label = " [较旧]"

            grouped.setdefault(h.memory_type, []).append((h, content, label))

        if not grouped:
            return ""

        type_display = {
            MEMORY_TYPE_USER: "用户偏好",
            MEMORY_TYPE_FEEDBACK: "行为反馈",
            MEMORY_TYPE_PROJECT: "项目上下文",
            MEMORY_TYPE_REFERENCE: "外部引用",
        }
        type_order = [MEMORY_TYPE_USER, MEMORY_TYPE_FEEDBACK, MEMORY_TYPE_PROJECT, MEMORY_TYPE_REFERENCE]

        sections = ["## 持久记忆"]
        for mem_type in type_order:
            items = grouped.get(mem_type)
            if not items:
                continue
            sections.append(f"### {type_display.get(mem_type, mem_type)}")
            for header, content, label in items:
                clines = content.splitlines()
                preview = "\n".join(clines[:2])
                if len(clines) > 2:
                    preview += f"\n  _（共 {len(clines)} 行，余下省略）_"
                sections.append(f"- **{header.description}**{label}\n  ```\n  {preview}\n  ```")

        return "\n\n".join(sections)

    def build_combined_memory_prompt(self, query: str = "", limit: int = 5) -> str:
        """同时加载个人记忆和团队记忆，构建组合上下文 prompt。

        这是 MemoryManager 的实例方法版本，同时扫描个人和团队记忆目录，
        将两者合并为一个格式化的 prompt 文本。

        Args:
            query:  可选的查询文本，用于相关性检索。
            limit:  每种记忆类型最大返回条数。

        Returns:
            合并后的格式化记忆上下文文本。
        """
        personal = self.build_prompt_context(query=query, limit=limit)
        team_headers = self.scan_team_memories()[:limit]

        if not team_headers:
            return personal

        team_sections: list[str] = ["## 团队记忆"]
        for h in team_headers:
            content = self.load_memory_content(h)
            if not content:
                continue
            clines = content.splitlines()
            preview = "\n".join(clines[:3])
            if len(clines) > 3:
                preview += f"\n  _（共 {len(clines)} 行，余下省略）_"
            team_sections.append(f"- **{h.description}**\n  ```\n  {preview}\n  ```")

        team_text = "\n\n".join(team_sections)
        return f"{personal}\n\n{team_text}" if personal else team_text

    # ------------------------------------------------------------------
    # 维护
    # ------------------------------------------------------------------

    def evict_old_entries(self) -> int:
        """淘汰空内容条目 + 超限索引行。"""
        index_path = self._index_path()
        if not index_path.exists():
            return 0

        with index_path.open("r", encoding="utf-8") as f:
            lines = f.readlines()

        remaining: list[str] = []
        removed = 0

        for line in lines:
            parsed = self._parse_index_line(line, 0)
            if parsed is None:
                remaining.append(line)
                continue
            fp = self.memory_root / parsed["filename"]
            if not fp.exists() or fp.stat().st_size == 0:
                removed += 1
                continue
            remaining.append(line)

        idx_lines = [l for l in remaining if _INDEX_LINE_PATTERN.match(l.strip())]
        if len(idx_lines) > MAX_ENTRYPOINT_LINES:
            timed: list[tuple[str, float]] = []
            for line in idx_lines:
                p = self._parse_index_line(line, 0)
                if p is None:
                    continue
                fp = self.memory_root / p["filename"]
                timed.append((line, fp.stat().st_mtime if fp.exists() else 0))
            timed.sort(key=lambda x: -x[1])
            keep = {line for line, _ in timed[:MAX_ENTRYPOINT_LINES]}
            new_remaining: list[str] = []
            for line in remaining:
                if _INDEX_LINE_PATTERN.match(line.strip()) and line not in keep:
                    removed += 1
                    continue
                new_remaining.append(line)
            remaining = new_remaining

        index_path.write_text("".join(remaining), encoding="utf-8")
        return removed
