# +-------------------------------------------------------------------------
#
#   地理智能平台 - GIS HTTP 工具
#
#   文件:       _http.py
#
#   日期:       2026年05月13日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# place_search / poi_search 共用的 SSL 上下文工具。
# HTTP/1.1 ALPN 限制是针对部分网络环境中 HTTP/2 协商被中间设备 RST 的兼容方案。

from __future__ import annotations

import ssl


def build_ssl_context() -> ssl.SSLContext:
    # 远程 GIS 目录请求的 TLS 边界。
    #
    # 这里不切换镜像、不吞异常，只统一客户端 TLS/ALPN 配置。
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.set_alpn_protocols(["http/1.1"])
    return ctx
