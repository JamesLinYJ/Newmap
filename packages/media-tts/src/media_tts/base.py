"""TTS 引擎抽象基类。

提供统一的文本转语音接口，方便在 ChatTTS、Azure TTS、Edge TTS
等后端之间无缝切换。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class VoiceOption:
    """音色选项。"""
    id: str
    name: str
    gender: str = "neutral"
    description: str = ""


@dataclass
class TTSResult:
    """TTS 合成结果。"""
    audio_path: Path
    """输出的音频文件路径。"""
    duration_ms: int = 0
    """音频时长（毫秒）。"""
    voice: str = ""
    """使用的音色 ID。"""
    text: str = ""
    """原始输入文本。"""


class BaseTTSEngine(ABC):
    """TTS 引擎抽象基类。

    所有 TTS 后端必须实现 synthesize() 和 list_voices()。
    """

    @abstractmethod
    async def synthesize(
        self, text: str, voice: str | None = None,
    ) -> TTSResult:
        """将文本合成为音频文件。

        Args:
            text: 要合成的文本（支持 SSML 标记）。
            voice: 音色 ID，None 则使用默认音色。

        Returns:
            TTSResult，包含音频文件路径和元数据。
        """
        ...

    @abstractmethod
    def list_voices(self) -> list[VoiceOption]:
        """返回可用的音色列表。"""
        ...

    def is_available(self) -> bool:
        """检查引擎是否可用（依赖已安装、模型已下载等）。"""
        return True
