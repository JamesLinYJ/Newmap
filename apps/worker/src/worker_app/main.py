# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 入口
#
#   文件:       main.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import signal
import threading
import time


# Worker 入口
#
# 当前 worker 仅维持进程生命周期与心跳，后续可扩展为真正的后台任务消费者。
def main() -> None:
    stop_event = threading.Event()

    def _handle_shutdown(signum, _frame) -> None:
        print(f"geo-agent-platform worker shutting down on signal {signum}.", flush=True)
        stop_event.set()

    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    print("geo-agent-platform worker is online and waiting for queued tasks.", flush=True)
    while not stop_event.wait(timeout=30):
        print(f"geo-agent-platform worker heartbeat {int(time.time())}.", flush=True)


if __name__ == "__main__":
    main()
