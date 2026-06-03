"""数字人引擎抽象基类。

提供统一的数字人视频生成接口，支持在 MuseTalk、SadTalker、HeyGen API
等后端之间切换。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass
class VideoResult:
    """数字人视频生成结果。"""
    video_path: Path
    """输出的视频文件路径。"""
    duration_ms: int = 0
    """视频时长（毫秒）。"""
    width: int = 0
    height: int = 0
    """视频分辨率。"""
    engine: str = ""
    """使用的引擎名称。"""


class BaseDigitalHuman(ABC):
    """数字人引擎抽象基类。

    所有数字人后端必须实现 generate()。
    """

    @abstractmethod
    async def generate(
        self,
        audio_path: Path,
        avatar_path: Path | None = None,
        output_path: Path | None = None,
    ) -> VideoResult:
        """用音频驱动数字形象生成说话视频。

        Args:
            audio_path: 输入音频文件（wav/mp3）。
            avatar_path: 形象图片或视频。None 使用默认形象。
            output_path: 输出视频路径。None 自动生成临时文件。

        Returns:
            VideoResult 包含输出视频路径和元数据。
        """
        ...

    def is_available(self) -> bool:
        """检查引擎是否可用。"""
        return True
