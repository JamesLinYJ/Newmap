"""media_tts — GIS 智能平台 TTS 抽象层。

提供统一的文本转语音接口，当前实现：
- ChatTTSEngine: 开源 ChatTTS，中文效果最优，免费
- AzureTTSEngine: Azure 神经语音（预留）

切换引擎只需改一行初始化代码。
"""

from .base import BaseTTSEngine, TTSResult, VoiceOption
from .chat_tts import ChatTTSEngine
from .azure_tts import AzureTTSEngine

__all__ = [
    "BaseTTSEngine",
    "TTSResult",
    "VoiceOption",
    "ChatTTSEngine",
    "AzureTTSEngine",
]
