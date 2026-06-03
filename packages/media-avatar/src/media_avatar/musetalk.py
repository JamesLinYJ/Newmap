"""MuseTalk 数字人引擎。

MuseTalk 是腾讯开源的实时面部驱动模型：一张照片 + 一段音频 → 说话视频。
唇形同步精度高，推理速度快（实时），适合播报场景。
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from .base import BaseDigitalHuman, VideoResult

logger = logging.getLogger(__name__)


class MuseTalkDigitalHuman(BaseDigitalHuman):
    """MuseTalk 数字人引擎。

    输入音频 + 形象图片/视频，输出口型同步的说话视频。

    Usage:
        avatar = MuseTalkDigitalHuman(
            musetalk_root="/path/to/MuseTalk",
            default_avatar="/path/to/avatar.png",
        )
        result = await avatar.generate(
            audio_path=Path("output.wav"),
        )
        print(result.video_path)
    """

    def __init__(
        self,
        musetalk_root: str | None = None,
        default_avatar: str | None = None,
        device: str = "cpu",
    ):
        self._musetalk_root = Path(musetalk_root) if musetalk_root else None
        self._default_avatar = Path(default_avatar) if default_avatar else None
        self._device = device

    async def generate(
        self,
        audio_path: Path,
        avatar_path: Path | None = None,
        output_path: Path | None = None,
    ) -> VideoResult:
        """生成数字人播报视频。

        Args:
            audio_path: ChatTTS 或 Azure TTS 输出的音频文件。
            avatar_path: 形象图片/视频路径，None 使用默认形象。
            output_path: 输出 mp4 路径，None 生成临时文件。

        Returns:
            VideoResult。
        """
        avatar = avatar_path or self._default_avatar
        if avatar is None:
            raise ValueError(
                "未指定 avatar 形象，请提供 avatar_path 参数或设置默认形象"
            )
        if not audio_path.exists():
            raise FileNotFoundError(f"音频文件不存在: {audio_path}")

        output = output_path or Path(tempfile.mktemp(suffix=".mp4"))

        import subprocess
        import sys

        # MuseTalk 通过命令行调用：python inference.py --avatar ... --audio ...
        # 用户需要先 git clone MuseTalk 并安装依赖
        inference_script = (
            self._musetalk_root / "inference.py"
            if self._musetalk_root
            else Path("MuseTalk/inference.py")
        )

        cmd = [
            sys.executable,
            str(inference_script),
            "--avatar", str(avatar),
            "--audio", str(audio_path),
            "--output", str(output),
            "--device", self._device,
        ]

        logger.info("MuseTalk: %s", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

        if result.returncode != 0:
            raise RuntimeError(
                f"MuseTalk 执行失败 (exit {result.returncode}): {result.stderr}"
            )

        return VideoResult(
            video_path=output,
            duration_ms=0,  # 从音频推断
            width=512,
            height=512,
            engine="MuseTalk",
        )

    def is_available(self) -> bool:
        """检查 MuseTalk 是否已安装。"""
        if self._musetalk_root is None:
            return False
        return (self._musetalk_root / "inference.py").exists()
