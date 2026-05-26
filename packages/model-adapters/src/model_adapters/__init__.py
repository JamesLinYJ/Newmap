# +-------------------------------------------------------------------------
#
#   地理智能平台 - 模型适配器包导出
#
#   文件:       __init__.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 统一暴露模型适配器注册表和基础抽象。

from .base import AgentsSdkCapabilities, AgentsSdkFinalOutputContract, BaseModelAdapter
from .registry import ModelAdapterRegistry, RegistrySettings

__all__ = [
    "AgentsSdkCapabilities",
    "AgentsSdkFinalOutputContract",
    "BaseModelAdapter",
    "ModelAdapterRegistry",
    "RegistrySettings",
]
