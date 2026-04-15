from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

import psycopg


def connect_postgres(database_url: str):
    try:
        return psycopg.connect(database_url, autocommit=True, connect_timeout=2)
    except psycopg.OperationalError as exc:
        raise psycopg.OperationalError(
            f"Postgres connection failed for '{_redact_database_url(database_url)}': {exc.__class__.__name__}: {exc}"
        ) from exc


def redact_database_url(database_url: str) -> str:
    return _redact_database_url(database_url)


def _redact_database_url(database_url: str) -> str:
    try:
        parts = urlsplit(database_url)
    except Exception:
        return "<redacted>"

    hostname = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    username = parts.username or ""
    netloc = f"{username}:***@{hostname}{port}" if username else f"{hostname}{port}"
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))
