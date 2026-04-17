import asyncio
from io import BytesIO
from types import SimpleNamespace

from pydantic import ValidationError
import pytest
from fastapi import HTTPException

import agent_core.graph as graph_module
from api_app.config import settings
import api_app.main as main_module
from api_app.platform_store import PostgresPlatformStore
import tool_registry.registry as tool_registry_module
from api_app.main import (
    AnalysisRequest,
    QgisModelRequest,
    _build_tool_runtime,
    _build_allowed_origins,
    _start_run,
    app,
    geocode,
    list_providers,
    list_qgis_models,
    register_layer,
    run_qgis_model,
)
from shared_types.schemas import AgentFinalResponse, PublishRequest


@pytest.mark.asyncio
async def test_api_run_flow_completes(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(app.state.runtime, "_supports_live_supervisor", lambda provider: False)
        session = app.state.store.create_session()
        run = await _start_run(
            AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院"),
            app.state.store,
            app.state.runtime,
        )

        for _ in range(30):
            current = app.state.store.get_run(run.id).model_dump(mode="json", by_alias=True)
            if current["status"] in {"completed", "clarification_needed", "failed"}:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError("analysis did not finish in time")

        assert current["status"] == "completed"
        artifacts = app.state.store.list_artifacts(run.id)
        assert artifacts
        assert [item.agent_id for item in app.state.store.get_run(run.id).state.sub_agents] == ["spatial_analyst"]
        session_runs = app.state.store.list_runs_for_session(session.id)
        assert any(item.id == run.id for item in session_runs)
        await _drain_background_tasks()
        await asyncio.get_running_loop().shutdown_default_executor()


@pytest.mark.asyncio
async def test_geocode_and_provider_endpoints(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(main_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(
            app.state.spatial_service,
            "geocode_place",
            lambda query: {
                "type": "FeatureCollection",
                "features": [],
                "matches": [{"label": "巴黎", "country": "France"}],
            },
        )
        providers = await list_providers(app.state.runtime)
        assert any(item.provider == "gemini" for item in providers)
        result = await geocode("巴黎")
        assert result["matches"]


@pytest.mark.asyncio
async def test_qgis_model_listing_endpoint():
    async with app.router.lifespan_context(app):
        app.state.qgis_runner.health = lambda: _async_value({"available": True})
        app.state.qgis_runner.list_models = lambda: _async_value({"available": True, "models": ["buffer_and_intersect"]})
        payload = await list_qgis_models()
        assert "buffer_and_intersect" in payload["models"]


@pytest.mark.asyncio
async def test_qgis_model_listing_falls_back_when_model_endpoint_fails():
    async with app.router.lifespan_context(app):
        original_health = app.state.qgis_runner.health
        original_list_models = app.state.qgis_runner.list_models

        async def broken_model_listing():
            raise RuntimeError("simulated model registry failure")

        app.state.qgis_runner.health = lambda: _async_value({"available": True})
        app.state.qgis_runner.list_models = broken_model_listing

        payload = await list_qgis_models()
        assert payload["available"] is False
        assert "buffer_and_intersect" in payload["models"]
        assert "simulated model registry failure" in payload["error"]
        app.state.qgis_runner.health = original_health
        app.state.qgis_runner.list_models = original_list_models


@pytest.mark.asyncio
async def test_qgis_model_run_returns_specific_error_when_runtime_is_offline():
    original_health = app.state.qgis_runner.health if hasattr(app.state, "qgis_runner") else None
    async with app.router.lifespan_context(app):
        async def offline_health():
            return {"available": False, "error": "QGIS runtime health check failed: simulated offline runtime"}

        app.state.qgis_runner.health = offline_health
        with pytest.raises(HTTPException) as exc_info:
            await run_qgis_model(
                QgisModelRequest(modelName="buffer_and_intersect", artifactId="artifact_missing", runId="run_missing"),
                store=app.state.store,
            )
        assert exc_info.value.status_code == 503
        detail = str(exc_info.value.detail)
        assert "QGIS runtime" in detail
        assert "failed" in detail
        if original_health is not None:
            app.state.qgis_runner.health = original_health


@pytest.mark.asyncio
async def test_analysis_failure_exposes_specific_error(monkeypatch: pytest.MonkeyPatch):
    original_update_run_state = PostgresPlatformStore.update_run_state

    def fail_on_plan(self: PostgresPlatformStore, run_id: str, *, status: str | None = None, **fields):
        if "execution_plan" in fields:
            raise RuntimeError("forced execution plan persistence failure")
        return original_update_run_state(self, run_id, status=status, **fields)

    monkeypatch.setattr(PostgresPlatformStore, "update_run_state", fail_on_plan)

    async with app.router.lifespan_context(app):
        monkeypatch.setenv("PYTEST_CURRENT_TEST", "forced-sync-failure")
        monkeypatch.setattr(app.state.runtime, "_supports_live_supervisor", lambda provider: False)
        session = app.state.store.create_session()
        run = (
            await _start_run(
                AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院"),
                app.state.store,
                app.state.runtime,
            )
        ).model_dump(mode="json", by_alias=True)

        assert run["status"] == "failed"
        assert "RuntimeError" in run["state"]["errors"][0]
        assert "forced execution plan persistence failure" in run["state"]["errors"][0]


@pytest.mark.asyncio
async def test_analysis_auto_publish_persists_links_on_latest_artifact(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        default_project_key = app.state.store.get_runtime_config().default_publish_project_key

        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        async def publish_artifact(artifact_id: str, artifact_name: str, project_key: str, *, collection: dict[str, object]):
            assert artifact_id.startswith("artifact_")
            assert artifact_name
            assert project_key == default_project_key
            assert collection["type"] == "FeatureCollection"
            return {
                "geojsonUrl": f"http://example.test/data/{artifact_id}.geojson",
                "ogcApiCollectionsUrl": f"http://example.test/ogc/{project_key}/collections",
            }

        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(app.state.publisher, "publish_artifact", publish_artifact)
        monkeypatch.setattr(app.state.runtime, "_supports_live_supervisor", lambda provider: False)

        session = app.state.store.create_session()
        run = await _start_run(
            AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院并发布结果"),
            app.state.store,
            app.state.runtime,
        )

        assert run.status == "waiting_approval"
        assert run.state.artifacts
        latest_artifact = run.state.artifacts[-1]
        assert run.state.approvals
        assert run.state.approvals[0].artifact_id == latest_artifact.artifact_id


@pytest.mark.asyncio
async def test_start_run_returns_http_400_for_unconfigured_provider(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        session = app.state.store.create_session()
        monkeypatch.setattr(
            app.state.runtime.model_registry,
            "resolve_provider",
            lambda provider: (_ for _ in ()).throw(RuntimeError("模型 provider 'anthropic' 尚未配置，当前无法启动运行。")),
        )
        with pytest.raises(HTTPException) as exc_info:
            await _start_run(
                AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院", provider="anthropic"),
                app.state.store,
                app.state.runtime,
            )
        assert exc_info.value.status_code == 400
        assert "尚未配置" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_analysis_emits_loop_updates_in_expected_order(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(app.state.runtime, "_supports_live_supervisor", lambda provider: False)

        session = app.state.store.create_session()
        run = await _start_run(
            AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院"),
            app.state.store,
            app.state.runtime,
        )

        events = app.state.store.list_events(run.id)
        loop_events = [event for event in events if event.type.value == "loop.updated"]
        phases = [str(event.payload.get("phase")) for event in loop_events]

        assert len(loop_events) >= 4
        assert phases[:4] == ["observe", "decide", "act", "observe_result"]


@pytest.mark.asyncio
async def test_live_deepagents_reuses_thread_context_memory(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        session = app.state.store.create_session()
        thread = app.state.store.create_thread(session.id, title="上下文测试线程")

        previous = app.state.store.create_run(session.id, "先看上一次的医院结果", thread_id=thread.id, model_provider="gemini")
        previous_state = app.state.store.get_run(previous.id).state.model_copy(
            update={"final_response": AgentFinalResponse(summary="旧运行已经找到一批医院。")}
        )
        app.state.store.complete_run(previous.id, previous_state)

        current = app.state.store.create_run(session.id, "继续围绕同一区域做分析", thread_id=thread.id, model_provider="gemini")
        runtime = _build_tool_runtime(
            run_id=current.id,
            thread_id=thread.id,
            session_id=session.id,
            latest_uploaded_layer_key="uploaded_layer_demo",
        )

        captured: dict[str, object] = {}

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                captured["payload"] = payload
                captured["config"] = config
                return {"messages": [SimpleNamespace(content="还需要你补充本轮要分析的对象类型。")]}

        def fake_create_deep_agent(**kwargs):
            captured["create_kwargs"] = kwargs
            return _FakeAgent()

        monkeypatch.setattr(graph_module, "create_deep_agent", fake_create_deep_agent)
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())

        await app.state.runtime._run_with_deepagents(
            run_id=current.id,
            thread_id=thread.id,
            query=current.user_query,
            provider="gemini",
            model_name=None,
            runtime=runtime,
        )

        payload = captured["payload"]
        assert isinstance(payload, dict)
        assert payload["files"]["/AGENTS.md"]["content"].find("先看上一次的医院结果") >= 0
        assert payload["files"]["/AGENTS.md"]["content"].find("uploaded_layer_demo") >= 0
        assert payload["files"]["/THREAD_CONTEXT.md"]["content"].find(current.id) >= 0

        config = captured["config"]
        assert isinstance(config, dict)
        assert config["configurable"]["thread_id"] == thread.id

        create_kwargs = captured["create_kwargs"]
        assert isinstance(create_kwargs, dict)
        assert create_kwargs["memory"] == ["/AGENTS.md", "/THREAD_CONTEXT.md"]
        assert create_kwargs["checkpointer"] is app.state.runtime.deepagents_checkpointer

        updated_run = app.state.store.get_run(current.id)
        assert updated_run.state.final_response is not None
        assert updated_run.state.final_response.summary == "还需要你补充本轮要分析的对象类型。"
        assert updated_run.state.sub_agents == []
        assert updated_run.state.loop_trace


@pytest.mark.asyncio
async def test_live_deepagents_only_records_subagent_when_tool_is_actually_invoked(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(
            app.state.spatial_service,
            "geocode_place",
            lambda query: {
                "type": "FeatureCollection",
                "features": [],
                "matches": [{"label": query, "country": "France"}],
            },
        )
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())

        captured: dict[str, object] = {}

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                tool = next(item for item in captured["create_kwargs"]["tools"] if item.name == "geocode_place")
                tool_result = await tool.ainvoke({"query": "巴黎"})
                return {"messages": [SimpleNamespace(content=str(tool_result))]}

        def fake_create_deep_agent(**kwargs):
            captured["create_kwargs"] = kwargs
            return _FakeAgent()

        monkeypatch.setattr(graph_module, "create_deep_agent", fake_create_deep_agent)

        session = app.state.store.create_session()
        thread = app.state.store.create_thread(session.id, title="按需调用子智能体")
        run = app.state.store.create_run(session.id, "先定位巴黎", thread_id=thread.id, model_provider="gemini")
        runtime = _build_tool_runtime(
            run_id=run.id,
            thread_id=thread.id,
            session_id=session.id,
            latest_uploaded_layer_key=None,
        )

        await app.state.runtime._run_with_deepagents(
            run_id=run.id,
            thread_id=thread.id,
            query=run.user_query,
            provider="gemini",
            model_name=None,
            runtime=runtime,
        )

        updated_run = app.state.store.get_run(run.id)
        assert len(updated_run.state.sub_agents) == 1
        assert updated_run.state.sub_agents[0].agent_id == "spatial_analyst"
        assert updated_run.state.sub_agents[0].status == "completed"
        assert updated_run.state.tool_results
        assert updated_run.state.tool_results[0].tool == "geocode_place"

        subagent_created_events = [event for event in app.state.store.list_events(run.id) if event.type.value == "subagent.created"]
        assert len(subagent_created_events) == 1
        assert "空间分析" in subagent_created_events[0].message


@pytest.mark.asyncio
async def test_live_deepagents_resolves_city_prefixed_layer_keys_without_warning(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())

        captured: dict[str, object] = {}

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                tools = {item.name: item for item in captured["create_kwargs"]["tools"]}
                await tools["load_boundary"].ainvoke({"name": "巴黎", "alias": "boundary"})
                await tools["load_layer"].ainvoke(
                    {
                        "layer_key": "paris_metro_stations",
                        "area_name": "巴黎",
                        "boundary": "boundary",
                        "alias": "metro_stations_scope",
                    }
                )
                return {"messages": [SimpleNamespace(content="已完成地铁站图层加载。")]}

        def fake_create_deep_agent(**kwargs):
            captured["create_kwargs"] = kwargs
            return _FakeAgent()

        monkeypatch.setattr(graph_module, "create_deep_agent", fake_create_deep_agent)

        session = app.state.store.create_session()
        thread = app.state.store.create_thread(session.id, title="图层 key 归一化")
        run = app.state.store.create_run(session.id, "加载巴黎地铁站图层", thread_id=thread.id, model_provider="gemini")
        runtime = _build_tool_runtime(
            run_id=run.id,
            thread_id=thread.id,
            session_id=session.id,
            latest_uploaded_layer_key=None,
        )

        await app.state.runtime._run_with_deepagents(
            run_id=run.id,
            thread_id=thread.id,
            query=run.user_query,
            provider="gemini",
            model_name=None,
            runtime=runtime,
        )

        updated_run = app.state.store.get_run(run.id)
        assert updated_run.status == "completed"
        assert updated_run.state.warnings == []
        assert updated_run.state.errors == []
        assert [item.tool for item in updated_run.state.tool_results] == ["load_boundary", "load_layer"]
        assert updated_run.state.artifacts
        assert updated_run.state.sub_agents
        assert updated_run.state.sub_agents[0].agent_id == "spatial_analyst"
        assert updated_run.state.final_response is not None
        assert updated_run.state.final_response.summary.startswith("分析已完成")


@pytest.mark.asyncio
async def test_live_deepagents_retries_when_no_actionable_result_is_produced(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        session = app.state.store.create_session()
        thread = app.state.store.create_thread(session.id, title="空结果回退")
        run = app.state.store.create_run(session.id, "查询巴黎地铁站 1 公里范围内的医院", thread_id=thread.id, model_provider="gemini")
        runtime = _build_tool_runtime(
            run_id=run.id,
            thread_id=thread.id,
            session_id=session.id,
            latest_uploaded_layer_key=None,
        )

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                return {"messages": [SimpleNamespace(content="分析已完成。")]}

        monkeypatch.setattr(graph_module, "create_deep_agent", lambda **kwargs: _FakeAgent())
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())

        with pytest.raises(RuntimeError) as exc_info:
            await app.state.runtime._run_with_deepagents(
                run_id=run.id,
                thread_id=thread.id,
                query=run.user_query,
                provider="gemini",
                model_name=None,
                runtime=runtime,
            )

        assert "没有产出可交付结果" in str(exc_info.value)


@pytest.mark.asyncio
async def test_live_deepagents_retries_when_only_intermediate_message_is_returned(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        session = app.state.store.create_session()
        thread = app.state.store.create_thread(session.id, title="中间消息回退")
        run = app.state.store.create_run(session.id, "查询巴黎地铁站 1 公里范围内的医院", thread_id=thread.id, model_provider="gemini")
        runtime = _build_tool_runtime(
            run_id=run.id,
            thread_id=thread.id,
            session_id=session.id,
            latest_uploaded_layer_key=None,
        )

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                return {"messages": [SimpleNamespace(content=[{"type": "text", "text": "我已开始查询，请稍候。"}])]}

        monkeypatch.setattr(graph_module, "create_deep_agent", lambda **kwargs: _FakeAgent())
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())

        with pytest.raises(RuntimeError) as exc_info:
            await app.state.runtime._run_with_deepagents(
                run_id=run.id,
                thread_id=thread.id,
                query=run.user_query,
                provider="gemini",
                model_name=None,
                runtime=runtime,
            )

        assert "没有产出可交付结果" in str(exc_info.value)


@pytest.mark.asyncio
async def test_live_deepagents_publish_request_enters_waiting_approval_without_fallback(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())

        captured: dict[str, object] = {}

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                tools = {item.name: item for item in captured["create_kwargs"]["tools"]}
                await tools["load_boundary"].ainvoke({"name": "巴黎", "alias": "boundary"})
                await tools["load_layer"].ainvoke(
                    {
                        "layer_key": "metro_stations",
                        "area_name": "巴黎",
                        "boundary": "boundary",
                        "alias": "metro_stations_scope",
                    }
                )
                return {"messages": [SimpleNamespace(content="分析已完成并准备发布。")]}

        def fake_create_deep_agent(**kwargs):
            captured["create_kwargs"] = kwargs
            return _FakeAgent()

        monkeypatch.setattr(graph_module, "create_deep_agent", fake_create_deep_agent)

        session = app.state.store.create_session()
        thread = app.state.store.create_thread(session.id, title="发布审批缺失")
        run = app.state.store.create_run(session.id, "查询巴黎地铁站 1 公里范围内的医院并发布结果", thread_id=thread.id, model_provider="gemini")
        runtime = _build_tool_runtime(
            run_id=run.id,
            thread_id=thread.id,
            session_id=session.id,
            latest_uploaded_layer_key=None,
        )

        await app.state.runtime._run_with_deepagents(
            run_id=run.id,
            thread_id=thread.id,
            query=run.user_query,
            provider="gemini",
            model_name=None,
            runtime=runtime,
        )

        updated = app.state.store.get_run(run.id)
        assert updated.status == "waiting_approval"
        assert not updated.state.warnings
        assert len(updated.state.tool_results) == 2
        assert len(updated.state.artifacts) == 2
        assert updated.state.approvals
        assert updated.state.approvals[0].status == "pending"


@pytest.mark.asyncio
async def test_runtime_fallback_after_empty_live_result_does_not_surface_warning(monkeypatch: pytest.MonkeyPatch):
    async with app.router.lifespan_context(app):
        async def inline_to_thread(func, /, *args, **kwargs):
            return func(*args, **kwargs)

        monkeypatch.setattr(tool_registry_module.asyncio, "to_thread", inline_to_thread)
        monkeypatch.setattr(app.state.runtime, "_build_langchain_model", lambda provider, model_name: object())
        monkeypatch.setattr(app.state.runtime, "_supports_live_supervisor", lambda provider: True)

        class _FakeAgent:
            async def ainvoke(self, payload, config=None):
                return {"messages": [SimpleNamespace(content="分析已完成。")]}

        monkeypatch.setattr(graph_module, "create_deep_agent", lambda **kwargs: _FakeAgent())

        session = app.state.store.create_session()
        run = await _start_run(
            AnalysisRequest(sessionId=session.id, query="查询巴黎地铁站 1 公里范围内的医院"),
            app.state.store,
            app.state.runtime,
        )

        current = app.state.store.get_run(run.id)
        assert current.status == "completed"
        assert current.state.warnings == []
        assert current.state.artifacts
        assert current.state.final_response is not None


@pytest.mark.asyncio
async def test_upload_rejects_payloads_larger_than_limit(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "upload_max_bytes", 8)

    async with app.router.lifespan_context(app):
        session = app.state.store.create_session()
        upload = _FakeUpload("too-large.geojson", b"123456789")
        with pytest.raises(HTTPException) as exc_info:
            await register_layer(session.id, upload, store=app.state.store, catalog=app.state.catalog)
        assert exc_info.value.status_code == 413
        assert "上传文件过大" in str(exc_info.value.detail)


def test_publish_rejects_path_like_project_keys():
    with pytest.raises(ValidationError) as exc_info:
        PublishRequest(projectKey="../../tmp/pwn")
    assert "projectKey" in str(exc_info.value)


def test_allowed_origins_strip_trailing_slashes_and_dedupe():
    assert _build_allowed_origins("https://example.com/", "https://example.com", " http://localhost:5173/ ") == [
        "https://example.com",
        "http://localhost:5173",
    ]


async def _async_value(value):
    return value


async def _drain_background_tasks():
    pending = [task for task in app.state.background_tasks if not task.done()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


class _FakeUpload:
    def __init__(self, filename: str, payload: bytes):
        self.filename = filename
        self._buffer = BytesIO(payload)

    async def read(self, size: int = -1) -> bytes:
        return self._buffer.read(size)
