# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 集成导出入口
#
#   文件:       __init__.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
# 模块职责
#
# 统一暴露 GIS-QGIS 包的公共客户端、运行器和工程构建能力，避免调用方直接依赖内部文件。
from .client import QgisRuntimeClient

__all__ = ["QgisRunner", "QgisRuntimeClient"]


def __getattr__(name: str):
    if name == "QgisRunner":
        from .runner import QgisRunner

        return QgisRunner
    raise AttributeError(name)
