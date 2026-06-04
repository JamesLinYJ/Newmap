# +-------------------------------------------------------------------------
#
#   地理智能平台 - 默认工作台会话测试
#
#   文件:       test_default_session.py
#
#   日期:       2026年06月03日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证普通入口历史归属由服务端默认 session 决定，
# 而不是由浏览器 localStorage 临时创建的新 session 决定。

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from api_app.platform_store import PostgresPlatformStore
from api_app.routers import sessions as session_routes
from shared_types.exceptions import NotFoundError
from shared_types.schemas import SessionRecord


class _FakeDefaultSessionStore(PostgresPlatformStore):
    # 轻量 store fake。
    #
    # 只实现 get_or_create_default_session 需要的读写边界，
    # 避免把这个策略测试变成 DB 集成测试。
    def __init__(self) -> None:
        self.sessions: dict[str, SessionRecord] = {}
        self.saved_session_ids: list[str] = []

    def get_session(self, session_id: str) -> SessionRecord:
        try:
            return self.sessions[session_id]
        except KeyError as exc:
            raise NotFoundError("会话不存在。") from exc

    def save_session(self, session: SessionRecord) -> None:
        self.sessions[session.id] = session
        self.saved_session_ids.append(session.id)


def test_default_session_is_stable_server_anchor() -> None:
    # 首次访问创建固定 ID，后续访问复用同一条服务端记录。
    store = _FakeDefaultSessionStore()

    first = store.get_or_create_default_session()
    second = store.get_or_create_default_session()

    assert first.id == PostgresPlatformStore.DEFAULT_SESSION_ID
    assert second is first
    assert store.saved_session_ids == [PostgresPlatformStore.DEFAULT_SESSION_ID]


def test_existing_default_session_is_reused_without_recreate() -> None:
    # 已存在默认 session 时不能再生成新的 browser-local session。
    timestamp = datetime(2026, 6, 3, tzinfo=timezone.utc)
    existing = SessionRecord(
        id=PostgresPlatformStore.DEFAULT_SESSION_ID,
        created_at=timestamp,
        share_token="existing-default-token",
    )
    store = _FakeDefaultSessionStore()
    store.sessions[existing.id] = existing

    assert store.get_or_create_default_session() is existing
    assert store.saved_session_ids == []


@pytest.mark.asyncio
async def test_default_session_route_uses_store_anchor() -> None:
    # 路由层只暴露服务端默认 session，不参与浏览器指针决策。
    store = _FakeDefaultSessionStore()

    record = await session_routes.get_default_session(store=store)

    assert record.id == PostgresPlatformStore.DEFAULT_SESSION_ID
