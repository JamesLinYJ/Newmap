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

# ── ChatTTS 数字 normalizer 适配器 ────────────────────────────────────
# ChatTTS 的 tokenizer 合法字符集为 [一-鿿A-Za-z，。、,\. ]
# 不包括阿拉伯数字 0-9，导致数字被静默丢弃。
# 通过官方 Normalizer.register() 扩展点在编码前将阿拉伯数字转为中文。


class ChatTTSNormAdapter:
    """ChatTTS Normalizer 适配器——将阿拉伯数字转为中文数字。

    这是 ChatTTS normalizer 的注册函数，签名为 (str) -> str，
    由 Normalizer.register("zh", fn) 在模型加载时注入。
    """
    _CN_DIGITS = "零一二三四五六七八九"
    _CN_UNITS = ["", "十", "百", "千"]
    _CN_BIG = ["", "万", "亿"]

    @staticmethod
    def _int_to_cn(n: int) -> str:
        if n == 0:
            return "零"
        s = str(n)
        parts: list[str] = []
        nl = len(s)
        need_zero = False
        for i in range(nl):
            d = int(s[nl - 1 - i])
            if d == 0:
                need_zero = True
                continue
            if need_zero and parts:
                parts.append("零")
            need_zero = False
            unit = ChatTTSNormAdapter._CN_UNITS[i % 4]
            if unit == "十" and d == 1 and i == 1 and nl == 2:
                parts.append("十")
            else:
                parts.append(ChatTTSNormAdapter._CN_DIGITS[d] + unit)
        return "".join(reversed(parts))

    @staticmethod
    def cn_number_normalize(text: str) -> str:
        """将阿拉伯数字转为中文数字（ChatTTS normalizer 签名）。"""
        import re
        return re.sub(
            r"\d+(?:\.\d+)?",
            lambda m: ChatTTSNormAdapter._int_to_cn(
                int(m.group()) if "." not in m.group() else 0
            ) if "." not in m.group() else "".join(
                ChatTTSNormAdapter._CN_DIGITS[int(d)]
                for d in m.group().replace(".", "")
            ),
            text,
        )


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
        default_speaker_seed: int = 333,
    ):
        self._model_dir = model_dir
        self._device = device
        self._default_speaker_seed = default_speaker_seed
        self._chat: object | None = None
        self._initialized = False
        # ChatTTS 用随机种子控制音色（seed 只影响随机采样，不能指定男女）
        self._voice_seeds: dict[str, int] = {
            "default": 2,
            "female_warm": 111,
            "female_bright": 333,
            "male_deep": 777,
            "male_calm": 999,
            "news_anchor": 555,
        }

    async def initialize(self) -> None:
        """加载 ChatTTS 模型（异步包装）。"""
        if self._initialized:
            return
        loop = asyncio.get_running_loop()
        self._chat = await loop.run_in_executor(None, self._load_model)
        self._initialized = True

    def _load_model(self):
        """在后台线程中加载 ChatTTS 模型，注册中文数字 normalizer。

        ChatTTS 的 tokenizer 不支持阿拉伯数字（0-9 不在其合法字符集内），
        会直接丢弃。但模型本身能正确朗读中文数字（"二十八"）。
        ChatTTS 的 Normalizer.register() 正是为此设计的扩展点。
        """
        import ChatTTS
        chat = ChatTTS.Chat()
        load_kwargs: dict = {
            "source": "huggingface" if self._model_dir is None else "local",
            "device": self._device,
        }
        if self._model_dir is not None:
            load_kwargs["custom_path"] = self._model_dir
        chat.load(**load_kwargs)
        chat.normalizer.register("zh", ChatTTSNormAdapter.cn_number_normalize)
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
        """构建 ChatTTS infer 参数。

        在传入 ChatTTS 之前将阿拉伯数字转为中文——
        ChatTTS 的 tokenizer 不接受数字，但模型能朗读中文数字。
        """
        import ChatTTS
        normalized = ChatTTSNormAdapter.cn_number_normalize(text)
        return {
            "text": normalized if isinstance(normalized, list) else [normalized],
            "stream": False,
            "lang": "zh",
            "skip_refine_text": True,   # refine GPT 也会丢数字，跳过
            "do_text_normalization": True,  # 走 normalizer 管道（含我们的数字转中文）
            "do_homophone_replacement": True,
            "params_refine_text": ChatTTS.Chat.RefineTextParams(
                prompt="[oral_1][laugh_0][break_6]",
            ),
            "params_infer_code": ChatTTS.Chat.InferCodeParams(
                manual_seed=seed,
                spk_smp=None,  # 随机音色（ChatTTS 不支持直接指定男女）
            ),
        }

    def _synthesize_sync(self, params: dict, output_path: str) -> None:
        """同步执行 ChatTTS 推理并保存为 WAV 文件。"""
        import numpy as np
        import struct
        import wave

        result = self._chat.infer(**params)
        # v0.2+ 返回可能是 list[ndarray] 或 list[Tensor]
        if isinstance(result, list) and len(result) > 0:
            audio = result[0]
        else:
            raise RuntimeError(f"ChatTTS 未返回有效音频: {type(result)}")

        # 统一转为 numpy float32
        if hasattr(audio, "cpu"):  # torch.Tensor
            audio = audio.cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim == 2 and audio.shape[0] == 1:
            audio = audio[0]

        # 转为 16-bit PCM
        audio_pcm = (audio * 32767).clip(-32768, 32767).astype(np.int16)

        with wave.open(output_path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(24000)
            wf.writeframes(audio_pcm.tobytes())

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
