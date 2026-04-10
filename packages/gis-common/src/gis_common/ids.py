from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)

