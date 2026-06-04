# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 上下文管理测试
#
#   文件:       test_agent_context_manager.py
#
#   日期:       2026年05月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证 live supervisor 只消费 context index 与显式记忆文件，
# 不回扫旧 run/event 拼接上下文。

from __future__ import annotations

from datetime import datetime, timezone

from agent_core.context_manager import AgentContextManager
from shared_types.schemas import (
    AgentFinalResponse,
    AgentStateModel,
    AnalysisRunRecord,
    ArtifactRef,
    ContextEntryRecord,
    ContextReference,
    PlaceResolution,
    PlaceSearchCandidate,
    RuntimeContextConfig,
    ThreadContextRecord,
    ToolCall,
    ToolValueRef,
)
from api_app.platform_store import PostgresPlatformStore


def test_context_packet_uses_index_entries_and_excludes_current_run(tmp_path):
    # 当前 run 不能被注入为历史上下文。
    #
    # store 层收到 exclude_source_run_id 才算满足边界，context manager 不自行扫描 run。
    memory_file = tmp_path / "THREAD_CONTEXT.md"
    memory_file.write_text("A" * 120, encoding="utf-8")
    config = RuntimeContextConfig(
        memory_file_paths=["/THREAD_CONTEXT.md"],
        prompt_max_chars=260,
        context_entry_window=2,
        memory_file_char_limit=40,
    )
    store = _FakeContextStore()

    packet = AgentContextManager(store=store, config=config, project_root=tmp_path).build_live_packet(
        run_id="run_current",
        thread_id="thread_test",
    )

    assert store.exclude_source_run_id == "run_current"
    assert [item.reference_id for item in packet.references] == ["artifact:artifact_old"]
    assert "artifactId=artifact_old" not in packet.prompt_context
    assert "旧医院结果" not in packet.prompt_context
    assert "当前线程有 1 个已索引的历史上下文对象" in packet.prompt_context
    assert "list_context_references" in packet.prompt_context
    assert "THREAD_CONTEXT.md" in packet.prompt_context
    assert len(packet.prompt_context) <= config.prompt_max_chars + 40


def test_context_packet_without_index_returns_empty_context(tmp_path):
    # 缺 context index 时返回空上下文。
    #
    # 这里故意不给 store 实现 list_context_entries，确保不会回扫旧 run。
    packet = AgentContextManager(
        store=object(),
        config=RuntimeContextConfig(memory_file_paths=[]),
        project_root=tmp_path,
    ).build_live_packet(run_id="run_current", thread_id="thread_test")

    assert packet.references == []
    assert packet.entries == []
    assert packet.prompt_context == ""


def test_invalid_memory_file_fails_loudly(tmp_path):
    # 显式记忆文件会进入 prompt 上下文。
    #
    # 编码损坏必须直接失败，不能丢字节后继续生成看似正常的上下文。
    memory_file = tmp_path / "BROKEN_MEMORY.md"
    memory_file.write_bytes(b"\xff\xfe\x00")
    manager = AgentContextManager(
        store=object(),
        config=RuntimeContextConfig(memory_file_paths=["/BROKEN_MEMORY.md"]),
        project_root=tmp_path,
    )

    try:
        manager.build_live_packet(run_id="run_current", thread_id=None)
    except ValueError as exc:
        assert "显式记忆文件不是有效 UTF-8" in str(exc)
    else:
        raise AssertionError("损坏的记忆文件不应被静默忽略。")


def test_repair_observation_is_bounded_and_fact_based(tmp_path):
    config = RuntimeContextConfig(
        memory_file_paths=[],
        prompt_max_chars=360,
        tool_call_window=1,
        artifact_window=1,
        warning_window=1,
    )
    state = AgentStateModel(
        session_id="session_test",
        user_query="查找医院",
        tool_results=[
            ToolCall(step_id="old", tool="old_tool", args={}, status="completed", message="旧工具结果"),
            ToolCall(step_id="new", tool="new_tool", args={}, status="completed", message="新工具结果"),
        ],
        warnings=["旧告警", "新告警"],
    )
    packet = AgentContextManager(
        store=object(),
        config=config,
        project_root=tmp_path,
    ).build_repair_observation(
        query="查找医院",
        validation_error=RuntimeError("没有产出可交付结果"),
        run_state=state,
        packet=_FakePacket("历史上下文事实"),
    )

    assert "没有产出可交付结果" in packet
    assert "new_tool" in packet
    assert "old_tool" not in packet
    assert "新告警" in packet
    assert "旧告警" not in packet
    assert len(packet) <= config.prompt_max_chars + 40


def test_final_response_repair_uses_current_nowcast_texts_not_history_search(tmp_path):
    # 最终答复格式修正不是新一轮检索。
    #
    # 短临问答文本已经是当前 run 的 forecast_text valueRef；repair prompt
    # 必须稳定携带它，并禁止继续 search_thread_context 刷历史。
    config = RuntimeContextConfig(
        memory_file_paths=[],
        prompt_max_chars=1200,
        tool_call_window=2,
        artifact_window=1,
        warning_window=1,
    )
    forecast_ref = ToolValueRef(
        ref_id="value:forecast:qa",
        kind="forecast_text",
        label="短临问答文本",
        value="市民中心未来三小时不会下雨，您可以放心出门。",
        source_tool="answer_nowcast_question",
    )
    state = AgentStateModel(
        session_id="session_test",
        user_query="生成杭州短临预报并回答市民中心天气。",
        tool_value_refs=[forecast_ref],
        tool_results=[
            ToolCall(step_id="analysis", tool="analyze_nowcast_precipitation", args={}, status="completed", message="已完成短临降水分析。"),
            ToolCall(step_id="answer", tool="answer_nowcast_question", args={}, status="completed", message="市民中心未来三小时不会下雨，您可以放心出门。", value_refs=[forecast_ref]),
            ToolCall(step_id="search1", tool="search_thread_context", args={"query": "nowcast"}, status="completed", message="已检索当前对话上下文，找到 0 条相关记录。"),
            ToolCall(step_id="search2", tool="search_thread_context", args={"query": "forecast"}, status="completed", message="已检索当前对话上下文，找到 0 条相关记录。"),
        ],
    )

    packet = AgentContextManager(
        store=object(),
        config=config,
        project_root=tmp_path,
    ).build_repair_observation(
        query=state.user_query,
        validation_error=RuntimeError("OpenAI Agents SDK 没有产出合格的结构化最终答复。"),
        run_state=state,
        packet=_FakePacket("当前线程有 2 个已索引的历史上下文对象"),
    )

    assert "这是最终答复格式修正，不是新一轮分析" in packet
    assert "禁止再调用 list_context_references、search_thread_context" in packet
    assert "市民中心未来三小时不会下雨" in packet
    assert "answer_nowcast_question" in packet
    assert "analyze_nowcast_precipitation" in packet
    assert "当前 run 已调用上下文工具 2 次" in packet
    assert "可用线程上下文：" not in packet


def test_run_context_projection_creates_executable_entries():
    # run 完成后投影到 context index 的内容必须携带可执行引用。
    #
    # 这是 store/schema 的纯函数侧测试，不需要连接真实 Postgres。
    timestamp = datetime.now(timezone.utc)
    run = AnalysisRunRecord(
        id="run_done",
        thread_id="thread_test",
        session_id="session_test",
        user_query="查找澳门医院",
        status="completed",
        created_at=timestamp,
        updated_at=timestamp,
        state=AgentStateModel(
            session_id="session_test",
            thread_id="thread_test",
            user_query="查找澳门医院",
            final_response=AgentFinalResponse(summary="已生成澳门医院结果。"),
            place_resolution=PlaceResolution(
                status="resolved",
                query="澳门",
                provider="geocode",
                selected=PlaceSearchCandidate(label="澳门", latitude=22.1987, longitude=113.5439),
            ),
            artifacts=[
                ArtifactRef(
                    artifact_id="artifact_hospital",
                    run_id="run_done",
                    artifact_type="geojson",
                    name="澳门医院",
                    uri="/api/v1/results/artifact_hospital/geojson",
                )
            ],
            tool_results=[
                ToolCall(step_id="step_geo", tool="geocode_place", args={}, status="completed", message="已解析澳门。")
            ],
        ),
    )

    entries = PostgresPlatformStore._build_context_entries_for_run(run)
    by_kind = {entry.kind: entry for entry in entries if entry.reference is not None}

    assert by_kind["place"].reference.collection_ref == "context_place_run_done"
    assert by_kind["artifact"].reference.artifact_id == "artifact_hospital"
    assert by_kind["artifact"].reference.collection_ref == "context_artifact_artifact_hospital"
    assert any(entry.kind == "tool" and entry.label == "geocode_place" for entry in entries)


class _FakePacket:
    def __init__(self, prompt_context: str):
        self.prompt_context = prompt_context


class _FakeContextStore:
    def __init__(self):
        timestamp = datetime.now(timezone.utc)
        self.exclude_source_run_id: str | None = None
        self.entries = [
            ContextEntryRecord(
                context_entry_id="context_old_artifact",
                session_id="session_test",
                thread_id="thread_test",
                source_run_id="run_old",
                kind="artifact",
                label="旧医院结果",
                summary="旧医院结果 artifact。",
                reference=ContextReference(
                    reference_id="artifact:artifact_old",
                    kind="artifact",
                    label="旧医院结果",
                    artifact_id="artifact_old",
                    collection_ref="context_artifact_old",
                    usable_as=["collection", "artifact"],
                ),
                search_text="医院 artifact_old",
                created_at=timestamp,
                updated_at=timestamp,
            )
        ]
        self.snapshot = ThreadContextRecord(
            thread_id="thread_test",
            session_id="session_test",
            summary_text="线程摘要。",
            entry_count=1,
            updated_at=timestamp,
        )

    def list_context_entries(self, thread_id: str, *, limit: int, exclude_source_run_id: str):
        self.exclude_source_run_id = exclude_source_run_id
        return self.entries[:limit]

    def get_thread_context(self, thread_id: str):
        return self.snapshot
