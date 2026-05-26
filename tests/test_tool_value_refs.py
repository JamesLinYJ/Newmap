# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具值引用黑板测试
#
#   文件:       test_tool_value_refs.py
#
#   日期:       2026年05月25日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证工具派生值进入运行时黑板，后续工具只传 valueRef，
# 未知引用硬失败，不通过模型手抄数值或 fallback 猜测。

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from api_app.run_core import _load_run_value_map
from shared_types.schemas import AgentStateModel, AnalysisRunRecord, ArtifactRef, WeatherDatasetRecord
from tool_registry import ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore, build_default_registry
from tool_registry.value_refs import ToolValueStore, resolve_json_value_refs


@pytest.mark.asyncio
async def test_geocode_coordinate_ref_feeds_reverse_geocode() -> None:
    # 工具链契约。
    #
    # geocode 产出的坐标只通过 coordinate valueRef 传给 reverse_geocode，
    # 测试不让模型手工抄 latitude/longitude。
    registry = build_default_registry()
    spatial = _FakeSpatialService()
    runtime = _build_runtime(spatial_service=spatial)

    geocode = await registry.execute("geocode_place", {"query": "澳门"}, runtime)
    coordinate_ref = geocode.value_refs[0].ref_id

    reverse = await registry.execute("reverse_geocode", {"coordinate_ref": coordinate_ref}, runtime)

    assert coordinate_ref in runtime.state.value_map
    assert reverse.payload["address"] == "澳门特别行政区"
    assert spatial.reverse_calls == [{"latitude": 22.1987, "longitude": 113.5439}]


@pytest.mark.asyncio
async def test_geocode_coordinate_refs_feed_route_plan(monkeypatch, tmp_path) -> None:
    # 路线工具也只消费坐标引用。
    #
    # OSRM HTTP 在这里用假客户端替代，测试重点是 origin_ref/dest_ref
    # 是否由工具层解析成真实坐标。
    registry = build_default_registry()
    runtime = _build_runtime(
        tmp_path=tmp_path,
        platform_store=_FakeArtifactPlatformStore(),
        layer_repository=_FakeLayerRepository(),
        spatial_service=_FakeSpatialService(),
    )
    monkeypatch.setattr("httpx.AsyncClient", _FakeRouteClient)

    origin = await registry.execute("geocode_place", {"query": "澳门"}, runtime)
    destination = await registry.execute("geocode_place", {"query": "珠海"}, runtime)

    route = await registry.execute(
        "route_plan",
        {
            "origin_ref": origin.value_refs[0].ref_id,
            "dest_ref": destination.value_refs[0].ref_id,
            "mode": "driving",
        },
        runtime,
    )

    assert route.payload["origin"] == {"lat": 22.1987, "lng": 113.5439, "label": "澳门"}
    assert route.payload["destination"] == {"lat": 22.2707, "lng": 113.5767, "label": "珠海"}


@pytest.mark.asyncio
async def test_meteorological_stats_p90_ref_feeds_threshold_area(tmp_path) -> None:
    # 气象数值链路。
    #
    # inspect 产出变量/bbox/time valueRef，stats 产出 p90 valueRef，
    # threshold_area 只消费引用，由工具层解析真实阈值。
    registry = build_default_registry()
    dataset = WeatherDatasetRecord(
        dataset_id="dataset_1",
        session_id="session_test",
        thread_id="thread_test",
        filename="rain.nc",
        status="completed",
        storage_relative_path="weather/rain.nc",
        metadata={"variables": [{"name": "rain", "unit": "mm", "levelCount": 1}], "bbox": [110, 20, 115, 25], "timeCount": 1, "levels": ["850 hPa"]},
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    platform_store = _FakeMeteorologicalPlatformStore(dataset)
    weather_service = _FakeWeatherService()
    runtime = _build_runtime(
        tmp_path=tmp_path,
        platform_store=platform_store,
        layer_repository=_FakeLayerRepository(),
        spatial_service=_FakeSpatialService(),
        weather_service=weather_service,
    )

    inspect = await registry.execute("inspect_meteorological_dataset", {"dataset_id": "dataset_1"}, runtime)
    refs_by_kind = {ref.kind: ref.ref_id for ref in inspect.value_refs}

    stats = await registry.execute(
        "meteorological_stats",
        {
            "dataset_id": "dataset_1",
            "variable_ref": refs_by_kind["variable"],
            "bbox_ref": refs_by_kind["bbox"],
            "time_index_ref": refs_by_kind["time_index"],
            "level_index_ref": refs_by_kind["level_index"],
        },
        runtime,
    )
    p90_ref = next(ref.ref_id for ref in stats.value_refs if ref.metadata.get("statistic") == "p90")
    second_stats = await registry.execute(
        "meteorological_stats",
        {
            "dataset_id": "dataset_1",
            "variable_ref": refs_by_kind["variable"],
            "bbox": [111, 21, 112, 22],
            "level_index_ref": refs_by_kind["level_index"],
        },
        runtime,
    )
    second_p90_ref = next(ref.ref_id for ref in second_stats.value_refs if ref.metadata.get("statistic") == "p90")

    await registry.execute(
        "meteorological_threshold_area",
        {
            "dataset_id": "dataset_1",
            "threshold_ref": p90_ref,
            "variable_ref": refs_by_kind["variable"],
            "time_index_ref": refs_by_kind["time_index"],
            "level_index_ref": refs_by_kind["level_index"],
        },
        runtime,
    )

    assert p90_ref != second_p90_ref
    assert weather_service.stats_calls == [
        {"variable": "rain", "time_index": 0, "level_index": 0, "bbox": [110.0, 20.0, 115.0, 25.0]},
        {"variable": "rain", "time_index": None, "level_index": 0, "bbox": [111.0, 21.0, 112.0, 22.0]},
    ]
    assert weather_service.threshold_calls == [{"threshold": 90.0, "variable": "rain", "time_index": 0, "level_index": 0, "bbox": None}]

    with pytest.raises(ValueError, match="大模型解读正文"):
        await registry.execute(
            "generate_meteorological_report",
            {
                "dataset_id": "dataset_1",
                "llm_interpretation": "",
            },
            runtime,
        )
    report = await registry.execute(
        "generate_meteorological_report",
        {
            "dataset_id": "dataset_1",
            "llm_interpretation": "大模型解读：降雨变量已完成统计，P90 可作为阈值区分析依据，建议结合 bbox 与时间片进一步查看强降雨范围。",
        },
        runtime,
    )
    assert report.artifact is not None
    assert report.artifact.artifact_type == "docx_report"


@pytest.mark.asyncio
async def test_unknown_value_ref_fails_without_fallback() -> None:
    # 黑板硬边界。
    #
    # 未知 valueRef 说明工具链状态不完整，必须直接失败，不能猜测或回扫旧数据。
    registry = build_default_registry()
    runtime = _build_runtime(spatial_service=_FakeSpatialService())

    with pytest.raises(ValueError, match="工具值引用不存在"):
        await registry.execute("reverse_geocode", {"coordinate_ref": "value:missing"}, runtime)


def test_json_value_ref_resolution_and_run_state_restore() -> None:
    runtime = _build_runtime()
    ref = ToolValueStore(runtime, source_tool="test").put(kind="number", label="阈值", value=12.5)

    assert resolve_json_value_refs(runtime, {"threshold": {"valueRef": ref.ref_id}}) == {"threshold": 12.5}

    store = _FakeRunStore(
        AgentStateModel(
            session_id="session_test",
            thread_id="thread_test",
            user_query="测试",
            tool_value_refs=[ref],
        )
    )
    restored = _load_run_value_map(store, "run_test")

    assert restored[ref.ref_id].value == 12.5


def _build_runtime(
    *,
    tmp_path=None,
    platform_store=None,
    layer_repository=None,
    spatial_service=None,
    weather_service=None,
) -> ToolRuntime:
    runtime_root = tmp_path or SimpleNamespace()
    return ToolRuntime(
        context=ToolRuntimeContext(
            run_id="run_test",
            thread_id="thread_test",
            session_id="session_test",
            latest_uploaded_layer_key=None,
        ),
        state=ToolRuntimeState(),
        store=ToolRuntimeStore(
            platform_store=platform_store or SimpleNamespace(),
            layer_repository=layer_repository or SimpleNamespace(),
            artifact_export_store=SimpleNamespace(),
            spatial_service=spatial_service or SimpleNamespace(),
            runtime_root=runtime_root,
            weather_service=weather_service or SimpleNamespace(),
        ),
    )


class _FakeSpatialService:
    def __init__(self):
        self.reverse_calls: list[dict[str, float]] = []

    def geocode_place(self, query: str) -> dict[str, object]:
        points = {
            "澳门": {"latitude": 22.1987, "longitude": 113.5439},
            "珠海": {"latitude": 22.2707, "longitude": 113.5767},
        }
        point = points.get(query, points["澳门"])
        return {
            "provider": "fake",
            "matches": [
                {
                    "label": query,
                    "display_name": query,
                    **point,
                    "source": "fake",
                }
            ],
        }

    def reverse_geocode(self, latitude: float, longitude: float) -> dict[str, object]:
        self.reverse_calls.append({"latitude": latitude, "longitude": longitude})
        return {"provider": "fake", "address": "澳门特别行政区"}

    def geometry_bounds(self, collection: dict[str, object]) -> list[float]:
        return [110.0, 20.0, 115.0, 25.0]


class _FakeMeteorologicalPlatformStore:
    def __init__(self, dataset: WeatherDatasetRecord):
        self.dataset = dataset
        self.artifact: ArtifactRef | None = None

    def ensure_weather_dataset_parsed(self, dataset_id: str, weather_service) -> WeatherDatasetRecord:
        assert dataset_id == self.dataset.dataset_id
        return self.dataset

    def save_geojson_artifact(
        self,
        *,
        run_id: str,
        artifact_id: str,
        name: str,
        collection: dict[str, object],
        metadata: dict[str, object],
        is_intermediate: bool = False,
    ) -> ArtifactRef:
        self.artifact = ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type="geojson",
            name=name,
            uri=f"artifact://{artifact_id}",
            metadata=metadata,
            is_intermediate=is_intermediate,
        )
        return self.artifact

    def update_artifact_metadata(self, artifact_id: str, **metadata) -> ArtifactRef:
        assert self.artifact is not None
        assert artifact_id == self.artifact.artifact_id
        return self.artifact.model_copy(update={"metadata": {**self.artifact.metadata, **metadata}})

    def save_file_artifact(
        self,
        *,
        run_id: str,
        artifact_id: str,
        artifact_type: str,
        name: str,
        source_path: str,
        suffix: str,
        metadata: dict[str, object],
    ) -> ArtifactRef:
        self.artifact = ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type=artifact_type,
            name=name,
            uri=f"artifact://{artifact_id}",
            metadata=metadata,
        )
        return self.artifact


class _FakeArtifactPlatformStore:
    def save_geojson_artifact(
        self,
        *,
        run_id: str,
        artifact_id: str,
        name: str,
        collection: dict[str, object],
        metadata: dict[str, object],
        is_intermediate: bool = False,
    ) -> ArtifactRef:
        return ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type="geojson",
            name=name,
            uri=f"artifact://{artifact_id}",
            metadata=metadata,
            is_intermediate=is_intermediate,
        )


class _FakeLayerRepository:
    def save_result_layer(self, run_id: str, alias: str, name: str, collection: dict[str, object]):
        return SimpleNamespace(layer_key=f"result:{alias}")


class _FakeWeatherService:
    def __init__(self):
        self.stats_calls: list[dict[str, object]] = []
        self.threshold_calls: list[dict[str, object]] = []

    def stats(self, path, *, variable=None, time_index=None, level_index=None, bbox=None):
        self.stats_calls.append({"variable": variable, "time_index": time_index, "level_index": level_index, "bbox": bbox})
        return {"min": 1.0, "max": 100.0, "mean": 40.0, "median": 50.0, "p90": 90.0, "count": 10, "unit": "mm"}

    def threshold_geojson(self, path, *, threshold: float, operator: str, variable=None, time_index=None, level_index=None, bbox=None):
        self.threshold_calls.append({"threshold": threshold, "variable": variable, "time_index": time_index, "level_index": level_index, "bbox": bbox})
        return {"type": "FeatureCollection", "features": []}

    def generate_report_docx(self, path, *, output_path, filename=None, dataset_id=None, metadata=None, llm_interpretation=""):
        if not llm_interpretation.strip():
            raise ValueError("生成 DOCX 解读报告必须提供大模型解读正文。")
        output_path.write_bytes(b"fake-docx")
        return {"title": "NC 气象数据解读报告", "llmInterpretationChars": len(llm_interpretation), "datasetId": dataset_id}


class _FakeRouteClient:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def get(self, url: str, params: dict[str, str]):
        return _FakeRouteResponse()


class _FakeRouteResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "code": "Ok",
            "routes": [
                {
                    "distance": 12000,
                    "duration": 1800,
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[113.5439, 22.1987], [113.5767, 22.2707]],
                    },
                }
            ],
        }


class _FakeRunStore:
    def __init__(self, state: AgentStateModel):
        now = datetime.now(timezone.utc)
        self.run = AnalysisRunRecord(
            id="run_test",
            thread_id="thread_test",
            session_id="session_test",
            user_query="测试",
            status="running",
            created_at=now,
            updated_at=now,
            state=state,
        )

    def get_run(self, run_id: str) -> AnalysisRunRecord:
        assert run_id == self.run.id
        return self.run
