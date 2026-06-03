"""media_avatar — GIS 智能平台 数字人播报抽象层。

提供统一的数字人视频生成接口，当前实现：
- MuseTalkDigitalHuman: 腾讯开源，实时面部驱动，免费

后续可接入：SadTalker、HeyGen API、D-ID 等。
"""

from .base import BaseDigitalHuman, VideoResult
from .musetalk import MuseTalkDigitalHuman
from .sadtalker import SadTalkerDigitalHuman

__all__ = [
    "BaseDigitalHuman",
    "VideoResult",
    "MuseTalkDigitalHuman",
    "SadTalkerDigitalHuman",
]
