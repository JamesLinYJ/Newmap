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
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("worker")

app = FastAPI(title="geo-agent-sidecar", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

RUNTIME_ROOT = Path(os.environ.get("RUNTIME_ROOT", "server/runtime")).resolve()


# --- Models ---

class WeatherInspectRequest(BaseModel):
    datasetId: str


class WeatherRenderRequest(BaseModel):
    datasetId: str
    variable: str | None = None
    timeIndex: int | None = None
    bbox: list[float] | None = None


class WeatherReportRequest(BaseModel):
    datasetId: str
    llmInterpretation: str
    outputPath: str


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
        from gis_weather.service import WeatherDataService

        service = WeatherDataService()
        dataset_dir = RUNTIME_ROOT / "weather"
        dataset_path = resolve_weather_dataset_file(dataset_dir, req.datasetId)
        info = service.inspect(dataset_path, filename=dataset_path.name)
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
        dataset_path = resolve_weather_dataset_file(RUNTIME_ROOT / "weather", req.datasetId)
        output_path = RUNTIME_ROOT / "weather" / req.datasetId / "render.png"
        result = service.render_heatmap(
            dataset_path,
            output_path=output_path,
            variable=req.variable,
            time_index=req.timeIndex,
            bbox=req.bbox,
        )
        return {"status": "ok", "result": result, "imagePath": str(output_path)}
    except Exception as e:
        logger.exception("render_raster failed")
        raise HTTPException(500, str(e))


@app.post("/weather/datasets/report")
async def generate_report(req: WeatherReportRequest):
    """生成气象数据 DOCX 报告"""
    try:
        from gis_weather.service import WeatherDataService

        if not req.llmInterpretation.strip():
            raise HTTPException(400, "llmInterpretation 不能为空")

        dataset_path = resolve_weather_dataset_file(RUNTIME_ROOT / "weather", req.datasetId)
        output_path = Path(req.outputPath).resolve()
        service = WeatherDataService()
        result = service.generate_report_docx(
            dataset_path,
            output_path=output_path,
            filename=dataset_path.name,
            dataset_id=req.datasetId,
            llm_interpretation=req.llmInterpretation,
        )
        return {"status": "ok", "report": result, "outputPath": str(output_path)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("generate_report failed")
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
    return {"status": "ok", "runtimeRoot": str(RUNTIME_ROOT)}


def resolve_weather_dataset_file(dataset_root: Path, dataset_id: str) -> Path:
    from gis_weather.service import is_supported_weather_file

    dataset_dir = dataset_root / dataset_id
    if not dataset_dir.is_dir():
        raise HTTPException(404, f"数据集 '{dataset_id}' 不存在")
    candidates = sorted(
        item for item in dataset_dir.iterdir()
        if item.is_file() and is_supported_weather_file(item.name)
    )
    if not candidates:
        raise HTTPException(404, f"数据集 '{dataset_id}' 没有可读取的气象文件")
    return candidates[0]


if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("WORKER_PORT", "8012"))
    uvicorn.run(app, host="0.0.0.0", port=port)
