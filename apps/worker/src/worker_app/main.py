# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 入口
#
#   文件:       main.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 定义后台 worker 的启动逻辑、心跳与任务轮询行为。

from __future__ import annotations

import signal
import threading
import time

from api_app.artifact_store import ArtifactExportStore
from api_app.config import settings
from api_app.platform_store import PostgresPlatformStore
from api_app.weather_core import process_weather_parse_job
from gis_weather import WeatherDataService


def main() -> None:
    # Worker 入口
    #
    # 当前后台任务以数据库为队列事实源：普通上传不再自动入队，
    # 只有显式 parse job 才由 worker 领取并推进解析状态。
    stop_event = threading.Event()
    database_url = settings.effective_database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL is required for worker.")
    artifact_store = ArtifactExportStore(settings.resolved_runtime_root)
    store = PostgresPlatformStore(database_url, artifact_store=artifact_store)
    store.ensure_schema()
    weather_service = WeatherDataService()

    def _handle_shutdown(signum, _frame) -> None:
        print(f"geo-agent-platform worker shutting down on signal {signum}.", flush=True)
        stop_event.set()

    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    print("geo-agent-platform worker is online and waiting for queued tasks.", flush=True)
    while not stop_event.is_set():
        job = store.claim_next_weather_job()
        if job is None:
            if stop_event.wait(timeout=10):
                break
            print(f"geo-agent-platform worker heartbeat {int(time.time())}.", flush=True)
            continue
        print(f"weather job {job.job_id} started for dataset {job.dataset_id}.", flush=True)
        process_weather_parse_job(store, weather_service, job.job_id)
        finished = store.get_weather_job(job.job_id)
        print(f"weather job {job.job_id} finished with status {finished.status}.", flush=True)


if __name__ == "__main__":
    main()
