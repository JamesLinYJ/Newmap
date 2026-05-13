# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 开发服务器入口
#
#   文件:       dev_server.py
#
#   日期:       2026年05月13日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 从统一 Settings 读取 host/port 并启动 uvicorn，避免脚本或容器命令写死端口。

from __future__ import annotations

import uvicorn

from .config import settings


def main() -> None:
    # 开发服务器绑定地址。
    #
    # API_HOST/API_PORT 是唯一入口；换端口不需要改 package.json 或源码调用点。
    uvicorn.run(
        "api_app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.app_env == "development",
    )


if __name__ == "__main__":
    main()
