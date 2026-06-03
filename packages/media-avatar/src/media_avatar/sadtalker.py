"""SadTalker 数字人引擎（预留）。

SadTalker 是开源的单图+音频→说话视频方案，头部姿态丰富，
但推理速度比 MuseTalk 慢约 10 倍。完成 MuseTalk 后按需实现。
"""

from __future__ import annotations

from pathlib import Path

from .base import BaseDigitalHuman, VideoResult


class SadTalkerDigitalHuman(BaseDigitalHuman):
    """SadTalker 数字人引擎。

    Usage (future):
        avatar = SadTalkerDigitalHuman(sadtalker_root="/path/to/SadTalker")
        result = await avatar.generate(audio_path=Path("output.wav"))
    """

    def __init__(
        self,
        sadtalker_root: str | None = None,
        default_avatar: str | None = None,
    ):
        self._root = Path(sadtalker_root) if sadtalker_root else None
        self._avatar = Path(default_avatar) if default_avatar else None

    async def generate(
        self,
        audio_path: Path,
        avatar_path: Path | None = None,
        output_path: Path | None = None,
    ) -> VideoResult:
        raise NotImplementedError(
            "SadTalker 引擎尚未实现。请使用 MuseTalkDigitalHuman。"
        )

    def is_available(self) -> bool:
        if self._root is None:
            return False
        return (self._root / "inference.py").exists()
