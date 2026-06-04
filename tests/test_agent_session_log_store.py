# +-------------------------------------------------------------------------
#
#   地理智能平台 - Agent 会话日志测试
#
#   文件:       test_agent_session_log_store.py
#
#   日期:       2026年05月21日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证 Agent thread/run/event/context 的 JSONL 事实源边界。

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

import pytest

from api_app.session_log_store import AgentSessionLogStore
from shared_types.schemas import (
    AgentFinalResponse,
    AgentStateModel,
    AgentThreadRecord,
    AnalysisRunRecord,
    ContextEntryRecord,
    ContextReference,
    EventType,
    RunEvent,
)


def test_session_log_uses_expected_directory_filename_and_jsonl_shape(tmp_path):
    # 首行必须是 session_meta，且 JSONL 顶层只允许 timestamp/type/payload。
    timestamp = datetime(2026, 5, 21, 6, 3, 18, tzinfo=timezone.utc)
    store = AgentSessionLogStore(tmp_path / "sessions", cwd=tmp_path)
    thread = store.create_thread(_thread(created_at=timestamp, updated_at=timestamp))

    path = store.get_thread_log_path(thread.id)
    assert path.relative_to(tmp_path / "sessions").parts[:3] == ("2026", "05", "21")
    assert re.match(r"rollout-2026-05-21T14-03-18-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl", path.name)

    first = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert set(first) == {"timestamp", "type", "payload"}
    assert first["type"] == "session_meta"
    assert first["timestamp"].endswith("Z")
    assert first["payload"]["threadId"] == thread.id


def test_single_thread_appends_multiple_runs_to_one_log(tmp_path):
    # 一个 thread 对应一个日志文件，多轮 run 只追加 turn/run 快照。
    store = AgentSessionLogStore(tmp_path / "sessions", cwd=tmp_path)
    thread = store.create_thread(_thread())
    first = _run("run_first", thread.id)
    second = _run("run_second", thread.id)

    store.save_run(first)
    store.save_run(second)

    assert store.get_run("run_first").session_log_path == store.get_run("run_second").session_log_path
    assert [item.id for item in store.list_runs_for_thread(thread.id)] == ["run_second", "run_first"]

    lines = [json.loads(line) for line in store.get_thread_log_path(thread.id).read_text(encoding="utf-8").splitlines()]
    assert [line["type"] for line in lines].count("session_meta") == 1
    assert [line["type"] for line in lines].count("turn_context") == 2
    assert [line["payload"].get("type") for line in lines if line["type"] == "response_item"].count("message") == 2


def test_session_log_rebuilds_index_and_deletes_thread_file(tmp_path):
    # 启动重建只读取 JSONL 文件；删除 thread 会移除文件和内存索引。
    root = tmp_path / "sessions"
    store = AgentSessionLogStore(root, cwd=tmp_path)
    thread = store.create_thread(_thread())
    run = _run("run_done", thread.id)
    store.save_run(run)
    store.append_event(
        run.id,
        RunEvent(
            event_id="evt_done",
            run_id=run.id,
            thread_id=thread.id,
            type=EventType.RUN_COMPLETED,
            message="完成。",
            timestamp=datetime.now(timezone.utc),
        ),
    )
    store.upsert_context_entry(
        ContextEntryRecord(
            context_entry_id="context_done",
            session_id=thread.session_id,
            thread_id=thread.id,
            source_run_id=run.id,
            kind="artifact",
            label="结果",
            summary="结果摘要",
            reference=ContextReference(reference_id="artifact:one", kind="artifact", label="结果"),
            search_text="结果",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    )
    path = store.get_thread_log_path(thread.id)

    rebuilt = AgentSessionLogStore(root, cwd=tmp_path)
    assert rebuilt.get_thread(thread.id).session_log_path == str(path)
    assert rebuilt.get_run(run.id).id == run.id
    assert rebuilt.list_events(run.id)[0].event_id == "evt_done"
    assert rebuilt.list_context_entries(thread.id)[0].context_entry_id == "context_done"

    rebuilt.delete_thread(thread.id)
    assert not path.exists()
    assert rebuilt.list_runs_for_session(thread.session_id) == []


def test_run_completed_response_item_uses_final_response_when_message_empty(tmp_path):
    # run.completed 事件 message 可能为空，finalResponse 才是最终回答事实源。
    #
    # JSONL response_item 必须写入 summary，避免历史对话出现空 assistant。
    store = AgentSessionLogStore(tmp_path / "sessions", cwd=tmp_path)
    thread = store.create_thread(_thread())
    run = _run("run_done", thread.id)
    store.save_run(run)
    store.append_event(
        run.id,
        RunEvent(
            event_id="evt_done",
            run_id=run.id,
            thread_id=thread.id,
            type=EventType.RUN_COMPLETED,
            message="",
            timestamp=datetime.now(timezone.utc),
            payload={"finalResponse": AgentFinalResponse(summary="最终回答已生成。").model_dump(mode="json")},
        ),
    )

    records = [json.loads(line) for line in store.get_thread_log_path(thread.id).read_text(encoding="utf-8").splitlines()]
    response_items = [item["payload"] for item in records if item["type"] == "response_item" and item["payload"].get("role") == "assistant"]

    assert response_items[-1]["content"][0]["text"] == "最终回答已生成。"


def test_session_log_corrupt_jsonl_fails_loudly(tmp_path):
    # JSONL 是 Agent 历史事实源。
    #
    # 坏行不能被静默跳过，否则上下文和 run/event 索引会被部分重建成脏状态。
    root = tmp_path / "sessions"
    path = root / "2026" / "05" / "26" / "rollout-2026-05-26T12-00-00-0189d7ef-5f3d-7abc-8def-123456789abc.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text('{"timestamp":"2026-05-26T04:00:00Z","type":"session_meta","payload":{}}\n{bad json}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="会话 JSONL"):
        AgentSessionLogStore(root, cwd=tmp_path)


def test_delete_thread_requires_session_log_file(tmp_path):
    # 内存索引和 JSONL 文件必须一致。
    #
    # 如果事实源文件被外部删除，API 删除不伪装成功，方便开发库显式 reset。
    store = AgentSessionLogStore(tmp_path / "sessions", cwd=tmp_path)
    thread = store.create_thread(_thread())
    path = store.get_thread_log_path(thread.id)
    path.unlink()

    with pytest.raises(FileNotFoundError, match="会话日志文件不存在"):
        store.delete_thread(thread.id)

    assert store.get_thread(thread.id).id == thread.id


def _thread(*, created_at: datetime | None = None, updated_at: datetime | None = None) -> AgentThreadRecord:
    timestamp = created_at or datetime.now(timezone.utc)
    return AgentThreadRecord(
        id="thread_test",
        session_id="session_test",
        title="测试线程",
        created_at=timestamp,
        updated_at=updated_at or timestamp,
    )


def _run(run_id: str, thread_id: str) -> AnalysisRunRecord:
    timestamp = datetime.now(timezone.utc)
    return AnalysisRunRecord(
        id=run_id,
        thread_id=thread_id,
        session_id="session_test",
        user_query=f"问题 {run_id}",
        created_at=timestamp,
        updated_at=timestamp,
        state=AgentStateModel(
            session_id="session_test",
            thread_id=thread_id,
            user_query=f"问题 {run_id}",
        ),
    )
