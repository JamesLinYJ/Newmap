# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据能力包导出
#
#   文件:       __init__.py
#
#   日期:       2026年05月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 统一导出气象数据识别、解析、渲染和分析服务。

from .interpretation import (
    INTERPRETATION_SCHEMA,
    build_interpretation_facts,
    build_interpretation_prompt,
    build_map_candidates,
    normalize_interpretation_payload,
    select_interpretation_variables,
)
from .nowcast import (
    NOWCAST_ANSWER_SCHEMA,
    NowcastAnalysisService,
    NowcastProductProfile,
    NowcastSequenceService,
    NowcastTextService,
    WeatherSequence,
)
from .readers import GridQuery, GridSlice, WeatherDatasetIndex, WeatherReaderFacade, XarrayScientificReader
from .service import SUPPORTED_WEATHER_SUFFIXES, WeatherDataService, is_supported_weather_file

__all__ = [
    "INTERPRETATION_SCHEMA",
    "SUPPORTED_WEATHER_SUFFIXES",
    "NOWCAST_ANSWER_SCHEMA",
    "GridQuery",
    "GridSlice",
    "NowcastAnalysisService",
    "NowcastProductProfile",
    "NowcastSequenceService",
    "NowcastTextService",
    "WeatherDatasetIndex",
    "WeatherDataService",
    "WeatherReaderFacade",
    "WeatherSequence",
    "XarrayScientificReader",
    "build_interpretation_facts",
    "build_interpretation_prompt",
    "build_map_candidates",
    "is_supported_weather_file",
    "normalize_interpretation_payload",
    "select_interpretation_variables",
]
