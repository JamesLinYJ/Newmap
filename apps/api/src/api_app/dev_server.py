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

from pathlib import Path

import uvicorn

from .config import settings


def _reload_dirs() -> list[str]:
    # API 热重载边界。
    #
    # 只监听 API 主服务和它直接依赖的本地 packages，避免改前端或测试
    # 时把 API 进程误重启，影响长时间 Agent 调试。
    root = Path(__file__).resolve().parents[4]
    candidates = [
        root / "apps/api/src",
        root / "packages/agent-core/src",
        root / "packages/gis-common/src",
        root / "packages/gis-postgis/src",
        root / "packages/gis-weather/src",
        root / "packages/model-adapters/src",
        root / "packages/shared-types/src",
        root / "packages/tool-registry/src",
    ]
    return [str(path) for path in candidates if path.exists()]


def main() -> None:
    # 开发服务器绑定地址。
    #
    # API_HOST/API_PORT 是唯一入口；换端口不需要改 package.json 或源码调用点。
    uvicorn.run(
        "api_app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.app_env == "development",
        reload_dirs=_reload_dirs() if settings.app_env == "development" else None,
    )


if __name__ == "__main__":
    main()
