# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 应用初始化
#
#   文件:       qgis_app.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import os
import sys

from qgis.core import QgsApplication, QgsProcessingRegistry

_QGIS_APP: QgsApplication | None = None
_PROCESSING_READY = False
_QGIS_PLUGIN_PATH = "/usr/share/qgis/python/plugins"


# QGIS 应用初始化
#
# 统一管理 QgsApplication 与 Processing 插件的生命周期，避免不同调用点各自初始化。
def ensure_qgis_app() -> QgsApplication:
    global _QGIS_APP
    if _QGIS_APP is None:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        os.environ.setdefault("LANG", "C.UTF-8")
        os.environ.setdefault("LC_ALL", "C.UTF-8")
        if _QGIS_PLUGIN_PATH not in sys.path:
            sys.path.append(_QGIS_PLUGIN_PATH)
        QgsApplication.setPrefixPath("/usr", True)
        _QGIS_APP = QgsApplication([], False)
        _QGIS_APP.initQgis()
    return _QGIS_APP


def ensure_processing_registry() -> QgsProcessingRegistry:
    # Processing registry 初始化。
    global _PROCESSING_READY
    ensure_qgis_app()
    if not _PROCESSING_READY:
        from processing.core.Processing import Processing

        Processing.initialize()
        _PROCESSING_READY = True
    return QgsApplication.processingRegistry()
