# +-------------------------------------------------------------------------
#
#   地理智能平台 - 第三方工具 Provider 契约
#
#   文件:       providers.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 定义仓库内工具模块接入平台时必须满足的 manifest、provider 与契约校验。
# 这里不执行工具业务逻辑，只负责把“可合并的工具模块”变成可审计、可拒绝的定义。

from __future__ import annotations

import importlib
import inspect
import re
import sys
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from .base import ToolArgsModel, ToolExecutionResult
from .registry import ToolDefinition


TOOL_API_VERSION = "1"
ENTRY_POINT_GROUP = "geo_agent_platform.tools"
ALLOWED_TOOL_GROUPS = {
    "context",
    "lookup",
    "data",
    "analysis",
    "meteorology",
    "visualization",
    "output",
    "external",
}
APPROVED_NAME_PREFIXES = {
    "answer",
    "analyze",
    "build",
    "calculate",
    "check",
    "create",
    "define",
    "export",
    "fetch",
    "generate",
    "inspect",
    "list",
    "load",
    "parse",
    "publish",
    "render",
    "request",
    "resolve",
    "run",
    "search",
    "summarize",
    "transform",
    "validate",
    "write",
}
SENSITIVE_PERMISSIONS = {
    "network",
    "filesystem_read",
    "filesystem_write",
    "execute_code",
    "paid_api",
    "publish",
    "private_network",
}


class ToolManifest(BaseModel):
    # 工具模块 manifest。
    #
    # provider_id 是显式 allowlist 的主键；permissions 用于 code review 和审批审查，
    # 不参与运行时兜底授权。工具代码合并进仓库后，仍必须通过这个 manifest 暴露边界。
    provider_id: str = Field(..., pattern=r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")
    name: str
    version: str
    owner: str
    tool_api_version: str = TOOL_API_VERSION
    description: str = ""
    permissions: list[str] = Field(default_factory=list)
    config_schema: dict[str, Any] = Field(default_factory=dict)
    dependencies: list[str] = Field(default_factory=list)


@runtime_checkable
class ToolProvider(Protocol):
    # 工具模块 Provider。
    #
    # Provider 只能声明工具定义；不得直接写 registry、store 或 run state。
    @property
    def manifest(self) -> ToolManifest:
        ...

    def list_definitions(self) -> list[ToolDefinition]:
        ...


class ToolProviderContractError(ValueError):
    pass


def validate_provider(provider: ToolProvider) -> None:
    manifest = _coerce_manifest(getattr(provider, "manifest", None))
    _validate_manifest(manifest)
    definitions = provider.list_definitions()
    if not definitions:
        raise ToolProviderContractError(f"Provider {manifest.provider_id} 没有声明任何工具。")
    seen: set[str] = set()
    for definition in definitions:
        if definition.name in seen:
            raise ToolProviderContractError(f"Provider {manifest.provider_id} 重复声明工具：{definition.name}")
        seen.add(definition.name)
        validate_tool_definition(definition, provider_manifest=manifest)


def validate_tool_definition(definition: ToolDefinition, *, provider_manifest: ToolManifest | None = None) -> None:
    errors = collect_tool_definition_errors(definition, provider_manifest=provider_manifest)
    if errors:
        raise ToolProviderContractError("; ".join(errors))


def collect_tool_definition_errors(
    definition: ToolDefinition,
    *,
    provider_manifest: ToolManifest | None = None,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(definition, ToolDefinition):
        return ["工具定义必须是 ToolDefinition。"]
    if not re.fullmatch(r"[a-z][a-z0-9_]*", definition.name or ""):
        errors.append(f"工具名必须是 snake_case：{definition.name!r}")
    elif definition.name.split("_", 1)[0] not in APPROVED_NAME_PREFIXES:
        errors.append(f"工具名必须以明确动词开头：{definition.name}")

    metadata = definition.metadata
    if not str(metadata.label or "").strip():
        errors.append(f"{definition.name}: metadata.label 不能为空。")
    if len(str(metadata.description or "").strip()) < 20:
        errors.append(f"{definition.name}: metadata.description 必须说明输入、输出、适用场景和失败条件。")
    if metadata.group not in ALLOWED_TOOL_GROUPS:
        errors.append(f"{definition.name}: metadata.group 不合法：{metadata.group}")
    if not metadata.tags:
        errors.append(f"{definition.name}: metadata.tags 不能为空。")
    if metadata.tool_kind != "registry":
        errors.append(f"{definition.name}: 第三方工具必须包装成 registry ToolDefinition。")

    if not inspect.iscoroutinefunction(definition.handler):
        errors.append(f"{definition.name}: handler 必须是 async 函数。")

    if definition.args_model is None:
        errors.append(f"{definition.name}: args_model 必须继承 ToolArgsModel。")
    elif not issubclass(definition.args_model, ToolArgsModel):
        errors.append(f"{definition.name}: args_model 必须继承 ToolArgsModel。")
    else:
        errors.extend(_collect_args_model_errors(definition))

    return_annotation = inspect.signature(definition.handler).return_annotation
    if return_annotation not in (inspect.Signature.empty, ToolExecutionResult, "ToolExecutionResult"):
        errors.append(f"{definition.name}: handler 返回类型应为 ToolExecutionResult。")

    if provider_manifest is not None:
        _patch_provider_metadata(definition, provider_manifest)
        sensitive = set(provider_manifest.permissions).intersection(SENSITIVE_PERMISSIONS)
        if sensitive and not definition.metadata.meta.get("approvalRequired"):
            errors.append(f"{definition.name}: provider 声明敏感权限 {sorted(sensitive)}，工具 metadata.meta.approvalRequired 必须为 true。")
    return errors


def load_enabled_tool_providers(enabled_specs: list[str] | tuple[str, ...] | None) -> list[ToolProvider]:
    # 显式加载 provider。
    #
    # 本项目主路径是 module:object。entry point 只作为未来打包形态保留，
    # 也必须进入 allowlist 才会导入；不会扫描并自动启用未知工具。
    enabled = [item.strip() for item in (enabled_specs or []) if item and item.strip()]
    if not enabled:
        return []
    loaded: list[ToolProvider] = []
    entry_points = _entry_points_by_name()
    for spec in enabled:
        provider = _load_provider_from_entry_point(spec, entry_points) if ":" not in spec else _load_provider_from_object_path(spec)
        validate_provider(provider)
        loaded.append(provider)
    return loaded


def register_provider_tools(registry: Any, provider: ToolProvider) -> None:
    # Provider 装配边界。
    #
    # 内建模块和 allowlist 第三方模块都走同一条契约校验与 metadata 标记路径，
    # 避免某些工具因为“内建”身份绕过接入标准。
    validate_provider(provider)
    manifest = _coerce_manifest(provider.manifest)
    for definition in provider.list_definitions():
        _patch_provider_metadata(definition, manifest)
        registry.register_definition(definition)


def build_registry_with_providers(enabled_specs: list[str] | tuple[str, ...] | None = None):
    from .registry import build_default_registry

    registry = build_default_registry()
    for provider in load_enabled_tool_providers(enabled_specs):
        register_provider_tools(registry, provider)
    return registry


def _collect_args_model_errors(definition: ToolDefinition) -> list[str]:
    errors: list[str] = []
    assert definition.args_model is not None
    for key, field in definition.args_model.model_fields.items():
        if not field.title:
            errors.append(f"{definition.name}.{key}: 参数缺少 title。")
        if not field.description:
            errors.append(f"{definition.name}.{key}: 参数缺少 description。")
        extra = field.json_schema_extra or {}
        if not extra.get("x-ui-source"):
            errors.append(f"{definition.name}.{key}: 参数缺少 json_schema_extra.x-ui-source。")
    return errors


def _validate_manifest(manifest: ToolManifest) -> None:
    if manifest.tool_api_version != TOOL_API_VERSION:
        raise ToolProviderContractError(
            f"Provider {manifest.provider_id} 使用 tool_api_version={manifest.tool_api_version}，当前平台只支持 {TOOL_API_VERSION}。"
        )
    unknown_permissions = set(manifest.permissions) - SENSITIVE_PERMISSIONS
    if unknown_permissions:
        raise ToolProviderContractError(f"Provider {manifest.provider_id} 声明了未知权限：{sorted(unknown_permissions)}")


def _patch_provider_metadata(definition: ToolDefinition, manifest: ToolManifest) -> None:
    # ToolMetadata 是 frozen dataclass，但 meta 字典本身可变。
    #
    # provider 元数据写进 descriptor meta，前端和调试页仍然只消费统一 ToolDescriptor。
    definition.metadata.meta.setdefault("providerId", manifest.provider_id)
    definition.metadata.meta.setdefault("providerName", manifest.name)
    definition.metadata.meta.setdefault("providerVersion", manifest.version)
    definition.metadata.meta.setdefault("providerOwner", manifest.owner)
    definition.metadata.meta.setdefault("providerPermissions", list(manifest.permissions))
    definition.metadata.meta.setdefault("toolApiVersion", manifest.tool_api_version)


def _coerce_manifest(value: Any) -> ToolManifest:
    if isinstance(value, ToolManifest):
        return value
    if isinstance(value, dict):
        return ToolManifest.model_validate(value)
    raise ToolProviderContractError("Provider manifest 必须是 ToolManifest 或可校验的 dict。")


def _entry_points_by_name() -> dict[str, importlib_metadata.EntryPoint]:
    selected = importlib_metadata.entry_points()
    if hasattr(selected, "select"):
        points = selected.select(group=ENTRY_POINT_GROUP)
    else:
        points = selected.get(ENTRY_POINT_GROUP, [])  # pragma: no cover - Python 3.11 之前兼容
    return {point.name: point for point in points}


def _load_provider_from_entry_point(name: str, entry_points: dict[str, importlib_metadata.EntryPoint]) -> ToolProvider:
    point = entry_points.get(name)
    if point is None:
        raise ToolProviderContractError(f"未找到 allowlist 中的工具 provider entry point：{name}")
    return _instantiate_provider(point.load(), name)


def _load_provider_from_object_path(spec: str) -> ToolProvider:
    _ensure_cwd_import_path()
    module_name, object_name = spec.split(":", 1)
    if not module_name or not object_name:
        raise ToolProviderContractError(f"Provider spec 必须是 module:object：{spec}")
    module = importlib.import_module(module_name)
    return _instantiate_provider(getattr(module, object_name), spec)


def _instantiate_provider(candidate: Any, label: str) -> ToolProvider:
    provider = candidate() if inspect.isclass(candidate) else candidate
    if callable(provider) and not hasattr(provider, "list_definitions"):
        provider = provider()
    if not isinstance(provider, ToolProvider):
        raise ToolProviderContractError(f"Provider {label} 必须实现 ToolProvider 协议。")
    return provider


def _ensure_cwd_import_path() -> None:
    # module:object provider 通常指向当前仓库内模块。
    #
    # API、pytest 和 CLI 的 sys.path 不一定一致；显式加入 cwd 可以保证 allowlist
    # 中的仓库内 Provider 在三种入口都按同一规则加载。
    cwd = str(Path.cwd())
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
