# +-------------------------------------------------------------------------
#
#   地理智能平台 - NC 气象解读工具测试
#
#   文件:       test_meteorological_interpretation.py
#
#   日期:       2026年05月26日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：用真实 NC 裁剪 fixture 验证 LLM 解读工具、地图候选 valueRef
# 和 raster artifact 串联边界。

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from gis_weather import WeatherDataService
from shared_types.schemas import ArtifactRef, WeatherDatasetRecord
from tool_registry import ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore, build_default_registry


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "weather" / "radar_sequence"


@pytest.mark.asyncio
async def test_interpret_single_dataset_generates_interpretation_and_map_refs(tmp_path) -> None:
    # 单文件解读主路径。
    #
    # 工具必须调用模型生成正文，并把正文/地图候选写入 valueRef 黑板。
    registry = build_default_registry()
    dataset = _dataset_from_fixture("dataset_00", FIXTURE_ROOT / "radar_sequence_00.nc")
    model = _FakeModelAdapter()
    runtime = _build_runtime(tmp_path, [dataset], model_registry=_FakeModelRegistry(model))

    result = await registry.execute(
        "interpret_meteorological_dataset",
        {"dataset_id": "dataset_00", "variables": ["QPF", "dbz"], "focus": "强降雨和回波高值"},
        runtime,
    )

    kinds = {ref.kind for ref in result.value_refs}
    assert "llm_interpretation" in kinds
    assert "meteorological_map_candidate" in kinds
    assert result.payload["interpretation"]["summary"] == "样例 NC 数据存在明显降水信号。"
    assert result.payload["mapCandidates"]
    assert "QPF" in model.prompts[0]
    assert "mapCandidates" in model.prompts[0]


@pytest.mark.asyncio
async def test_interpret_sequence_sorts_files_and_finds_peak_candidate(tmp_path) -> None:
    # 连续时次解读。
    #
    # 即使输入顺序打乱，也按文件名时次排序，并给出高值时次地图候选。
    registry = build_default_registry()
    datasets = [
        _dataset_from_fixture("dataset_02", FIXTURE_ROOT / "radar_sequence_02.nc"),
        _dataset_from_fixture("dataset_00", FIXTURE_ROOT / "radar_sequence_00.nc"),
        _dataset_from_fixture("dataset_01", FIXTURE_ROOT / "radar_sequence_01.nc"),
    ]
    runtime = _build_runtime(tmp_path, datasets, model_registry=_FakeModelRegistry(_FakeModelAdapter()))

    result = await registry.execute(
        "interpret_meteorological_dataset",
        {"dataset_ids": ["dataset_02", "dataset_00", "dataset_01"], "variables": ["QPF"]},
        runtime,
    )

    facts = result.payload["facts"]
    assert [item["datasetId"] for item in facts["datasets"]] == ["dataset_00", "dataset_01", "dataset_02"]
    assert facts["sequenceSummary"]["QPF"]["peakDatasetId"] == "dataset_02"
    assert any(item["datasetId"] == "dataset_02" and item["variable"] == "QPF" for item in result.payload["mapCandidates"])


@pytest.mark.asyncio
async def test_render_raster_from_map_candidate_ref(tmp_path) -> None:
    # 地图候选串联。
    #
    # Agent 后续只传 map_candidate_ref，工具层解析真实 dataset/variable。
    registry = build_default_registry()
    dataset = _dataset_from_fixture("dataset_02", FIXTURE_ROOT / "radar_sequence_02.nc")
    runtime = _build_runtime(tmp_path, [dataset], model_registry=_FakeModelRegistry(_FakeModelAdapter()))

    interpretation = await registry.execute(
        "interpret_meteorological_dataset",
        {"dataset_id": "dataset_02", "variables": ["QPF"]},
        runtime,
    )
    candidate_ref = next(ref.ref_id for ref in interpretation.value_refs if ref.kind == "meteorological_map_candidate")
    render = await registry.execute("render_meteorological_raster", {"map_candidate_ref": candidate_ref}, runtime)

    assert render.artifact is not None
    assert render.artifact.artifact_type == "raster_png"
    assert render.artifact.metadata["datasetId"] == "dataset_02"
    assert render.artifact.metadata["mapCandidateRef"] == candidate_ref
    assert render.payload["variable"] == "QPF"


@pytest.mark.asyncio
async def test_interpret_analysis_only_dataset_returns_empty_map_candidates(tmp_path) -> None:
    # 无地图能力边界。
    #
    # 不可制图数据可以解读和统计，但不能伪造地图候选。
    registry = build_default_registry()
    timestamp = datetime.now(timezone.utc)
    dataset = WeatherDatasetRecord(
        dataset_id="dataset_matrix",
        session_id="session_test",
        thread_id="thread_test",
        filename="matrix.nc",
        status="completed",
        storage_relative_path="matrix.nc",
        metadata={"variables": [{"name": "score", "analysisReady": True, "mapReady": False, "unit": "1"}]},
        created_at=timestamp,
        updated_at=timestamp,
    )
    runtime = _build_runtime(
        tmp_path,
        [dataset],
        weather_service=_AnalysisOnlyWeatherService(),
        model_registry=_FakeModelRegistry(_FakeModelAdapter()),
    )

    result = await registry.execute("interpret_meteorological_dataset", {"dataset_id": "dataset_matrix"}, runtime)

    assert result.payload["mapCandidates"] == []
    assert not any(ref.kind == "meteorological_map_candidate" for ref in result.value_refs)


@pytest.mark.asyncio
async def test_unknown_interpretation_and_map_candidate_refs_fail(tmp_path) -> None:
    registry = build_default_registry()
    dataset = _dataset_from_fixture("dataset_00", FIXTURE_ROOT / "radar_sequence_00.nc")
    runtime = _build_runtime(tmp_path, [dataset], model_registry=_FakeModelRegistry(_FakeModelAdapter()))

    with pytest.raises(ValueError, match="工具值引用不存在"):
        await registry.execute("render_meteorological_raster", {"map_candidate_ref": "value:missing"}, runtime)
    with pytest.raises(ValueError, match="工具值引用不存在"):
        await registry.execute(
            "generate_meteorological_report",
            {"dataset_id": "dataset_00", "interpretation_ref": "value:missing"},
            runtime,
        )


def _dataset_from_fixture(dataset_id: str, path: Path) -> WeatherDatasetRecord:
    timestamp = datetime.now(timezone.utc)
    service = WeatherDataService()
    return WeatherDatasetRecord(
        dataset_id=dataset_id,
        session_id="session_test",
        thread_id="thread_test",
        filename=path.name,
        status="completed",
        storage_relative_path=str(path.resolve()),
        metadata=service.inspect(path),
        created_at=timestamp,
        updated_at=timestamp,
    )


def _build_runtime(
    tmp_path: Path,
    datasets: list[WeatherDatasetRecord],
    *,
    weather_service=None,
    model_registry=None,
) -> ToolRuntime:
    return ToolRuntime(
        context=ToolRuntimeContext(
            run_id="run_test",
            thread_id="thread_test",
            session_id="session_test",
            latest_uploaded_layer_key=None,
            model_provider="fake",
            model_name="fake-model",
        ),
        state=ToolRuntimeState(),
        store=ToolRuntimeStore(
            platform_store=_FakeWeatherPlatformStore(datasets),
            layer_repository=SimpleNamespace(),
            artifact_export_store=SimpleNamespace(),
            spatial_service=SimpleNamespace(),
            runtime_root=tmp_path,
            weather_service=weather_service or WeatherDataService(),
            model_registry=model_registry,
        ),
    )


class _FakeWeatherPlatformStore:
    def __init__(self, datasets: list[WeatherDatasetRecord]):
        self.datasets = {dataset.dataset_id: dataset for dataset in datasets}

    def ensure_weather_dataset_parsed(self, dataset_id: str, weather_service, *, thread_id: str, job_id: str | None = None) -> WeatherDatasetRecord:
        return self.datasets[dataset_id]

    def resolve_runtime_path(self, relative_path: str) -> Path:
        return Path(relative_path)

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
        return ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type=artifact_type,
            name=name,
            uri=f"artifact://{artifact_id}",
            metadata=metadata,
        )


class _FakeModelRegistry:
    def __init__(self, adapter):
        self.adapter = adapter

    def resolve_provider(self, provider: str | None):
        assert provider == "fake"
        return self.adapter


class _FakeModelAdapter:
    provider = "fake"
    default_model = "fake-model"

    def __init__(self):
        self.prompts: list[str] = []

    def is_configured(self) -> bool:
        return True

    async def structured(self, prompt: str, schema: dict[str, object], **kwargs):
        self.prompts.append(prompt)
        assert schema["required"]
        assert kwargs["model"] == "fake-model"
        return {
            "summary": "样例 NC 数据存在明显降水信号。",
            "keyFindings": ["QPF 在样例窗口内有高值区。"],
            "riskSignals": ["需要关注高回波与短时降水的重合区域。"],
            "methodNotes": ["解读基于 metadata 与统计摘要，没有引入外部资料。"],
            "recommendedNextSteps": ["可选择地图候选生成栅格图层。"],
            "reportText": "大模型解读：样例 NC 数据显示 QPF 与 dbz 变量具备地图展示能力，高值区域值得进一步结合阈值区和等值线进行定位。",
        }


class _AnalysisOnlyWeatherService:
    def stats(self, path, *, variable=None, time_index=None, level_index=None, bbox=None):
        return {"variable": variable, "unit": "1", "count": 4, "min": 1.0, "max": 4.0, "mean": 2.5, "median": 2.5, "p90": 3.7}
