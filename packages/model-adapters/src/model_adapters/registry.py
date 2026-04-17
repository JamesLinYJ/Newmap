# +-------------------------------------------------------------------------
#
#   地理智能平台 - 模型适配器注册表实现
#
#   文件:       registry.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from shared_types.schemas import ModelProviderDescriptor

from .base import BaseModelAdapter


class OpenAICompatibleAdapter(BaseModelAdapter):
    def __init__(self, *, base_url: str | None, api_key: str | None, default_model: str | None):
        super().__init__("openai_compatible")
        self.display_name = "OpenAI Compatible"
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key
        self.default_model = default_model

    def is_configured(self) -> bool:
        return bool(self.base_url and self.api_key and self.default_model)

    async def chat(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        model = kwargs.get("model") or self.default_model
        messages = kwargs.get("messages") or [{"role": "user", "content": prompt}]
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": kwargs.get("temperature", 0.1),
                },
            )
            response.raise_for_status()
            payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        return {"provider": self.provider, "content": content, "raw": payload, "model": model}


class AnthropicAdapter(BaseModelAdapter):
    def __init__(self, *, base_url: str, api_key: str | None, default_model: str | None, version: str):
        super().__init__("anthropic")
        self.display_name = "Anthropic"
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_model = default_model
        self.version = version

    def is_configured(self) -> bool:
        return bool(self.api_key and self.default_model)

    async def chat(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        model = kwargs.get("model") or self.default_model
        system = kwargs.get("system")
        messages = kwargs.get("messages") or [{"role": "user", "content": prompt}]
        anthropic_messages = []
        for message in messages:
            anthropic_messages.append(
                {
                    "role": message["role"],
                    "content": [{"type": "text", "text": message["content"]}],
                }
            )
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.base_url}/messages",
                headers={
                    "x-api-key": str(self.api_key),
                    "anthropic-version": self.version,
                    "content-type": "application/json",
                },
                json={
                    "model": model,
                    "system": system,
                    "max_tokens": kwargs.get("max_tokens", 1200),
                    "messages": anthropic_messages,
                },
            )
            response.raise_for_status()
            payload = response.json()
        texts = [item.get("text", "") for item in payload.get("content", []) if item.get("type") == "text"]
        return {"provider": self.provider, "content": "\n".join(texts).strip(), "raw": payload, "model": model}


class GeminiAdapter(BaseModelAdapter):
    def __init__(self, *, base_url: str, api_key: str | None, default_model: str | None):
        super().__init__("gemini")
        self.display_name = "Gemini"
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_model = default_model

    def is_configured(self) -> bool:
        return bool(self.api_key and self.default_model)

    async def chat(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        model = kwargs.get("model") or self.default_model
        messages = kwargs.get("messages") or [{"role": "user", "content": prompt}]
        contents = []
        for message in messages:
            role = "model" if message["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": message["content"]}]})
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.base_url}/models/{model}:generateContent",
                params={"key": self.api_key},
                json={"contents": contents, "generationConfig": {"temperature": kwargs.get("temperature", 0.1)}},
            )
            response.raise_for_status()
            payload = response.json()
        candidates = payload.get("candidates", [])
        parts = candidates[0]["content"]["parts"] if candidates else []
        texts = [part.get("text", "") for part in parts if "text" in part]
        return {"provider": self.provider, "content": "\n".join(texts).strip(), "raw": payload, "model": model}

    async def structured(self, prompt: str, schema: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        model = kwargs.get("model") or self.default_model
        contents = [{"role": "user", "parts": [{"text": prompt}]}]
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.base_url}/models/{model}:generateContent",
                params={"key": self.api_key},
                json={
                    "contents": contents,
                    "generationConfig": {
                        "temperature": kwargs.get("temperature", 0.1),
                        "responseMimeType": "application/json",
                        "responseSchema": schema,
                    },
                },
            )
            response.raise_for_status()
            payload = response.json()
        candidates = payload.get("candidates", [])
        parts = candidates[0]["content"]["parts"] if candidates else []
        texts = [part.get("text", "") for part in parts if "text" in part]
        return self._parse_json_payload("\n".join(texts).strip())


class OllamaAdapter(BaseModelAdapter):
    def __init__(self, *, base_url: str, default_model: str | None):
        super().__init__("ollama")
        self.display_name = "Ollama"
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model

    def is_configured(self) -> bool:
        return bool(self.base_url and self.default_model)

    async def chat(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        model = kwargs.get("model") or self.default_model
        messages = kwargs.get("messages") or [{"role": "user", "content": prompt}]
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": model,
                    "stream": False,
                    "messages": messages,
                    "options": {"temperature": kwargs.get("temperature", 0.1)},
                },
            )
            response.raise_for_status()
            payload = response.json()
        return {
            "provider": self.provider,
            "content": payload.get("message", {}).get("content", ""),
            "raw": payload,
            "model": model,
        }


@dataclass
class RegistrySettings:
    default_model_provider: str
    default_model_name: str | None
    openai_base_url: str | None
    openai_api_key: str | None
    openai_model: str | None
    anthropic_base_url: str
    anthropic_api_key: str | None
    anthropic_model: str | None
    anthropic_version: str
    gemini_base_url: str
    gemini_api_key: str | None
    gemini_model: str | None
    ollama_base_url: str
    ollama_model: str | None


class ModelAdapterRegistry:
    # ModelAdapterRegistry
    #
    # 根据配置装配 provider，并为运行时暴露统一的 provider 解析入口。
    def __init__(self, settings: RegistrySettings | Any):
        self._adapters: dict[str, BaseModelAdapter] = {}
        self.default_provider = settings.default_model_provider
        self.default_model_name = settings.default_model_name
        default_model_for = lambda provider: settings.default_model_name if settings.default_model_provider == provider else None

        self.register(
            OpenAICompatibleAdapter(
                base_url=settings.openai_base_url,
                api_key=settings.openai_api_key,
                default_model=settings.openai_model or default_model_for("openai_compatible"),
            )
        )
        self.register(
            AnthropicAdapter(
                base_url=settings.anthropic_base_url,
                api_key=settings.anthropic_api_key,
                default_model=settings.anthropic_model or default_model_for("anthropic"),
                version=settings.anthropic_version,
            )
        )
        self.register(
            GeminiAdapter(
                base_url=settings.gemini_base_url,
                api_key=settings.gemini_api_key,
                default_model=settings.gemini_model or default_model_for("gemini"),
            )
        )
        self.register(
            OllamaAdapter(
                base_url=settings.ollama_base_url,
                default_model=settings.ollama_model or default_model_for("ollama"),
            )
        )

    def register(self, adapter: BaseModelAdapter) -> None:
        self._adapters[adapter.provider] = adapter

    def get(self, provider: str) -> BaseModelAdapter:
        return self._adapters[provider]

    def list_providers(self) -> list[str]:
        return sorted(self._adapters)

    def resolve_provider(self, provider: str | None) -> BaseModelAdapter:
        configured = [adapter for adapter in self._adapters.values() if adapter.is_configured()]
        selected = provider or self.default_provider
        if selected and selected in self._adapters:
            adapter = self.get(selected)
            if adapter.is_configured():
                return adapter
            raise RuntimeError(f"模型 provider '{selected}' 尚未配置，当前无法启动运行。")
        if self.default_provider and self.default_provider in self._adapters:
            adapter = self.get(self.default_provider)
            if adapter.is_configured():
                return adapter
        if configured:
            return configured[0]
        if self._adapters:
            available = ", ".join(sorted(self._adapters))
            raise RuntimeError(f"当前没有可用的模型 provider。已注册 provider: {available}")
        raise RuntimeError("当前没有注册任何模型 provider。")

    def is_provider_configured(self, provider: str | None) -> bool:
        if not provider or provider not in self._adapters:
            return False
        return self._adapters[provider].is_configured()

    def supports_live_supervisor(self, provider: str | None) -> bool:
        if not self.is_provider_configured(provider):
            return False
        return provider in {"openai_compatible", "anthropic", "gemini", "ollama"}

    def descriptors(self) -> list[ModelProviderDescriptor]:
        return [
            ModelProviderDescriptor(
                provider=adapter.provider,
                display_name=adapter.display_name,
                configured=adapter.is_configured(),
                default_model=adapter.default_model,
                capabilities=adapter.capabilities(),
            )
            for adapter in self._adapters.values()
        ]
