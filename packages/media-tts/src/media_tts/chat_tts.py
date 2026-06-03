"""ChatTTS 引擎实现。

ChatTTS 是当前中文开源 TTS 中效果最好的方案，支持笑声、停顿、
语气词等自然韵律，无需 API Key。
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path

from .base import BaseTTSEngine, TTSResult, VoiceOption

logger = logging.getLogger(__name__)


class ChatTTSEngine(BaseTTSEngine):
    """ChatTTS 文本转语音引擎。

    首次初始化会自动下载模型（约 1GB），后续调用使用缓存。
    支持多种中文音色，音色通过 seed 控制随机采样。

    Usage:
        engine = ChatTTSEngine()
        await engine.initialize()
        result = await engine.synthesize("今天杭州市气温28度，有暴雨预警。")
        print(result.audio_path)
    """

    def __init__(
        self,
        model_dir: str | None = None,
        device: str = "cpu",
        default_speaker_seed: int = 2,
    ):
        self._model_dir = model_dir
        self._device = device
        self._default_speaker_seed = default_speaker_seed
        self._chat: object | None = None
        self._initialized = False
        # ChatTTS 用随机种子模拟不同音色
        self._voice_seeds: dict[str, int] = {
            "default": 2,
            "female_warm": 111,
            "female_bright": 333,
            "male_deep": 777,
            "male_calm": 999,
            "news_anchor": 555,
        }

    async def initialize(self) -> None:
        """加载 ChatTTS 模型（异步包装，避免阻塞事件循环）。"""
        if self._initialized:
            return
        loop = asyncio.get_running_loop()
        self._chat = await loop.run_in_executor(None, self._load_model)
        self._initialized = True

    def _load_model(self):
        """在后台线程中加载模型（ChatTTS 的 load 是同步的）。"""
        import ChatTTS
        chat = ChatTTS.Chat()
        chat.load(
            source="huggingface" if self._model_dir is None else "local",
            local_path=self._model_dir,
            device=self._device,
        )
        return chat

    async def synthesize(
        self, text: str, voice: str | None = None,
    ) -> TTSResult:
        """合成文本为音频。

        Args:
            text: 输入文本。支持 ChatTTS 特殊标记：
                  [laugh] — 笑声，[uv_break] — 停顿，
                  [lbreak] — 长停顿。
            voice: 音色种子名或数字种子。None 使用默认音色。

        Returns:
            TTSResult 包含 wav 文件路径。
        """
        await self.initialize()

        seed = self._resolve_seed(voice)
        params = self._build_params(text, seed)

        output = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        output_path = Path(output.name)

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._synthesize_sync, params, str(output_path))

        # 估算时长：~4 字符/秒 中文朗读速度
        duration_ms = int(len(text) / 4 * 1000)

        return TTSResult(
            audio_path=output_path,
            duration_ms=duration_ms,
            voice=voice or "default",
            text=text,
        )

    def _build_params(self, text: str, seed: int) -> dict:
        """构建 ChatTTS 推理参数。"""
        import torch
        rand_spk = self._chat.sample_random_speaker() if self._chat else None
        return {
            "text": [text],
            "stream": False,
            "lang": "zh",
            "skip_refine_text": False,
            "refine_text_only": False,
            "use_decoder": True,
            "do_text_normalization": True,
            "do_homophone_replacement": True,
            "params_refine_text": {"prompt": "[oral_2][laugh_0][break_4]"},
            "rand_spk": rand_spk,
            "seed": seed,
        }

    def _synthesize_sync(self, params: dict, output_path: str) -> None:
        """同步执行推理（在 run_in_executor 中调用）。"""
        import torch
        import torchaudio

        wavs = self._chat.infer(**params)
        if wavs and len(wavs) > 0:
            audio = wavs[0]
            if not isinstance(audio, torch.Tensor):
                audio = torch.from_numpy(audio) if hasattr(audio, "__array__") else audio
            torchaudio.save(output_path, audio.unsqueeze(0) if audio.dim() == 1 else audio, 24000)
        else:
            raise RuntimeError("ChatTTS 推理未产生音频输出")

    def _resolve_seed(self, voice: str | None) -> int:
        """解析音色为随机种子。"""
        if voice is None:
            return self._default_speaker_seed
        if voice.isdigit():
            return int(voice)
        return self._voice_seeds.get(voice, self._default_speaker_seed)

    def list_voices(self) -> list[VoiceOption]:
        return [
            VoiceOption(id=name, name=label, description=f"seed={seed}")
            for name, seed in self._voice_seeds.items()
            for label in [
                name.replace("_", " ").title()
            ]
        ]

    def is_available(self) -> bool:
        try:
            import ChatTTS  # noqa: F401
            return True
        except ImportError:
            return False
