# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临工具链测试
#
#   文件:       test_nowcast_tools.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证短临 Provider 工具能通过 valueRef 串联序列、分析、
# 大模型问答和地图候选，不要求模型复制 NC 变量、坐标或时次。

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import xarray as xr

from gis_weather import WeatherDataService
from shared_types.schemas import ArtifactRef, WeatherDatasetRecord
from tool_registry import ToolRuntime, ToolRuntimeContext, ToolRuntimeState, ToolRuntimeStore, build_default_registry


@pytest.mark.asyncio
async def test_nowcast_tool_chain_uses_refs_for_analysis_answer_and_map(tmp_path: Path) -> None:
    registry = build_default_registry()
    datasets = _datasets(tmp_path)
    runtime = _runtime(tmp_path, datasets, model_registry=_FakeModelRegistry(_FakeModelAdapter()))

    created = await registry.execute("create_nowcast_sequence", {"dataset_ids": ["d0", "d1", "d2"]}, runtime)
    sequence_ref = next(ref.ref_id for ref in created.value_refs if ref.kind == "nowcast_sequence")

    inspected = await registry.execute("inspect_nowcast_sequence", {"sequence_ref": sequence_ref}, runtime)
    assert inspected.payload["datasetCount"] == 3
    assert inspected.payload["variable"] == "QPF"

    analyzed = await registry.execute(
        "analyze_nowcast_precipitation",
        {"sequence_ref": sequence_ref, "district_layer_key": "districts", "district_name_field": "district_name"},
        runtime,
    )
    analysis_ref = next(ref.ref_id for ref in analyzed.value_refs if ref.kind == "nowcast_analysis")
    candidate_ref = next(ref.ref_id for ref in analyzed.value_refs if ref.kind == "nowcast_map_candidate")

    answer = await registry.execute("answer_nowcast_question", {"nowcast_analysis_ref": analysis_ref, "question": "接下来天气怎么样？"}, runtime)
    assert answer.payload["forecastTextRef"].startswith("value:")
    assert answer.message == "未来三小时局地降水增强，建议关注东部区。"

    render = await registry.execute("render_nowcast_raster", {"nowcast_map_candidate_ref": candidate_ref}, runtime)
    assert render.artifact is not None
    assert render.artifact.artifact_type == "raster_png"
    assert render.artifact.metadata["source"] == "nowcast"
    assert render.artifact.metadata["datasetId"] in {"d0", "d1", "d2"}


@pytest.mark.asyncio
async def test_nowcast_tools_fail_on_unknown_value_ref(tmp_path: Path) -> None:
    registry = build_default_registry()
    runtime = _runtime(tmp_path, _datasets(tmp_path), model_registry=_FakeModelRegistry(_FakeModelAdapter()))

    with pytest.raises(ValueError, match="工具值引用不存在"):
        await registry.execute("inspect_nowcast_sequence", {"sequence_ref": "value:missing"}, runtime)
    with pytest.raises(ValueError, match="工具值引用不存在"):
        await registry.execute("answer_nowcast_question", {"nowcast_analysis_ref": "value:missing", "question": "接下来天气怎么样？"}, runtime)


@pytest.mark.asyncio
async def test_nowcast_answer_requires_configured_model(tmp_path: Path) -> None:
    registry = build_default_registry()
    runtime = _runtime(tmp_path, _datasets(tmp_path), model_registry=None)
    sequence = await registry.execute("create_nowcast_sequence", {}, runtime)
    sequence_ref = next(ref.ref_id for ref in sequence.value_refs if ref.kind == "nowcast_sequence")
    analyzed = await registry.execute("analyze_nowcast_precipitation", {"sequence_ref": sequence_ref}, runtime)
    analysis_ref = next(ref.ref_id for ref in analyzed.value_refs if ref.kind == "nowcast_analysis")

    with pytest.raises(ValueError, match="模型"):
        await registry.execute("answer_nowcast_question", {"nowcast_analysis_ref": analysis_ref, "question": "接下来天气怎么样？"}, runtime)


def _datasets(tmp_path: Path) -> list[WeatherDatasetRecord]:
    paths = [
        tmp_path / "202604091955_202604092000.nc",
        tmp_path / "202604091955_202604092005.nc",
        tmp_path / "202604091955_202604092010.nc",
    ]
    _write_nc(paths[0], west_value=4.0, east_value=0.0)
    _write_nc(paths[1], west_value=8.0, east_value=3.0)
    _write_nc(paths[2], west_value=1.0, east_value=18.0)
    service = WeatherDataService()
    timestamp = datetime.now(timezone.utc)
    return [
        WeatherDatasetRecord(
            dataset_id=f"d{index}",
            session_id="session_test",
            thread_id="thread_test",
            filename=path.name,
            status="completed",
            storage_relative_path=str(path),
            metadata=service.inspect(path),
            created_at=timestamp,
            updated_at=timestamp,
        )
        for index, path in enumerate(paths)
    ]


def _write_nc(path: Path, *, west_value: float, east_value: float) -> None:
    lat = np.linspace(30.0, 30.19, 20, dtype="float32")
    lon = np.linspace(120.0, 120.19, 20, dtype="float32")
    qpf = np.zeros((20, 20), dtype="float32")
    qpf[6:14, 3:9] = west_value
    qpf[6:14, 12:18] = east_value
    xr.Dataset(
        {"QPF": (("lat", "lon"), qpf, {"units": "mm"}), "dbz": (("lat", "lon"), qpf * 2.0, {"units": "dBZ"})},
        coords={"lat": lat, "lon": lon},
    ).to_netcdf(path)


def _runtime(tmp_path: Path, datasets: list[WeatherDatasetRecord], *, model_registry=None) -> ToolRuntime:
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
            platform_store=_FakePlatformStore(datasets),
            layer_repository=SimpleNamespace(),
            artifact_export_store=SimpleNamespace(),
            spatial_service=_FakeSpatialService(),
            runtime_root=tmp_path,
            weather_service=WeatherDataService(),
            model_registry=model_registry,
        ),
    )


class _FakePlatformStore:
    def __init__(self, datasets: list[WeatherDatasetRecord]):
        self.datasets = {dataset.dataset_id: dataset for dataset in datasets}

    def list_weather_datasets(self, *, session_id: str, thread_id: str):
        assert session_id == "session_test"
        assert thread_id == "thread_test"
        return list(self.datasets.values())

    def ensure_weather_dataset_parsed(self, dataset_id: str, weather_service, *, thread_id: str, job_id: str | None = None):
        return self.datasets[dataset_id]

    def get_weather_dataset(self, dataset_id: str, *, thread_id: str):
        return self.datasets[dataset_id]

    def resolve_runtime_path(self, relative_path: str) -> Path:
        return Path(relative_path)

    def save_file_artifact(self, *, run_id: str, artifact_id: str, artifact_type: str, name: str, source_path: str, suffix: str, metadata: dict[str, object]) -> ArtifactRef:
        return ArtifactRef(
            artifact_id=artifact_id,
            run_id=run_id,
            artifact_type=artifact_type,
            name=name,
            uri=f"artifact://{artifact_id}",
            metadata=metadata,
        )


class _FakeSpatialService:
    def load_layer(self, layer_key: str):
        assert layer_key == "districts"
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"district_name": "西部区"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[120.0, 30.0], [120.1, 30.0], [120.1, 30.2], [120.0, 30.2], [120.0, 30.0]]],
                    },
                },
                {
                    "type": "Feature",
                    "properties": {"district_name": "东部区"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[120.1, 30.0], [120.2, 30.0], [120.2, 30.2], [120.1, 30.2], [120.1, 30.0]]],
                    },
                },
            ],
        }


class _FakeModelRegistry:
    def __init__(self, adapter):
        self.adapter = adapter

    def resolve_provider(self, provider: str | None):
        assert provider == "fake"
        return self.adapter


class _FakeModelAdapter:
    provider = "fake"
    default_model = "fake-model"

    def is_configured(self) -> bool:
        return True

    async def structured(self, prompt: str, schema: dict[str, object], **kwargs):
        assert "facts" in prompt
        assert "draft" in prompt
        assert kwargs["model"] == "fake-model"
        assert schema["required"] == ["answer", "basis", "confidence", "warnings"]
        return {
            "answer": "未来三小时局地降水增强，建议关注东部区。",
            "basis": ["短临 facts 显示东部区峰值较高。"],
            "confidence": 0.86,
            "warnings": [],
        }
