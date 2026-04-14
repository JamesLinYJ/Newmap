# +-------------------------------------------------------------------------
#
#   地理智能平台 - 标识与时间工具
#
#   文件:       ids.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4


# ID 与时间戳辅助函数。
def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
