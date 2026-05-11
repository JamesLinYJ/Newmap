# 共享 HTTP 工具
#
# place_search / poi_search / service 共用的 SSL 上下文与 HTTP 重试辅助。
# HTTP/1.1 ALPN 限制是针对部分网络环境中 HTTP/2 协商被中间设备 RST 的兼容方案。
from __future__ import annotations

import ssl
import time
from typing import Any, Callable, TypeVar

import httpx

T = TypeVar("T")


def build_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.set_alpn_protocols(["http/1.1"])
    return ctx


def request_with_mirror_fallback(
    *,
    urls: list[str],
    make_client: Callable[[str], httpx.Client],
    action: Callable[[httpx.Client], httpx.Response],
    parse: Callable[[httpx.Response], T],
    retries_per_url: int = 2,
    retry_delay: float = 0.3,
    retryable: tuple[type[Exception], ...] = (httpx.ConnectError, httpx.RemoteProtocolError, httpx.TimeoutException),
) -> T:
    last_error: Exception | None = None
    for base_url in urls:
        for attempt in range(retries_per_url):
            try:
                with make_client(base_url) as client:
                    response = action(client)
                    response.raise_for_status()
                    return parse(response)
            except retryable as exc:
                last_error = exc
                if attempt < retries_per_url - 1:
                    time.sleep(retry_delay)
                    continue
            break
    if last_error is None:
        raise RuntimeError("所有端点均不可达。")
    raise last_error
