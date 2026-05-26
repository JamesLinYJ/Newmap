# +-------------------------------------------------------------------------
#
#   地理智能平台 - 模型适配器基础抽象
#
#   文件:       base.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 定义模型适配器的基础协议、能力声明和通用 JSON 解析辅助逻辑。

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Literal

AgentsSdkFinalOutputContract = Literal["unsupported", "sdk_structured", "json_object", "plain_text"]


@dataclass(frozen=True)
class AgentsSdkCapabilities:
    # Agents SDK 能力声明
    #
    # live_supervisor 表示该 provider 可以接入 Agents SDK 的 agent loop / tools。
    # structured_output 表示可以使用 SDK output_type 触发的 json_schema response_format。
    # json_object_output 表示可以使用 Chat Completions JSON mode 的 json_object response_format。
    live_supervisor: bool = False
    structured_output: bool = False
    json_object_output: bool = False

    @property
    def final_output_contract(self) -> AgentsSdkFinalOutputContract:
        if not self.live_supervisor:
            return "unsupported"
        if self.structured_output:
            return "sdk_structured"
        if self.json_object_output:
            return "json_object"
        return "plain_text"


# BaseModelAdapter
#
# 各类模型 provider 的统一抽象层。
class BaseModelAdapter(ABC):
    def __init__(self, provider: str):
        self.provider = provider
        self.display_name = provider
        self.default_model: str | None = None

    @abstractmethod
    async def chat(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        raise NotImplementedError

    async def structured(self, prompt: str, schema: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        schema_text = json.dumps(schema, ensure_ascii=False, indent=2)
        response = await self.chat(
            (
                f"{prompt}\n\n"
                "请只返回一个 JSON 对象，不要包含 Markdown 代码块。\n"
                f"目标 Schema:\n{schema_text}"
            ),
            **kwargs,
        )
        content = self._extract_text(response)
        parsed = self._parse_json_payload(content)
        if not isinstance(parsed, dict):
            raise ValueError(f"{self.provider} did not return a JSON object.")
        return parsed

    async def stream(self, prompt: str, **kwargs: Any):
        response = await self.chat(prompt, **kwargs)
        yield response

    async def repair_tool_json(self, payload: str, **_: Any) -> dict[str, Any]:
        return {"repaired": payload}

    def is_configured(self) -> bool:
        return False

    def capabilities(self) -> list[str]:
        return ["chat", "structured", "stream", "repair_tool_json"]

    def agents_sdk_capabilities(self, model_name: str | None = None) -> AgentsSdkCapabilities:
        return AgentsSdkCapabilities()

    def _extract_text(self, response: dict[str, Any]) -> str:
        return str(response.get("content", "")).strip()

    def _parse_json_payload(self, content: str) -> Any:
        fenced = re.search(r"```(?:json)?\s*(.*?)```", content, re.S)
        if fenced:
            content = fenced.group(1).strip()
        decoder = json.JSONDecoder()
        try:
            value, _ = decoder.raw_decode(content)
            return value
        except json.JSONDecodeError:
            start = content.find("{")
            end = content.rfind("}")
            if start != -1 and end != -1 and end > start:
                return json.loads(content[start : end + 1])
            raise
