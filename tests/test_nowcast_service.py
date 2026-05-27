# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临降水领域服务测试
#
#   文件:       test_nowcast_service.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：验证短临序列排序、区划统计、趋势诊断和地图候选都来自
# NC 数据与传入边界，不来自硬编码区县或模板答案。

from __future__ import annotations

from pathlib import Path

import numpy as np
import xarray as xr

from gis_weather import NowcastAnalysisService, NowcastSequenceService, WeatherDataService


def test_nowcast_sequence_sorts_files_and_analyzes_district_timelines(tmp_path: Path) -> None:
    # 短临事实计算主路径。
    #
    # 输入顺序故意打乱；服务应按产品时刻排序，并从区划属性读取区域名称。
    files = _write_sequence(tmp_path)
    service = WeatherDataService()
    datasets = [
        {"dataset_id": "d2", "filename": files[2].name, "path": files[2], "metadata": service.inspect(files[2])},
        {"dataset_id": "d0", "filename": files[0].name, "path": files[0], "metadata": service.inspect(files[0])},
        {"dataset_id": "d1", "filename": files[1].name, "path": files[1], "metadata": service.inspect(files[1])},
    ]

    sequence = NowcastSequenceService().create_sequence(sequence_id="seq_test", datasets=datasets)
    facts = NowcastAnalysisService().analyze(sequence, area=_districts(), district_name_field="district_name")

    assert [item.dataset_id for item in sequence.datasets] == ["d0", "d1", "d2"]
    assert sequence.variable == "QPF"
    assert [region["label"] for region in facts["regions"]] == ["西部区", "东部区"]
    assert facts["regions"][0]["diagnosis"]["hasRain"] is True
    assert facts["regions"][1]["diagnosis"]["hasRain"] is True
    assert any("降雨峰值时次" in candidate["reason"] for candidate in facts["mapCandidates"])
    assert facts["movement"]["available"] is True


def test_nowcast_point_analysis_reports_no_rain_when_buffer_has_no_signal(tmp_path: Path) -> None:
    files = _write_sequence(tmp_path)
    service = WeatherDataService()
    datasets = [{"dataset_id": f"d{index}", "filename": path.name, "path": path, "metadata": service.inspect(path)} for index, path in enumerate(files)]
    sequence = NowcastSequenceService().create_sequence(sequence_id="seq_point", datasets=datasets)

    facts = NowcastAnalysisService().analyze(
        sequence,
        coordinate={"lat": 30.18, "lng": 120.01, "label": "测试点"},
        point_buffer_meters=500,
    )

    assert facts["scope"]["type"] == "coordinate_buffer"
    assert facts["regions"][0]["label"] == "测试点"
    assert facts["regions"][0]["diagnosis"]["hasRain"] is False


def _write_sequence(tmp_path: Path) -> list[Path]:
    paths = [
        tmp_path / "202604091955_202604092000.nc",
        tmp_path / "202604091955_202604092005.nc",
        tmp_path / "202604091955_202604092010.nc",
    ]
    _write_nowcast_nc(paths[0], west_value=4.0, east_value=0.0)
    _write_nowcast_nc(paths[1], west_value=8.0, east_value=3.0)
    _write_nowcast_nc(paths[2], west_value=1.0, east_value=18.0)
    return paths


def _write_nowcast_nc(path: Path, *, west_value: float, east_value: float) -> None:
    lat = np.linspace(30.0, 30.19, 20, dtype="float32")
    lon = np.linspace(120.0, 120.19, 20, dtype="float32")
    qpf = np.zeros((20, 20), dtype="float32")
    qpf[6:14, 3:9] = west_value
    qpf[6:14, 12:18] = east_value
    dbz = qpf * 2.0
    ds = xr.Dataset(
        {
            "QPF": (("lat", "lon"), qpf, {"units": "mm", "long_name": "Quantitative Precipitation Forecast"}),
            "dbz": (("lat", "lon"), dbz, {"units": "dBZ"}),
        },
        coords={"lat": lat, "lon": lon},
    )
    ds.to_netcdf(path)


def _districts() -> dict[str, object]:
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
