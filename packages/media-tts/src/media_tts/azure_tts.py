"""Azure TTS 引擎（预留）。

Azure Cognitive Services 提供 30+ 中文神经语音，免费层 50 万字符/月。
完成 ChatTTS 集成后按需实现。
"""

from __future__ import annotations

from .base import BaseTTSEngine, TTSResult, VoiceOption


class AzureTTSEngine(BaseTTSEngine):
    """Azure Cognitive Services TTS 引擎。

    Usage (future):
        engine = AzureTTSEngine(
            subscription_key="...",
            region="eastasia",
        )
        result = await engine.synthesize("你好世界")
    """

    def __init__(
        self,
        subscription_key: str = "",
        region: str = "eastasia",
    ):
        self._key = subscription_key
        self._region = region

    async def synthesize(
        self, text: str, voice: str | None = None,
    ) -> TTSResult:
        raise NotImplementedError(
            "Azure TTS 引擎尚未实现。请使用 ChatTTSEngine。"
        )

    def list_voices(self) -> list[VoiceOption]:
        return []

    def is_available(self) -> bool:
        try:
            import azure.cognitiveservices.speech  # noqa: F401
            return bool(self._key and self._region)
        except ImportError:
            return False
