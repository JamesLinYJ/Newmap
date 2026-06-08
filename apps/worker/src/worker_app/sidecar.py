# +-------------------------------------------------------------------------
#
#   地理智能平台 - Python Sidecar（气象 + 媒体微服务）
#
#   文件:       sidecar.py
#
#   日期:       2026年06月05日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

"""轻量 HTTP 微服务，提供气象数据处理和媒体生成能力。
所有 agent 逻辑已迁移至 TypeScript server/，此服务仅保留 Python 专属库依赖。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("worker")

app = FastAPI(title="geo-agent-sidecar", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

RUNTIME_ROOT = Path("runtime")


# --- Models ---

class WeatherInspectRequest(BaseModel):
    datasetId: str


class WeatherRenderRequest(BaseModel):
    datasetId: str
    variable: str | None = None
    timeIndex: int | None = None
    bbox: list[float] | None = None


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None


class AvatarRequest(BaseModel):
    audioPath: str
    avatarPath: str | None = None


# --- Weather ---

@app.post("/weather/datasets/inspect")
async def inspect_dataset(req: WeatherInspectRequest):
    """检查气象数据集结构"""
    try:
        # gis_weather 保留在此 worker 中
        from gis_weather.readers import GridQuery, WeatherDatasetIndex
        from gis_weather.service import WeatherDataService

        service = WeatherDataService()
        dataset_dir = RUNTIME_ROOT / "weather"
        datasets = service.list_datasets(str(dataset_dir))
        if req.datasetId not in datasets:
            raise HTTPException(404, f"数据集 '{req.datasetId}' 不存在")

        info = service.inspect_dataset(req.datasetId, str(dataset_dir))
        return {"status": "ok", "dataset": info}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("inspect_dataset failed")
        raise HTTPException(500, str(e))


@app.post("/weather/datasets/render")
async def render_raster(req: WeatherRenderRequest):
    """渲染气象栅格为 PNG"""
    try:
        from gis_weather.service import WeatherDataService
        service = WeatherDataService()
        result = service.render_raster(req.datasetId, variable=req.variable, time_index=req.timeIndex, bbox=req.bbox)
        return {"status": "ok", "imageBase64": result}
    except Exception as e:
        logger.exception("render_raster failed")
        raise HTTPException(500, str(e))


# --- Media ---

@app.post("/media/tts")
async def text_to_speech(req: TTSRequest):
    """文本转语音"""
    try:
        from media_tts.base import BaseTTSEngine
        from media_tts.azure_tts import AzureTTSEngine

        engine: BaseTTSEngine = AzureTTSEngine()
        if not engine.is_available():
            raise HTTPException(503, "TTS 引擎不可用")

        result = await engine.synthesize(req.text, req.voice)
        return {
            "status": "ok",
            "audioPath": str(result.audio_path),
            "durationMs": result.duration_ms,
            "voice": result.voice,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("tts failed")
        raise HTTPException(500, str(e))


@app.post("/media/avatar")
async def generate_avatar(req: AvatarRequest):
    """数字人视频生成"""
    try:
        from media_avatar.base import BaseDigitalHuman
        from media_avatar.musetalk import MuseTalkEngine

        engine: BaseDigitalHuman = MuseTalkEngine()
        if not engine.is_available():
            raise HTTPException(503, "数字人引擎不可用")

        result = await engine.generate(Path(req.audioPath), Path(req.avatarPath) if req.avatarPath else None)
        return {
            "status": "ok",
            "videoPath": str(result.video_path),
            "durationMs": result.duration_ms,
            "engine": result.engine,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("avatar failed")
        raise HTTPException(500, str(e))


# --- Health ---

@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8012)
