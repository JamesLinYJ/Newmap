import re

_SAFE_IDENTIFIER = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")


def validate_gpkg_identifier(name: str) -> str:
    """校验 GPKG 表名只包含安全字符，防止 SQL 注入。"""
    if not _SAFE_IDENTIFIER.fullmatch(name):
        raise ValueError(f"非法的 GPKG 表名: {name!r}")
    return name
