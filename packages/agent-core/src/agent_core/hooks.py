# +-------------------------------------------------------------------------
#
#   地理智能平台 - Hook 事件系统（基于 pluggy）
#
#   文件:       hooks.py
#
#   日期:       2026年06月01日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 提供 Agent 生命周期可配置扩展点，支持 12 种事件类型和 2 种执行方式。
# 基于 pluggy（pytest 插件系统）实现事件驱动的插件化行为注入。
#
# 核心架构：
#   AgentHooks        — Hook 规范类，定义所有支持的 hook 接口
#   AgentHookManager  — 基于 pluggy PluginManager 的注册/执行管理器
#   HookHandler       — 可序列化的 handler 定义数据类
#   HookResult        — 执行结果数据类（向后兼容）

from __future__ import annotations

import logging
import shlex
import subprocess
from dataclasses import dataclass, field
from typing import Any, Literal

import pluggy

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# pluggy 标记工厂
# ---------------------------------------------------------------------------

hookspec = pluggy.HookspecMarker("geoagent")
hookimpl = pluggy.HookimplMarker("geoagent")

# ---------------------------------------------------------------------------
# Hook 执行类型
# ---------------------------------------------------------------------------

HookCommand = Literal["command", "prompt"]

# ---------------------------------------------------------------------------
# AgentHooks — 所有支持的 Hook 规范
# ---------------------------------------------------------------------------


class AgentHooks:
    """Agent 生命周期 Hook 规范。

    每个方法对应一个事件类型。pluggy 根据 @hookspec 元数据自动管理：
    - 多实现聚合（non-firstresult）：收集所有非 None 返回值
    - firstresult 短路：首个非 None 返回值即终止，用于后处理 / 错误处理
    - 错误隔离：单个 impl 抛异常不影响其他 impl
    """

    # -- 工具执行生命周期 ------------------------------------------------

    @hookspec
    def pre_tool_use(self, tool_name: str, args: dict, run_id: str) -> str | None:
        """工具执行前触发。返回非 None 的字符串表示阻止执行（exit_code=2 语义）。"""

    @hookspec(firstresult=True)
    def post_tool_use(self, tool_name: str, result: str, run_id: str) -> str | None:
        """工具执行成功后触发。firstresult=True 表示首个非 None 结果短路。"""

    @hookspec
    def post_tool_use_failure(
        self, tool_name: str, error: str, run_id: str
    ) -> str | None:
        """工具执行失败后触发。"""

    # -- 会话生命周期 ----------------------------------------------------

    @hookspec
    def session_start(self, run_id: str) -> str | None:
        """Agent 会话开始时触发。"""

    @hookspec
    def session_end(self, run_id: str, status: str) -> str | None:
        """Agent 会话结束时触发。"""

    # -- 停止 / 错误 -----------------------------------------------------

    @hookspec
    def stop(self, run_id: str) -> str | None:
        """Agent 即将正常响应结束时触发。"""

    @hookspec(firstresult=True)
    def stop_failure(self, run_id: str, error: str) -> str | None:
        """API 错误导致轮次结束时触发。"""

    # -- 子智能体 --------------------------------------------------------

    @hookspec
    def subagent_start(
        self, agent_type: str, agent_id: str, run_id: str
    ) -> str | None:
        """子智能体启动时触发。"""

    @hookspec
    def subagent_stop(
        self, agent_type: str, agent_id: str, run_id: str
    ) -> str | None:
        """子智能体响应结束时触发。"""

    # -- 对话压缩 --------------------------------------------------------

    @hookspec
    def pre_compact(self, run_id: str) -> str | None:
        """对话压缩前触发。"""

    @hookspec
    def post_compact(self, run_id: str) -> str | None:
        """对话压缩后触发。"""

    # -- 通知 ------------------------------------------------------------

    @hookspec
    def notification(
        self, message: str, notification_type: str, run_id: str
    ) -> str | None:
        """发送通知时触发。"""


# ---------------------------------------------------------------------------
# 数据类 — 向后兼容
# ---------------------------------------------------------------------------


@dataclass
class HookHandler:
    """Hook 事件处理器定义

    描述一个 hook 在什么事件下、以什么执行方式运行什么内容。

    退出码约定：
    - 0: 正常执行，不阻断事件流程
    - 2: 阻止事件继续（如阻止工具调用），对应 HookResult.blocked=True
    - 其他: 显示错误但继续执行

    matcher 支持按 tool_name / event_type 做精确匹配或前缀匹配。
    前缀匹配通过以 * 结尾的 pattern 实现，如 "geocode_*" 匹配所有 geocode 开头的工具。
    """

    event_type: str
    """触发该 handler 的事件类型（字符串，如 "pre_tool_use"）。"""
    command_type: HookCommand
    """执行方式：'command' 执行 shell 命令，'prompt' 注入文本。"""
    command: str
    """当 command_type='command' 时为 shell 命令；当 command_type='prompt' 时为注入文本。"""
    matcher: dict[str, str] = field(default_factory=dict)
    """匹配条件，如 {'tool_name': 'geocode_place'} 或 {'tool_name': 'geocode_*'}。"""
    priority: int = 0
    """优先级，数字越小越优先执行。"""
    description: str = ""
    """可读描述，仅用于日志和调试。"""
    timeout_seconds: int = 30
    """command 执行超时（秒），仅对 command 类型有效。"""


@dataclass
class HookResult:
    """Hook 执行结果

    blocked 为 True 表示该 hook 返回了退出码 2，上层调用方必须据此中断流程。
    多个 hook 执行时，任一 hook 返回 blocked=True 都应导致整个事件被阻断。
    """

    success: bool
    """是否成功执行（exit_code=0 或 prompt 注入完毕）。"""
    blocked: bool = False
    """是否阻止事件继续（exit_code=2）。"""
    message: str = ""
    """执行摘要消息。"""
    stdout: str = ""
    """命令标准输出，仅对 command 类型有效。"""
    stderr: str = ""
    """命令标准错误，仅对 command 类型有效。"""


# ---------------------------------------------------------------------------
# AgentHookManager — 取代旧 HookRegistry
# ---------------------------------------------------------------------------


class AgentHookManager:
    """基于 pluggy 的 Agent Hook 管理器。

    替代旧的 HookRegistry。使用 pluggy PluginManager 处理注册、匹配、执行。
    支持按事件名精确匹配 + matcher 前缀/精确匹配，按 priority 排序执行。
    """

    def __init__(self) -> None:
        self._pm = pluggy.PluginManager("geoagent")
        self._pm.add_hookspecs(AgentHooks)
        # event_name → [HookHandler] 用于调试 / 自省
        self._handlers: dict[str, list[HookHandler]] = {}

    # -- 注册接口 --------------------------------------------------------

    def register(self, event: str, handler: HookHandler) -> None:
        """注册一个 hook 处理器。

        Args:
            event: 事件类型名称（如 "pre_tool_use"）。
            handler: 配置好的 HookHandler 实例。
        """
        event_name = self._resolve_event_name(event)
        plugin = self._build_handler_plugin(handler)
        self._pm.register(plugin, name=f"handler_{id(handler)}")
        self._handlers.setdefault(event_name, []).append(handler)
        logger.debug(
            "已注册 hook: %s [%s@%s]",
            handler.description or handler.command,
            event_name,
            handler.priority,
        )

    def list_handlers(self) -> list[HookHandler]:
        """返回所有已注册的 handler 副本。"""
        result: list[HookHandler] = []
        for handlers in self._handlers.values():
            result.extend(handlers)
        return result

    def get_matching(
        self, event: str, **context: Any
    ) -> list[HookHandler]:
        """返回匹配指定事件和上下文的所有 handler，按优先级升序排列。

        matcher 中的键值对与 context 做全量比较。支持精确匹配和前缀匹配：
        - 前缀匹配: pattern 以 * 结尾，如 "geocode_*" 匹配 context 中 tool_name="geocode_place"
        - 精确匹配: 普通字符串，如 "geocode_place" 只精确匹配 context 中 tool_name="geocode_place"

        Args:
            event: 要匹配的事件类型名称。
            **context: 上下文键值对，如 tool_name、run_id 等。

        Returns:
            匹配到的 handler 列表，按 priority 升序排列。
        """
        event_name = self._resolve_event_name(event)
        matched = self._handlers.get(event_name, [])
        if not context:
            return sorted(matched, key=lambda h: h.priority)

        result: list[HookHandler] = []
        for handler in matched:
            if handler.matcher:
                matched_all = True
                for key, expected in handler.matcher.items():
                    actual = context.get(key)
                    if isinstance(expected, str) and expected.endswith("*"):
                        prefix = expected[:-1]
                        if not (
                            actual is not None
                            and str(actual).startswith(prefix)
                        ):
                            matched_all = False
                            break
                    else:
                        if str(actual) != str(expected):
                            matched_all = False
                            break
                if not matched_all:
                    continue
            result.append(handler)
        result.sort(key=lambda h: h.priority)
        return result

    # -- 执行接口 --------------------------------------------------------

    def execute(self, event_name: str, **kwargs: Any) -> list[HookResult]:
        """执行匹配 event_name 的所有 hook，返回结果列表。

        Args:
            event_name: 触发的事件类型名称。
            **kwargs: 传递给 hook 实现函数的上下文参数。

        Returns:
            HookResult 列表。调用方需检查结果中是否存在 blocked=True 的条目，
            据此决定是否中断当前流程。
        """
        event_name = self._resolve_event_name(event_name)
        hook_fn = getattr(self._pm.hook, event_name, None)
        if hook_fn is None:
            return []

        results: list[HookResult] = []
        try:
            raw = hook_fn(**kwargs)
        except Exception as exc:
            logger.error("Hook 事件 %s 执行异常: %s", event_name, exc)
            results.append(
                HookResult(
                    success=False,
                    blocked=False,
                    message=str(exc),
                    stderr=str(exc),
                )
            )
            return results

        if raw is None:
            return []

        # firstresult 钩子返回标量，非 firstresult 返回列表
        raw_list: list[str | None] = raw if isinstance(raw, list) else [raw]

        for item in raw_list:
            if item is None:
                continue
            result = HookResult(
                success=True,
                blocked=(event_name == "pre_tool_use"),
                message=item,
                stdout=item,
            )
            if result.blocked:
                logger.warning(
                    "Hook 阻止了事件 %s（阻止消息: %s）",
                    event_name,
                    item,
                )
            results.append(result)

        return results

    def load_from_config(self, config_hooks: list[dict[str, Any]]) -> None:
        """从配置字典列表加载 hooks。

        configs 中每个条目对应一个 HookHandler，支持中英双语的 key 名：
        - event_type / eventType: 事件类型字符串
        - command_type / commandType: 执行方式，'command' 或 'prompt'
        - command: shell 命令或 prompt 文本
        - matcher: 匹配条件字典
        - priority: 优先级（可选，默认 0）
        - description: 描述（可选）
        - timeout_seconds / timeoutSeconds: 超时秒数（可选，默认 30）

        解析失败的条目会被跳过并通过日志警告，不影响其余条目的加载。

        Args:
            config_hooks: Hook 配置字典列表。
        """
        for entry in config_hooks:
            try:
                event_type_str = entry.get("event_type") or entry.get(
                    "eventType"
                )
                if not event_type_str:
                    logger.warning(
                        "Hook 配置缺少 event_type，跳过: %s", entry
                    )
                    continue

                handler = HookHandler(
                    event_type=event_type_str,
                    command_type=entry.get("command_type")
                    or entry.get("commandType", "command"),
                    command=entry.get("command", ""),
                    matcher=entry.get("matcher", {}),
                    priority=entry.get("priority", 0),
                    description=entry.get("description", ""),
                    timeout_seconds=entry.get("timeout_seconds")
                    or entry.get("timeoutSeconds", 30),
                )
                self.register(event_type_str, handler)
            except (ValueError, KeyError) as exc:
                logger.warning(
                    "Hook 配置解析失败，跳过: %s（错误: %s）",
                    entry,
                    exc,
                )

    # -- 内部方法 --------------------------------------------------------

    @staticmethod
    def _resolve_event_name(event: Any) -> str:
        """将各种形式的 event 统一解析为字符串事件名。"""
        if isinstance(event, str):
            return event
        # 兼容旧的 HookEvent 枚举值
        if hasattr(event, "value"):
            return str(event.value)
        return str(event)

    def _build_handler_plugin(self, handler: HookHandler) -> object | None:
        """从 HookHandler 构建一个 pluggy 插件实例。

        每个 handler 对应一个独立的插件对象，仅实现其所声明事件类型的 hook。
        使用 exec 动态创建具有正确参数名的函数，因为 pluggy 的 varnames() 会
        排除 VAR_KEYWORD 参数（**kwargs），只传递明确的命名参数。
        """
        event_name = self._resolve_event_name(handler.event_type)

        # 获取 hook spec 的参数字段（不含 'self'）
        hook_caller = getattr(self._pm.hook, event_name, None)
        if hook_caller is None or hook_caller.spec is None:
            logger.warning("无法为未知事件构建插件: %s", event_name)
            return None

        spec_params = hook_caller.spec.argnames  # e.g., ('tool_name', 'args', 'run_id')

        # 使用 exec 创建具有正确签名的函数，第一个参数永远是 self（让 pluggy
        # 的 varnames() 能正确剥离实例引用），其余参数名与 hook spec 完全一致。
        namespace: dict[str, Any] = {}
        param_str = ", ".join(spec_params)
        dict_items = ", ".join(f"'{p}': {p}" for p in spec_params)

        exec(
            f"def hook_fn(self, {param_str}):\n"
            f"    return _handle_single_hook(handler, {{{dict_items}}})\n",
            {
                "_handle_single_hook": _handle_single_hook,
                "handler": handler,
            },
            namespace,
        )

        impl_fn = hookimpl(namespace["hook_fn"])

        plugin_cls = type(
            f"HandlerPlugin_{id(handler)}",
            (object,),
            {event_name: impl_fn},
        )
        return plugin_cls()


# ---------------------------------------------------------------------------
# 模块级辅助函数（被 exec 动态创建的 hook_fn 引用）
# ---------------------------------------------------------------------------


def _handle_single_hook(
    handler: HookHandler, kwargs: dict[str, Any]
) -> str | None:
    """检查 matcher 并执行单个 handler，返回 str | None。

    Args:
        handler: 要执行的 HookHandler。
        kwargs: 从 hook 调用传入的上下文参数。

    Returns:
        非 None 字符串表示 handler 有输出（对 pre_tool_use 表示阻止），
        None 表示不阻断 / 没有输出。
    """
    # ---- matcher 匹配检查 ----
    if handler.matcher:
        for key, expected in handler.matcher.items():
            actual = kwargs.get(key)
            if isinstance(expected, str) and expected.endswith("*"):
                prefix = expected[:-1]
                if not (actual is not None and str(actual).startswith(prefix)):
                    return None
            else:
                if str(actual) != str(expected):
                    return None

    # ---- 执行 handler ----
    if handler.command_type == "command":
        return _run_command(handler)
    elif handler.command_type == "prompt":
        return handler.command
    return None


def _run_command(handler: HookHandler) -> str | None:
    """执行 command 类型的 handler，返回 stdout 或 None。

    退出码约定：
    - 0: 成功，返回 stdout（strip 后为空时返回 None）
    - 2: 阻止事件，返回 stdout 或默认阻止消息
    - 其他: 失败，记录日志，返回 None
    """
    try:
        completed = subprocess.run(
            shlex.split(handler.command),
            capture_output=True,
            text=True,
            timeout=handler.timeout_seconds,
        )
        stdout = (completed.stdout or "").strip()
        stderr = (completed.stderr or "").strip()

        if completed.returncode == 2:
            return stdout or "Hook 阻止了当前操作"
        elif completed.returncode == 0:
            return stdout or None
        else:
            logger.warning(
                "Hook 退出码 %d（命令: %s）: %s",
                completed.returncode,
                handler.command,
                stderr or stdout or "(无输出)",
            )
            return None
    except subprocess.TimeoutExpired:
        logger.warning(
            "Hook 执行超时（%ds）: %s",
            handler.timeout_seconds,
            handler.command,
        )
        return None
    except FileNotFoundError:
        logger.warning("命令未找到: %s", handler.command)
        return None


# ---------------------------------------------------------------------------
# 模块级工厂函数 — 向后兼容
# ---------------------------------------------------------------------------


def load_hooks_from_config(
    configs: list[dict[str, Any]],
) -> AgentHookManager:
    """从配置字典列表加载 AgentHookManager。

    保留此函数以保持导入兼容性。内部直接调用 AgentHookManager.load_from_config。

    参数和返回值语义与旧版 load_hooks_from_config 一致，仅返回类型从
    HookRegistry 变为 AgentHookManager。

    Args:
        configs: Hook 配置字典列表。

    Returns:
        装配完成的 AgentHookManager。
    """
    manager = AgentHookManager()
    manager.load_from_config(configs)
    return manager
