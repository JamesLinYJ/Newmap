from __future__ import annotations

import signal
import threading
import time


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
