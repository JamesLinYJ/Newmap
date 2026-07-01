# +-------------------------------------------------------------------------
#
#   地理智能平台 - Python 测试环境引导
#
#   文件:       conftest.py
#
#   日期:       2026年06月25日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

from __future__ import annotations

import sys
from pathlib import Path


# Python 测试以源码仓库为事实源运行，不要求开发者预先安装本地包。
#
# 这里只加入 GeoForge 自有包入口；第三方依赖仍由系统 Python 环境显式提供。
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATHS = [
    REPOSITORY_ROOT / "packages" / "gis-meteorology" / "src",
    REPOSITORY_ROOT / "apps" / "worker" / "src",
]

for source_path in SOURCE_PATHS:
    source_text = str(source_path)
    if source_path.is_dir() and source_text not in sys.path:
        sys.path.insert(0, source_text)
