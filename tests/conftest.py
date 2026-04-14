from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest_asyncio

from api_app.main import app


@pytest_asyncio.fixture
async def api_client() -> AsyncIterator[httpx.AsyncClient]:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client
