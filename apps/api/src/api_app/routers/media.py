"""媒体合成 API — TTS 语音 + 数字人视频。

提供文本转语音和数字人视频生成的 HTTP 端点，
结果缓存到 runtime/tts_cache/，按内容 hash 去重。
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/media", tags=["media"])

# ---- 缓存目录 ----
CACHE_DIR = Path("runtime/tts_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ---- TTS 引擎（惰性初始化） ----
_tts_engine = None


def _get_tts_engine():
    """惰性加载 ChatTTS 引擎（首次调用时才加载模型 ~1GB）。"""
    global _tts_engine
    if _tts_engine is None:
        from media_tts import ChatTTSEngine
        _tts_engine = ChatTTSEngine()
    return _tts_engine


# ---- 请求/响应模型 ----

class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="要合成的文本")


class TTSResponse(BaseModel):
    audio_url: str = Field(..., description="音频文件 URL")
    duration_ms: int = Field(0, description="音频时长（毫秒）")
    text_hash: str = Field("", description="文本 SHA256 哈希")
    cached: bool = Field(False, description="是否命中缓存")


# ---- 端点 ----

@router.post("/tts", response_model=TTSResponse)
async def synthesize_speech(req: TTSRequest):
    """文本转语音。结果按文本 hash 缓存到磁盘。"""
    text = req.text.strip()
    text_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
    cache_wav = CACHE_DIR / f"{text_hash}.wav"
    cache_txt = CACHE_DIR / f"{text_hash}.txt"
    index_file = CACHE_DIR / "index.json"

    # 缓存命中
    if cache_wav.exists():
        return TTSResponse(
            audio_url=f"/api/v1/media/tts/{text_hash}.wav",
            duration_ms=0,
            text_hash=text_hash,
            cached=True,
        )

    # 合成
    try:
        engine = _get_tts_engine()
        result = await engine.synthesize(text)
    except Exception as exc:
        logger.exception("TTS 合成失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"语音合成失败：{exc}")

    # 保存音频 + 文本 + 索引
    import shutil
    from datetime import datetime, timezone
    import json as _json
    shutil.copy(result.audio_path, cache_wav)
    cache_txt.write_text(text, encoding="utf-8")

    index: dict = {}
    if index_file.exists():
        try:
            index = _json.loads(index_file.read_text(encoding="utf-8"))
        except (_json.JSONDecodeError, OSError):
            index = {}
    index[text_hash] = {
        "text": text[:200],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "size_bytes": cache_wav.stat().st_size,
    }
    index_file.write_text(_json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    return TTSResponse(
        audio_url=f"/api/v1/media/tts/{text_hash}.wav",
        duration_ms=result.duration_ms,
        text_hash=text_hash,
        cached=False,
    )


@router.get("/tts/{hash_name}.wav")
async def serve_tts_audio(hash_name: str):
    """提供缓存的 TTS 音频文件。"""
    from fastapi.responses import FileResponse
    cache_path = CACHE_DIR / f"{hash_name}.wav"
    if not cache_path.exists():
        raise HTTPException(status_code=404, detail="音频文件不存在")
    return FileResponse(cache_path, media_type="audio/wav")


@router.post("/avatar")
async def generate_avatar():
    """数字人视频生成（预留）。"""
    raise HTTPException(status_code=501, detail="数字人视频生成尚未接入，需要先部署 MuseTalk")
