# +-------------------------------------------------------------------------
#
#   地理智能平台 - TTS 工具边界测试
#
#   文件:       test_tts_tool_boundary.py
#
#   日期:       2026年06月03日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证文本转语音工具不会在 Agent 工具阶段同步加载 ChatTTS，
# 避免长文本播报阻塞整轮 supervisor。

from __future__ import annotations

from types import SimpleNamespace

import pytest

from tool_registry import build_default_registry


@pytest.mark.asyncio
async def test_synthesize_speech_tool_returns_without_chattts_generation(tmp_path, monkeypatch):
    # 未命中缓存也只准备播报文本；真正合成由前端播放条按需请求媒体 API。
    monkeypatch.chdir(tmp_path)
    registry = build_default_registry()

    result = await registry.execute(
        "synthesize_speech",
        {"text": "这是一段需要播报的气象分析文字。"},
        SimpleNamespace(),
    )

    assert result.message == "已准备语音播报。"
    assert result.payload["cached"] is False
    assert result.payload["audio_url"] is None
    assert result.payload["text"] == "这是一段需要播报的气象分析文字。"
    assert (tmp_path / "runtime" / "tts_cache" / f"{result.payload['text_hash']}.txt").exists()
    assert not (tmp_path / "runtime" / "tts_cache" / f"{result.payload['text_hash']}.wav").exists()
