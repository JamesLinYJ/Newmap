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

from .service import SUPPORTED_WEATHER_SUFFIXES, WeatherDataService, is_supported_weather_file

__all__ = [
    "SUPPORTED_WEATHER_SUFFIXES",
    "WeatherDataService",
    "is_supported_weather_file",
]
