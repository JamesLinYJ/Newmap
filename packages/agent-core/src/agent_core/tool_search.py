# +-------------------------------------------------------------------------
#
#   地理智能平台 - Tool Search 工具搜索注册表
#
#   文件:       tool_search.py
#
#   日期:       2026年06月01日
#   作者:       GeoAgent
# --------------------------------------------------------------------------

# 模块职责
#
# 大工具列表（>20 个工具）时，非 always_load 工具设为 should_defer=True。
# SDK 的 FunctionTool 支持 defer_loading 参数。
# 模型通过 ToolSearchTool 按关键词发现延迟工具。

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

TOOL_SEARCH_TOOL_NAME: str = "tool_search"
"""ToolSearchTool 的注册名称。"""

DEFAULT_TOOL_COUNT_THRESHOLD: int = 20
"""触发延迟加载的工具数量阈值。超过此值时启用 defer_loading。"""

DEFAULT_MAX_SEARCH_RESULTS: int = 8
"""搜索返回的最大工具数量。"""

# ---------------------------------------------------------------------------
# ToolSearchTool — 供 Agent 发现延迟工具
# ---------------------------------------------------------------------------

# SDK FunctionTool 的 defer_loading 参数 / needs_approval 风格钩子
_DEFER_LOADING_ATTR: str = "defer_loading"

# always_load 标签：始终加载的工具（不论是否超过阈值）
ALWAYS_LOAD_TOOL_TAGS: list[str] = [
    "list_available_layers", "list_context_references", "search_thread_context",
    "request_clarification", "geocode_place",
]


# ===================================================================
# 数据类
# ===================================================================

@dataclass
class ToolSearchEntry:
    """工具搜索条目。

    Attributes:
        name: 工具注册名称。
        description: 工具功能描述（用于搜索匹配和展示）。
        group: 工具分组名称（如 "meteorological", "spatial"）。
        tags: 工具标签列表（用于分类搜索）。
        always_load: 是否始终加载（不受延迟加载阈值影响）。
        should_defer: 是否应延迟加载（由 ToolSearchRegistry 自动设置）。
    """
    name: str
    description: str = ""
    group: str = "general"
    tags: list[str] = field(default_factory=list)
    always_load: bool = False
    should_defer: bool = False


# ===================================================================
# ToolSearchRegistry
# ===================================================================

class ToolSearchRegistry:
    """工具搜索注册表。

    职责:
    1. 当注册工具数量 > threshold 时，非 always_load 工具标记为 should_defer=True。
    2. 提供 ToolSearchTool 供 Agent 按关键词发现延迟工具。
    3. 维护工具名称 → ToolSearchEntry 的映射。

    Usage:
        registry = ToolSearchRegistry(threshold=20)
        registry.register_tool("geocode_place", description="地理编码...", group="geospatial")
        # 批次登记所有工具定义
        for defn in all_tool_definitions:
            registry.register_from_definition(defn)
        # 获取应延迟加载的工具列表
        deferred_tools = registry.get_deferred_tools()
        # 构建 ToolSearchTool 函数
        search_fn = registry.build_search_function()
    """

    def __init__(self, threshold: int = DEFAULT_TOOL_COUNT_THRESHOLD) -> None:
        """初始化。

        Args:
            threshold: 工具数量阈值。超过此值时启用延迟加载。
        """
        self._threshold: int = threshold
        self._entries: dict[str, ToolSearchEntry] = {}
        self._always_load_tags: list[str] = list(ALWAYS_LOAD_TOOL_TAGS)

    # ------------------------------------------------------------------
    # 工具注册
    # ------------------------------------------------------------------

    def register_tool(
        self,
        name: str,
        *,
        description: str = "",
        group: str = "general",
        tags: list[str] | None = None,
        always_load: bool = False,
    ) -> None:
        """注册一个工具到搜索注册表。

        Args:
            name: 工具名称（必须唯一）。
            description: 工具功能描述。
            group: 工具分组名称。
            tags: 工具标签列表。
            always_load: 是否始终加载（不受延迟加载阈值影响）。
        """
        entry = ToolSearchEntry(
            name=name,
            description=description,
            group=group,
            tags=tags or [],
            always_load=always_load or name in self._always_load_tags,
        )
        self._entries[name] = entry

    def register_from_definition(
        self,
        definition: Any,
        *,
        group: str = "general",
        always_load: bool = False,
    ) -> None:
        """从工具定义对象注册工具。

        适配 tool_registry 中的工具定义格式。

        Args:
            definition: 工具定义对象（须有 name 和 description 属性）。
            group: 工具分组名称。
            always_load: 是否始终加载。
        """
        name = (
            getattr(definition, "name", None)
            or (getattr(definition, "metadata", None) and getattr(definition.metadata, "name", None))
            or ""
        )
        if not name:
            logger.warning("工具定义缺少 name 字段，跳过注册: %s", definition)
            return

        description = (
            getattr(definition, "description", None)
            or (getattr(definition, "metadata", None) and getattr(definition.metadata, "description", None))
            or ""
        )

        tags: list[str] = []
        meta = getattr(definition, "metadata", None)
        if meta:
            tags = list(getattr(meta, "tags", []) or [])

        self.register_tool(
            name=name,
            description=str(description or ""),
            group=group,
            tags=tags,
            always_load=always_load,
        )

    def register_batch(
        self,
        entries: list[ToolSearchEntry],
    ) -> None:
        """批量注册工具条目。

        Args:
            entries: ToolSearchEntry 列表。
        """
        for entry in entries:
            self._entries[entry.name] = entry

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def get_entry(self, name: str) -> ToolSearchEntry | None:
        """获取指定工具名称的搜索条目。

        Args:
            name: 工具名称。

        Returns:
            ToolSearchEntry 实例，不存在时返回 None。
        """
        return self._entries.get(name)

    def get_all_entries(self) -> list[ToolSearchEntry]:
        """获取所有已注册的工具条目。

        Returns:
            所有 ToolSearchEntry 列表。
        """
        return list(self._entries.values())

    def get_deferred_entries(self) -> list[ToolSearchEntry]:
        """获取应延迟加载的工具条目列表。

        当已注册工具总数 > threshold 时，非 always_load 工具标记为延迟加载。

        Returns:
            应延迟加载的 ToolSearchEntry 列表。
        """
        if not self._should_defer():
            return []
        return [
            entry for entry in self._entries.values()
            if entry.should_defer
        ]

    def get_always_load_entries(self) -> list[ToolSearchEntry]:
        """获取始终加载的工具条目列表。

        Returns:
            始终加载的 ToolSearchEntry 列表。
        """
        return [
            entry for entry in self._entries.values()
            if entry.always_load
        ]

    # ------------------------------------------------------------------
    # 延迟加载判断
    # ------------------------------------------------------------------

    def _should_defer(self) -> bool:
        """判断是否需要启用延迟加载。

        当注册工具总数超过阈值时启用。
        """
        return len(self._entries) > self._threshold

    def compute_deferred_flags(self) -> None:
        """计算所有工具的 should_defer 标记。

        在全部工具注册完成后调用，一次性计算哪些工具需要延迟加载。
        """
        should_defer = self._should_defer()
        for entry in self._entries.values():
            if should_defer and not entry.always_load:
                entry.should_defer = True
            else:
                entry.should_defer = False

    def get_non_deferred(self) -> list[ToolSearchEntry]:
        """获取不应延迟加载（始终加载）的工具条目。

        Returns:
            不应延迟加载的 ToolSearchEntry 列表。
        """
        return self.get_always_load_entries() if self._should_defer() else self.get_all_entries()

    # ------------------------------------------------------------------
    # 搜索
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        max_results: int = DEFAULT_MAX_SEARCH_RESULTS,
    ) -> list[ToolSearchEntry]:
        """按关键词搜索工具。

        匹配字段: name, description, group, tags。
        使用中文和英文分词匹配。

        Args:
            query: 搜索关键词。
            max_results: 最大返回结果数。

        Returns:
            匹配的 ToolSearchEntry 列表，按相关性降序排列。
        """
        if not query or not query.strip():
            return list(self._entries.values())[:max_results]

        query_lower = query.lower().strip()
        query_tokens = self._tokenize(query_lower)

        scored: list[tuple[ToolSearchEntry, int]] = []
        for entry in self._entries.values():
            score = self._score_entry(entry, query_lower, query_tokens)
            if score > 0:
                scored.append((entry, score))

        # 按分数降序排列
        scored.sort(key=lambda x: (-x[1], x[0].name))
        return [entry for entry, _score in scored[:max_results]]

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        """对文本进行分词（英文+中文）。

        Args:
            text: 待分词的文本。

        Returns:
            分词后的 token 集合。
        """
        tokens: set[str] = set()

        # 英文 token（>=3 字符）
        for word in re.findall(r"[a-zA-Z]{3,}", text):
            tokens.add(word.lower())

        # 中文 token（>=2 字符）
        for seg in re.findall(r"[一-鿿]{2,}", text):
            tokens.add(seg)

        return tokens

    @staticmethod
    def _score_entry(
        entry: ToolSearchEntry,
        query_lower: str,
        query_tokens: set[str],
    ) -> int:
        """计算工具条目与查询的相关性分数。

        Args:
            entry: 工具搜索条目。
            query_lower: 小写化的查询字符串。
            query_tokens: 分词后的查询 token 集合。

        Returns:
            相关性分数（0 表示不匹配）。
        """
        score = 0

        # 1. 名称精确匹配（最高优先级）
        if query_lower == entry.name.lower():
            score += 100
        elif query_lower in entry.name.lower():
            score += 50

        # 2. 名称 token 匹配
        name_tokens = ToolSearchRegistry._tokenize(entry.name)
        overlap = len(query_tokens & name_tokens)
        score += overlap * 20

        # 3. 描述 token 匹配
        desc_tokens = ToolSearchRegistry._tokenize(entry.description)
        desc_overlap = len(query_tokens & desc_tokens)
        score += desc_overlap * 10

        # 4. 标签匹配
        tag_text = " ".join(entry.tags).lower()
        if query_lower in tag_text:
            score += 15
        tag_tokens = ToolSearchRegistry._tokenize(tag_text)
        tag_overlap = len(query_tokens & tag_tokens)
        score += tag_overlap * 5

        # 5. 组名匹配
        group_text = entry.group.lower()
        if query_lower == group_text:
            score += 30
        elif query_lower in group_text:
            score += 15

        return score

    # ------------------------------------------------------------------
    # ToolSearchTool 构建
    # ------------------------------------------------------------------

    def build_search_function(
        self,
    ) -> Callable[[str], str]:
        """构建 ToolSearchTool 的执行函数。

        返回异步函数，代理由 Agent 调用，返回 JSON 格式的工具列表。

        Returns:
            异步工具搜索函数：接受关键词查询，返回匹配工具 JSON 字符串。
        """
        import json as _json

        async def _tool_search_impl(query: str) -> str:
            """搜索可用工具列表。传入关键词（如"气象"、"缓冲区"），返回匹配的工具。"""
            results = self.search(query)
            if not results:
                return _json.dumps({
                    "query": query,
                    "results": [],
                    "message": f"未找到匹配 '{query}' 的工具。请尝试其他关键词。",
                }, ensure_ascii=False)
            result_list: list[dict[str, Any]] = []
            for entry in results:
                result_list.append({
                    "name": entry.name,
                    "description": entry.description[:200] if entry.description else "",
                    "group": entry.group,
                    "tags": entry.tags[:5],
                })
            return _json.dumps({
                "query": query,
                "results": result_list,
                "count": len(result_list),
                "message": f"找到 {len(result_list)} 个匹配工具。",
            }, ensure_ascii=False)

        return _tool_search_impl

    # ------------------------------------------------------------------
    # 工具统计
    # ------------------------------------------------------------------

    @property
    def total_count(self) -> int:
        """已注册的工具总数。"""
        return len(self._entries)

    @property
    def deferred_count(self) -> int:
        """延迟加载的工具数。"""
        return len(self.get_deferred_entries())

    @property
    def always_load_count(self) -> int:
        """始终加载的工具数。"""
        return len(self.get_always_load_entries())

    @property
    def is_deferred_enabled(self) -> bool:
        """是否启用了延迟加载。"""
        return self._should_defer()
