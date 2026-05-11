# +-------------------------------------------------------------------------
#
#   地理智能平台 - ChatOpenAI 通用兼容层
#
#   文件:       compat_chat.py
#
#   日期:       2026年05月11日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# ChatOpenAI 在消息转换时会丢弃 provider 返回的非标准字段（如 DeepSeek 的
# reasoning_content）。CompatChatOpenAI 在接收和发送两个方向做通用透传：
# 任何不在标准字段集合中的键值对都会在 additional_kwargs 中保留，并在
# 后续请求中原样回传。

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage
from langchain_openai import ChatOpenAI

# ChatOpenAI 在两个转换点已处理的字段，不需要我们额外透传
_CONVERT_DICT_KEYS = frozenset({"role", "content", "name", "id", "function_call", "tool_calls", "audio"})
# 已由 _convert_message_to_dict 从 additional_kwargs 恢复的字段，或 LangChain 内部元数据
_OUTGOING_HANDLED = frozenset({"function_call", "tool_calls", "audio", "name", "parsed", "refusal", "__openai_role__"})


class CompatChatOpenAI(ChatOpenAI):
    """ChatOpenAI 兼容子类，双向透传 provider 非标准字段。

    任何 OpenAI-compatible API 在 message 中返回的额外字段会在接收时存入
    AIMessage.additional_kwargs，在后续请求时自动回填到对应的 message dict 中。
    """

    def _create_chat_result(self, response: dict | Any, generation_info: dict | None = None) -> Any:
        response_dict = response if isinstance(response, dict) else response.model_dump()
        extra_fields_by_index: dict[int, dict[str, Any]] = {}
        for i, choice in enumerate(response_dict.get("choices", [])):
            msg = choice.get("message") or {}
            extras = {k: v for k, v in msg.items() if k not in _CONVERT_DICT_KEYS}
            if extras:
                extra_fields_by_index[i] = extras

        chat_result = super()._create_chat_result(response, generation_info)

        for i, generation in enumerate(chat_result.generations):
            if i in extra_fields_by_index and isinstance(generation.message, AIMessage):
                generation.message.additional_kwargs.update(extra_fields_by_index[i])

        return chat_result

    def _get_request_payload(self, input_: Any, *, stop: list[str] | None = None, **kwargs: Any) -> dict:
        messages = self._convert_input(input_).to_messages()
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)

        payload_msgs = payload.get("messages", [])
        if len(payload_msgs) == len(messages):
            for msg, pmsg in zip(messages, payload_msgs):
                if isinstance(msg, AIMessage):
                    extras = {k: v for k, v in msg.additional_kwargs.items() if k not in _OUTGOING_HANDLED}
                    if extras:
                        pmsg.update(extras)

        return payload
