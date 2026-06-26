# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象科学计算包入口
#
#   文件:       __init__.py
#
#   日期:       2026年06月25日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

"""Public domain services for Newmap meteorological execution."""

from .nowcast import (
    NowcastAnalysisService,
    NowcastProductProfile,
    NowcastSequenceService,
    NowcastTextService,
    build_analysis_scope,
)
from .service import (
    MeteorologicalDataService,
    MeteorologicalGrid,
    is_supported_meteorological_file,
)

__all__ = [
    "MeteorologicalDataService",
    "MeteorologicalGrid",
    "NowcastAnalysisService",
    "NowcastProductProfile",
    "NowcastSequenceService",
    "NowcastTextService",
    "build_analysis_scope",
    "is_supported_meteorological_file",
]
